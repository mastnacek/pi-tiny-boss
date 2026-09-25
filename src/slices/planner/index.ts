/**
 * Public boundary of the `planner` slice.
 *
 * Owns the timing and the engine seam. Consumers get either a rendered
 * directive string or null — never a thrown error and never a half-plan.
 */

import type { TinyBossState, TinyEngine, PlanStep, ToolSpec } from "../../shared/types.js";
import { manifestTools } from "../../shared/manifest.js";
import { buildToolsJson, parsePlan, renderDirective, PLAN_SYSTEM_PROMPT } from "./plan.js";

export { parsePlan, renderDirective, buildToolsJson, PLAN_SYSTEM_PROMPT } from "./plan.js";

/** Everything the planner needs, injected so tests can supply a fake engine. */
export interface PlanRequest {
	/** The user's raw prompt. */
	prompt: string;
	/** Engine to ask. Omit to reuse the one cached on state. */
	engine?: TinyEngine;
	/** Extra manifest entries: detected system binaries plus user tools. */
	tools?: ToolSpec[];
	/** Milliseconds after which we give up and let the prompt through untouched. */
	timeoutMs?: number;
}

/** Raise if the plan takes longer than the budget. */
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

/**
 * Ask the tiny model for a plan and render it into a prompt directive.
 *
 * Returns null for every failure path. The caller treats null as "pass the
 * original prompt through" — a broken tiny model must never break the session.
 */
export async function planPrompt(
	state: TinyBossState,
	request: PlanRequest,
): Promise<{ text: string; steps: PlanStep[]; elapsedMs: number } | null> {
	const engine = request.engine ?? state.engine;
	if (!engine) return null;

	const tools = manifestTools(request.tools ?? []);
	const started = Date.now();
	const timeoutMs = request.timeoutMs ?? 4000;

	let raw: string;
	let steps: PlanStep[];
	try {
		const result = await withTimeout(engine.plan(request.prompt, tools), timeoutMs);
		raw = result.raw;
		steps = parsePlan(result.raw, tools);
	} catch {
		return null;
	}

	if (steps.length === 0) return null;

	const elapsedMs = Date.now() - started;
	state.lastPlan = { steps, raw, elapsedMs };
	state.lastRunTimestamp = Date.now();
	state.planCount += 1;
	state.degraded = null;
	state.lastError = null;

	return { text: renderDirective(steps, request.prompt), steps, elapsedMs };
}

/** Exposed for the command layer, which pre-renders the manifest for display. */
export function describeManifest(tools: ToolSpec[] = []): string {
	return JSON.stringify(
		manifestTools(tools).map((t) => ({ name: t.name, description: t.description, source: t.source })),
		null,
		2,
	);
}

/** Exposed for tests and the status command. */
export { PLAN_SYSTEM_PROMPT as systemPrompt };
export { buildToolsJson as toolsJsonFor };
