/**
 * Plan validation and rendering.
 *
 * Pure functions only: no WASM, no UI, no pi imports. Everything here is
 * exercised directly by the test suite with hand-written engine output.
 */

import { PLAN_SYSTEM_PROMPT, PLAN_TOOL_NAME, buildToolsJson } from "../../shared/plan-schema.js";
import type { PlanStep, ToolSpec } from "../../shared/types.js";

// The schema itself lives in shared/ (the engine needs it for needle_init);
// re-exported here so planner consumers have one import site.
export { PLAN_SYSTEM_PROMPT, PLAN_TOOL_NAME, buildToolsJson };

/** Coerce one engine-supplied step, dropping anything malformed. */
function coerceStep(input: unknown, allowed: Set<string>): PlanStep | null {
	if (!input || typeof input !== "object") return null;
	const raw = input as Record<string, unknown>;
	const tool = typeof raw.tool === "string" ? raw.tool.trim() : "";
	if (!tool || !allowed.has(tool)) return null;
	const args =
		raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)
			? (raw.args as Record<string, unknown>)
			: {};
	const why = typeof raw.why === "string" ? raw.why.trim() : "";
	return { tool, args, why: why.slice(0, 240) };
}

/**
 * Parse the engine's JSON into a plan.
 *
 * Returns an empty array for every unusable shape rather than throwing: a 121M
 * model produces junk regularly, and junk must degrade to "no plan", never to
 * an exception inside the input hook.
 */
export function parsePlan(raw: string, tools: ToolSpec[]): PlanStep[] {
	const allowed = new Set(tools.map((t) => t.name));
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object") return [];

	const container = parsed as Record<string, unknown>;
	const calls = Array.isArray(container.function_calls)
		? (container.function_calls as unknown[])
		: Array.isArray(container.calls)
			? (container.calls as unknown[])
			: [];

	for (const call of calls) {
		if (!call || typeof call !== "object") continue;
		const args = (call as Record<string, unknown>).arguments;
		if (!args || typeof args !== "object") continue;
		const steps = (args as Record<string, unknown>).steps;
		if (!Array.isArray(steps)) continue;

		const coerced = steps
			.map((s) => coerceStep(s, allowed))
			.filter((s): s is PlanStep => s !== null);
		if (coerced.length > 0) return coerced.slice(0, 6);
	}
	return [];
}

/** Render one step as a compact, model-readable line. */
function renderStep(step: PlanStep, index: number): string {
	const args = Object.keys(step.args).length > 0 ? ` ${JSON.stringify(step.args)}` : "";
	const why = step.why.length > 0 ? ` — ${step.why}` : "";
	return `${index + 1}. ${step.tool}${args}${why}`;
}

/**
 * Build the block appended to the user's prompt.
 *
 * The wording matters: the tiny model is advisory, not authoritative. A 121M
 * model will be wrong, and the coding model must be able to overrule it.
 */
export function renderDirective(plan: PlanStep[], userPrompt: string): string {
	const lines = plan.map(renderStep);
	return [
		"",
		"<tiny-boss-plan>",
		"A 121M local model (needle3) planned this before you woke up. It costs nothing",
		"and runs offline, but it is small and it is sometimes wrong.",
		"",
		...lines,
		"",
		"Use this plan as a strong hint, not an order. If a step is wrong or the work needs",
		"a different approach, deviate and say why in one sentence.",
		"</tiny-boss-plan>",
		"",
		userPrompt,
	].join("\n");
}
