/**
 * The hook: Laya plans, then the frontier model is handed the plan.
 *
 * This slice owns no engine and no schema. It receives a `plan` function from
 * the composition root, which is what keeps slices independent.
 *
 * The rules are strict, because this is the only code on the prompt's hot path:
 *
 *   1. Never throw. A broken tiny model must not break the session.
 *   2. Never block past the budget. The two Laya passes are timed by the planner;
 *      the one-time ONNX session load is not, and is reported separately.
 *   3. Never retry a latched failure. Missing assets cost one failed call, not
 *      one per turn.
 *   4. Never plan a slash command or a trivial message — a short prompt gets a
 *      confident answer out of any small model, and that answer is noise.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import type { TinyBossState } from "../../shared/types.js";

/** Prompts shorter than this are answered without a plan. */
export const MIN_PROMPT_CHARS = 24;

/** What the injected planner returns. */
export interface HookPlan {
	/** The rewritten prompt: directive block plus the original text. */
	text: string;
	/** How many steps the tiny model proposed. */
	stepCount: number;
	/** Wall-clock cost of both passes, surfaced in the TUI notification. */
	elapsedMs: number;
}

/** The seam the composition root fills in. */
export type PlanFn = (state: TinyBossState, prompt: string) => Promise<HookPlan | null>;

export interface HookOptions {
	/** Injected planner. Wired in index.ts for real, faked in tests. */
	plan: PlanFn;
}

/** Subscriptions owned by this slice, drained by the composition root. */
const subscriptions: Array<() => void> = [];

/** Cheap gate: is this prompt worth spending a model call on? */
export function shouldPlan(prompt: string): boolean {
	const trimmed = prompt.trim();
	if (trimmed.length < MIN_PROMPT_CHARS) return false;
	if (trimmed.startsWith("/")) return false;
	return true;
}

/** Register the `input` listener. Returns the unsubscribe function. */
export function registerInputHook(
	pi: ExtensionAPI,
	state: TinyBossState,
	options: HookOptions,
): () => void {
	// pi.on() started returning an unsubscribe function in 0.86.0. The workspace
	// root still pins the engine at 0.85.1, where the type is void, so the value
	// is taken defensively: on 0.87 it is a function we must drain, on 0.85 there
	// is nothing to drain and dropping it is correct.
	const unsubscribe = pi.on(
		"input",
		async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> => {
		// Rule 1, outermost: nothing escapes this handler.
		try {
			if (!state.enabled) return { action: "continue" } as const;
			// Rule 3: a latched failure stays latched until /tiny-boss fetch.
			if (state.degraded === "assets-missing" || state.degraded === "engine-error") {
				return { action: "continue" } as const;
			}
			// Never re-plan our own injected prompts.
			if (event.source === "extension") return { action: "continue" } as const;
			if (!shouldPlan(event.text)) return { action: "continue" } as const;

			const plan = await options.plan(state, event.text);
			if (!plan) return { action: "continue" } as const;

			if (ctx.hasUI) {
				ctx.ui.notify(
					`tiny-boss: ${plan.stepCount} step plan from Laya (${plan.elapsedMs}ms)`,
				);
			}
			return { action: "transform", text: plan.text } as const;
		} catch {
			// Rule 1: the user's prompt is the source of truth. Never let ours win.
			return { action: "continue" } as const;
		}
		},
	);

	if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	return typeof unsubscribe === "function" ? unsubscribe : () => {};
}

/** Drain every subscription this slice holds. Safe to call more than once. */
export function drainInputHook(): void {
	while (subscriptions.length > 0) {
		subscriptions.pop()?.();
	}
}
