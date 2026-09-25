/**
 * The contract between the tiny model and the engine.
 *
 * Lives in `shared/` because two slices need it: the planner renders the schema
 * it validates against, and the engine passes it to `needle_init`. Slices must
 * not import each other, so the shared piece goes here.
 *
 * The shape is deliberately flat. An earlier version asked for
 * `{steps: [{tool, args, why}]}` with free text, and needle3 reliably answered
 * `{"steps": []}` — the free-text `why` field is where a 2-bit model falls
 * apart. A bare array of tool names is the only schema it has been observed to
 * answer usefully, so arguments and rationale are dropped. The big model
 * supplies the arguments; the tiny model only names the tools.
 */

import type { ToolSpec } from "./types.js";

/** The single tool the tiny model is allowed to call. */
export const PLAN_TOOL_NAME = "emit_plan";

/** System prompt for the engine. Short on purpose — needle3 has 121M parameters. */
export const PLAN_SYSTEM_PROMPT = [
	"You are a tool planner. Read the request and list the tools to use, in order.",
	`Call ${PLAN_TOOL_NAME} exactly once.`,
	"Use 'none' if no tool is needed. Only use tools from the list.",
].join(" ");

/** JSON-schema manifest handed to `_needle_init`. */
export function buildToolsJson(tools: ToolSpec[]): string {
	return JSON.stringify([
		{
			name: PLAN_TOOL_NAME,
			description: "Pick the tools to use, in order.",
			parameters: {
				type: "object",
				properties: {
					tools: {
						type: "array",
						maxItems: 6,
						items: { type: "string", enum: tools.map((t) => t.name) },
					},
				},
				required: ["tools"],
			},
		},
	]);
}
