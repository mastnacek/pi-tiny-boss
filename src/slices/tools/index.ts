/**
 * Tools slice for pi-tiny-boss.
 *
 * One tool: let the coding model ask the tiny boss mid-turn, when the `input`
 * hook has already passed. Imports only `shared/`, so the planner arrives
 * injected from the composition root.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { TinyBossState } from "../../shared/types.js";

/** What the caller wants back. */
const ModeSchema = StringEnum(["plan", "tools"] as const);

export interface ToolDeps {
	/** Run the tiny model against a prompt and return the rendered plan. */
	dryRunPlan: (prompt: string) => Promise<string | null>;
	/** Render the buckets and tools the tiny model is allowed to name. */
	describeTools: () => string;
}

export function registerTools(pi: ExtensionAPI, state: TinyBossState, deps: ToolDeps): void {
	pi.registerTool({
		name: "tiny_boss",
		label: "Tiny Boss",
		description:
			"Ask the local Laya decision model which tools a request needs, or list the decision buckets it may choose from. Offline and free, but it never reads files — treat the answer as a hint.",
		promptSnippet: "tiny_boss(mode, prompt) — cheap local tool planning via Laya",
		parameters: Type.Object({
			mode: ModeSchema,
			prompt: Type.Optional(Type.String({ description: "The request to plan. Required for mode=plan." })),
		}),
		async execute(_toolCallId, params) {
			if (params.mode === "tools") {
				return { content: [{ type: "text" as const, text: deps.describeTools() }], details: {} };
			}

			const prompt = (params.prompt ?? "").trim();
			if (!prompt) {
				// Rule 4 of the tools API: a failed call is a thrown error.
				throw new Error("mode=plan requires a non-empty prompt");
			}
			if (!state.enabled) {
				throw new Error("tiny-boss is disabled — run /tiny-boss on first");
			}

			const rendered = await deps.dryRunPlan(prompt);
			if (!rendered) {
				throw new Error(
					"Laya produced no usable plan. Run /tiny-boss fetch if the ONNX bundle is missing, or /tiny-boss status to see why.",
				);
			}
			return { content: [{ type: "text" as const, text: rendered }], details: {} };
		},
	});
}
