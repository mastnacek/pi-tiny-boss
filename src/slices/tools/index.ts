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
	/** Render the tool manifest the tiny model is allowed to name. */
	describeTools: () => string;
}

export function registerTools(pi: ExtensionAPI, state: TinyBossState, deps: ToolDeps): void {
	pi.registerTool({
		name: "tiny_boss",
		label: "Tiny Boss",
		description:
			"Ask the local 121M needle3 model which tools to use for a request, or list the tools it may name. Free and offline, but small — treat the answer as a hint.",
		promptSnippet: "tiny_boss(mode, prompt) — cheap local tool planning via needle3",
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
					"needle3 produced no usable plan. Run /tiny-boss fetch if the assets are missing, or /tiny-boss status to see why.",
				);
			}
			return { content: [{ type: "text" as const, text: rendered }], details: {} };
		},
	});
}
