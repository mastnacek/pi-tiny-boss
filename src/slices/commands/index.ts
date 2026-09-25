/**
 * Commands slice for pi-tiny-boss.
 *
 * Owns `/tiny-boss` and its argument completions. Talks to the engine and
 * planner through injected functions supplied by the composition root, so this
 * slice imports nothing but `shared/`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TinyBossState } from "../../shared/types.js";
import { recordFailure } from "../../shared/state.js";

/** Subcommands. Terminal rows take no trailing space; `plan` continues. */
const TERMINAL_MODES = ["on", "off", "status", "fetch", "tools"] as const;
const ARGUMENT_MODES = ["plan"] as const;
type Mode = (typeof TERMINAL_MODES)[number] | (typeof ARGUMENT_MODES)[number];

/** The live state marker pi-klid-style completions expect on toggles. */
export function modeLabel(mode: Mode, state: TinyBossState): string {
	if (mode === "on" && state.enabled) return `${mode} ✓`;
	if (mode === "off" && !state.enabled) return `${mode} ✓`;
	return mode;
}

/** Everything the command handler needs, injected by the composition root. */
export interface CommandDeps {
	/** Download the needle3 assets into the cache. */
	fetchAssets: (onProgress: (stage: string) => void) => Promise<string>;
	/** Ask the tiny model for a plan without touching any prompt. */
	dryRunPlan: (prompt: string) => Promise<string | null>;
	/** Report whether assets are cached, for the status line. */
	assetReport: () => Promise<string>;
	/** List the system binaries needle3 is allowed to name on this machine. */
	toolReport: () => string;
}

function isMode(value: string): value is Mode {
	return (TERMINAL_MODES as readonly string[]).includes(value) || (ARGUMENT_MODES as readonly string[]).includes(value);
}

export function registerCommands(
	pi: ExtensionAPI,
	state: TinyBossState,
	deps: CommandDeps,
): void {
	pi.registerCommand("tiny-boss", {
		description:
			"needle3 (121M, local) plans your tool calls before the big model runs: on, off, status, tools, fetch, plan <prompt>",
		handler: async (args: string, ctx: ExtensionContext) => {
			const [head = "", ...rest] = args.trim().split(/\s+/);
			const mode = head.toLowerCase();

			if (mode === "on" || mode === "off") {
				state.enabled = mode === "on";
				state.degraded = null;
				state.lastError = null;
				ctx.ui.notify?.(`tiny-boss ${mode}`);
				return;
			}

			if (mode === "status") {
				const assets = await deps.assetReport();
				const lines = [
					`enabled:    ${state.enabled}`,
					`degraded:   ${state.degraded ?? "no"}`,
					`plans made: ${state.planCount}`,
					`last run:   ${state.lastRunTimestamp ? new Date(state.lastRunTimestamp).toLocaleTimeString() : "never"}`,
					`last error: ${state.lastError ?? "none"}`,
					`assets:     ${assets}`,
				];
				if (state.lastPlan) {
					lines.push("last plan:");
					for (const [i, step] of state.lastPlan.steps.entries()) {
						lines.push(`  ${i + 1}. ${step.tool} ${JSON.stringify(step.args)}${step.why ? ` — ${step.why}` : ""}`);
					}
				}
				ctx.ui.notify?.(lines.join("\n"));
				return;
			}

			if (mode === "fetch") {
				try {
					const summary = await deps.fetchAssets((stage) => ctx.ui.notify?.(`tiny-boss: ${stage}`));
					state.degraded = null;
					state.lastError = null;
					ctx.ui.notify?.(summary);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					recordFailure(state, "assets-missing", message);
					ctx.ui.notify?.(`tiny-boss: fetch failed — ${message}`);
				}
				return;
			}

			if (mode === "tools") {
				ctx.ui.notify?.(deps.toolReport());
				return;
			}

			if (mode === "plan") {
				const prompt = rest.join(" ").trim();
				if (!prompt) {
					ctx.ui.notify?.("usage: /tiny-boss plan <prompt>");
					return;
				}
				const rendered = await deps.dryRunPlan(prompt);
				ctx.ui.notify?.(rendered ?? "tiny-boss: no plan produced");
				return;
			}

			if (mode === "" || isMode(mode)) {
				ctx.ui.notify?.(
					[
						"tiny-boss — needle3 plans, the big model obeys (or politely ignores)",
						"",
						"on      enable planning on every prompt",
						"off     disable, pass prompts through untouched",
						"status  show engine state, asset cache and the last plan",
						"tools   list the system binaries needle3 may name here",
						"fetch   download the ~36 MB needle3 assets (once)",
						"plan    dry-run a prompt and show the plan, changing nothing",
					].join("\n"),
				);
				return;
			}

			ctx.ui.notify?.(`unknown subcommand: ${head} — try /tiny-boss status`);
		},
		getArgumentCompletions: (prefix: string) => {
			const partial = prefix.trim();
			// First level: every mode, with the live state marker on the toggles.
			if (!/\s/.test(partial)) {
				return [...TERMINAL_MODES, ...ARGUMENT_MODES]
					.filter((mode) => mode.startsWith(partial))
					.map((mode) => {
						const value = mode === "plan" ? "plan " : mode;
						return {
							value: `tiny-boss ${value}`,
							label: modeLabel(mode, state),
						};
					});
			}
			// Second level: `plan` takes free text, so it expands to nothing.
			return [];
		},
	});
}
