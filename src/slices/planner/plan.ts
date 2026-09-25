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

/** Coerce one tool name from the engine reply into a renderable step. */
function coerceStep(name: unknown, specs: Map<string, ToolSpec>): PlanStep | null {
	if (typeof name !== "string") return null;
	const tool = name.trim();
	const spec = specs.get(tool);
	if (!spec) return null;
	return { tool, args: {}, why: "", invokedAs: spec.invokedAs, example: spec.example };
}

/**
 * Parse the engine's JSON into a plan.
 *
 * `suppressed_calls` is checked alongside `function_calls`: needle3 routes
 * schema-valid calls to the former, so reading only the latter reports "no plan"
 * for output that is actually there.
 *
 * Returns an empty array for every unusable shape rather than throwing: a 121M
 * model produces junk regularly, and junk must degrade to "no plan", never to
 * an exception inside the input hook.
 */
export function parsePlan(raw: string, tools: ToolSpec[]): PlanStep[] {
	const specs = new Map(tools.map((t) => [t.name, t]));
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object") return [];

	const container = parsed as Record<string, unknown>;
	const calls = [
		...(Array.isArray(container.function_calls) ? (container.function_calls as unknown[]) : []),
		...(Array.isArray(container.suppressed_calls) ? (container.suppressed_calls as unknown[]) : []),
	];

	for (const call of calls) {
		if (!call || typeof call !== "object") continue;
		const args = (call as Record<string, unknown>).arguments;
		if (!args || typeof args !== "object") continue;
		const tools_ = (args as Record<string, unknown>).tools;
		if (!Array.isArray(tools_)) continue;

		const coerced = tools_
			.map((t) => coerceStep(t, specs))
			.filter((s): s is PlanStep => s !== null);
		if (coerced.length > 0) return coerced.slice(0, 6);
	}
	return [];
}

/**
 * Render one step as a compact, model-readable line.
 *
 * A detected binary is named by the tiny model (`rg`) but must be run through
 * `bash`, so the line shows the real invocation and names the binary it came
 * from. A plan the model cannot execute is worse than no plan.
 */
function renderStep(step: PlanStep, index: number): string {
	const why = step.why.length > 0 ? ` — ${step.why}` : "";
	if (step.invokedAs === "bash" && step.example) {
		const command = JSON.stringify({ command: step.example });
		return `${index + 1}. bash ${command} (via ${step.tool})${why}`;
	}
	const args = Object.keys(step.args).length > 0 ? ` ${JSON.stringify(step.args)}` : "";
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
		"A 121M local model (needle3) picked these tools before you woke up. It costs",
		"nothing and runs offline, but it is small and it is frequently wrong.",
		"",
		...lines,
		"",
		"Use this as a weak hint, not an order. If a tool is wrong or the work needs",
		"a different approach, ignore it and say why in one sentence.",
		"</tiny-boss-plan>",
		"",
		userPrompt,
	].join("\n");
}
