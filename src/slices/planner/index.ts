/**
 * Public boundary of the `planner` slice.
 *
 * Owns the timing, the two-pass policy and the engine seam. Consumers get either
 * a rendered directive string or null — never a thrown error and never a half-plan.
 */

import {
	FORWARD_PASSES,
	groupTools,
	stageOneQuestions,
	stageTwoQuestions,
	type ToolGroup,
} from "../../shared/decision-schema.js";
import { manifestTools } from "../../shared/manifest.js";
import type { PlanStep, TinyBossState, TinyEngine, ToolSpec } from "../../shared/types.js";
import {
	assembleSteps,
	gateOutcome,
	MIN_GATE_PROBABILITY,
	MIN_TOOL_PROBABILITY,
	renderDirective,
	type GateOutcome,
} from "./plan.js";

export {
	assembleSteps,
	gateOutcome,
	renderDirective,
	MIN_GATE_PROBABILITY,
	MIN_TOOL_PROBABILITY,
	type DirectiveMeta,
	type GateOutcome,
	type GateResult,
} from "./plan.js";

/** Everything the planner needs, injected so tests can supply a fake engine. */
export interface PlanRequest {
	/** The user's raw prompt, which is also Laya's `state`. */
	prompt: string;
	/** Engine to ask. Omit to reuse the one cached on state. */
	engine?: TinyEngine;
	/** Extra manifest entries: detected system binaries plus user tools. */
	tools?: ToolSpec[];
	/**
	 * Milliseconds budget for BOTH passes combined.
	 *
	 * One budget rather than one per pass, because a plan is only useful as a
	 * whole: a fast first pass that leaves no time for the second produces
	 * nothing, and charging each pass separately would let a slow engine
	 * overshoot the hook's latency budget by 2x.
	 */
	timeoutMs?: number;
}

/** Raise if the work takes longer than the budget. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`planning exceeded ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([work, guard]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** What both passes produced, before rendering. */
interface DecisionRun {
	stages: [GateOutcome, ToolGroup[]];
	steps: PlanStep[];
	raw: string;
}

/**
 * Run both passes against one engine and assemble the steps.
 *
 * Kept separate from `planPrompt` so the policy is readable on its own and the
 * timeout wraps exactly one object.
 */
async function decide(
	engine: TinyEngine,
	prompt: string,
	groups: ToolGroup[],
): Promise<DecisionRun> {
	const first = await engine.ask(prompt, stageOneQuestions(groups));
	const outcome = gateOutcome(groups, first);
	if (outcome.order.length === 0) {
		return { stages: [outcome, groups], steps: [], raw: JSON.stringify({ first }) };
	}

	const second = await engine.ask(prompt, stageTwoQuestions(groups, outcome.order));
	return {
		stages: [outcome, groups],
		steps: assembleSteps(groups, outcome.order, second),
		raw: JSON.stringify({ first, second }),
	};
}

/**
 * Ask the tiny model for a plan and render it into a prompt directive.
 *
 * Returns null for every failure path. The caller treats null as "pass the
 * original prompt through" — a broken tiny model must never break the session.
 */
export async function planPrompt(
	state: TinyBossState,
	request: PlanRequest,
): Promise<{ text: string; steps: PlanStep[]; elapsedMs: number; outcome: GateOutcome } | null> {
	const engine = request.engine ?? state.engine;
	if (!engine) return null;

	const tools = manifestTools(request.tools ?? []);
	const groups = groupTools(tools);
	if (groups.length === 0) return null;

	const started = Date.now();
	const timeoutMs = request.timeoutMs ?? 4000;

	let run: DecisionRun;
	try {
		run = await withTimeout(decide(engine, request.prompt, groups), timeoutMs);
	} catch {
		return null;
	}

	if (run.steps.length === 0) return null;

	const elapsedMs = Date.now() - started;
	state.lastPlan = { steps: run.steps, raw: run.raw, elapsedMs };
	state.lastRunTimestamp = Date.now();
	state.planCount += 1;
	state.degraded = null;
	state.lastError = null;

	const [outcome] = run.stages;
	const requested = outcome.order.length;
	const text = renderDirective(run.steps, request.prompt, { elapsedMs, requested });

	return { text, steps: run.steps, elapsedMs, outcome };
}

/** Exposed for the command layer, which pre-renders the manifest for display. */
export function describeManifest(tools: ToolSpec[] = []): string {
	const groups = groupTools(manifestTools(tools));
	return JSON.stringify(
		groups.map((group) => ({
			category: group.category,
			question: group.meta.blurb,
			tools: group.tools.map((t) => ({ name: t.name, short: t.short, source: t.source })),
		})),
		null,
		2,
	);
}

/** One line per bucket, for `/tiny-boss tools`. */
export function formatGroups(tools: ToolSpec[] = []): string {
	const groups = groupTools(manifestTools(tools));
	return groups
		.map((group) => `${group.category.padEnd(8)} (${group.tools.length}) ${group.tools.map((t) => t.name).join(", ")}`)
		.join("\n");
}
