/**
 * The contract between the tiny model and the engine.
 *
 * Lives in `shared/` because two slices need it: the planner renders the schema
 * it validates against, and the engine passes it to `needle_init`. Slices must
 * not import each other, so the shared piece goes here.
 */

import type { ToolSpec } from "./types.js";

/** The single tool the tiny model is allowed to call. */
export const PLAN_TOOL_NAME = "emit_plan";

/** System prompt for the engine. Short on purpose — needle3 has 121M parameters. */
export const PLAN_SYSTEM_PROMPT = [
	"You are a tool planner for a coding agent.",
	"Read the request and choose the smallest ordered sequence of tool calls that answers it.",
	`Call ${PLAN_TOOL_NAME} exactly once. Give each step one tool, its arguments, and a short reason.`,
	"Prefer fewer steps. If no tool is needed, use the tool 'none' with one step.",
	"Never invent a tool that is not in the list you were given.",
].join(" ");

/** JSON-schema manifest handed to `_needle_init`. */
export function buildToolsJson(tools: ToolSpec[]): string {
	return JSON.stringify([
		{
			name: PLAN_TOOL_NAME,
			description: "Emit the ordered tool plan for the request.",
			parameters: {
				type: "object",
				properties: {
					steps: {
						type: "array",
						minItems: 1,
						maxItems: 6,
						items: {
							type: "object",
							properties: {
								tool: { type: "string", enum: tools.map((t) => t.name) },
								args: { type: "object" },
								why: { type: "string" },
							},
							required: ["tool", "why"],
						},
					},
				},
				required: ["steps"],
			},
		},
	]);
}
