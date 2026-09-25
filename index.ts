/**
 * pi-tiny-boss — a 121M-parameter model picks your tools before the big one does.
 *
 * Composition root only. This is the ONE place allowed to import more than one
 * slice, so it owns the wiring: engine → planner → hook, and engine → commands.
 * Everything below it receives its dependencies through function arguments.
 *
 * Flow, once per user prompt:
 *
 *   input event → shouldPlan gate → getEngine → planPrompt → transform
 *
 * Every arrow has a failure branch that returns the prompt untouched. A broken
 * tiny model is invisible, not fatal.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInitialState } from "./src/shared/state.js";
import { getEngine, releaseEngine, downloadAsset, assetStatus, assetsReady, ASSETS, assetPath } from "./src/slices/engine/index.js";
import { planPrompt, describeManifest } from "./src/slices/planner/index.js";
import { registerInputHook, drainInputHook, type HookPlan } from "./src/slices/hook/index.js";
import { registerCommands } from "./src/slices/commands/index.js";
import { registerTools } from "./src/slices/tools/index.js";

/** Planning budget. Exceeding it means we pass the prompt through untouched. */
const PLAN_TIMEOUT_MS = 4000;

/** Subagent recursion guard: never plan inside a delegated child session. */
function isDelegatedSession(): boolean {
	return process.env.PI_SUBAGENT === "true" || Boolean(process.env.PI_CHILD_SESSION);
}

export default function (pi: ExtensionAPI): void {
	if (isDelegatedSession()) {
		return;
	}

	const state = createInitialState();
	const unsubscribers: Array<() => void> = [];
	const track = (result: unknown): void => {
		if (typeof result === "function") unsubscribers.push(result as () => void);
	};

	/** The one function the hook and the commands both call. */
	const planFor = async (prompt: string): Promise<HookPlan | null> => {
		const resolution = await getEngine(state);
		if (!resolution.ok) return null;
		const result = await planPrompt(state, {
			prompt,
			engine: resolution.engine,
			timeoutMs: PLAN_TIMEOUT_MS,
		});
		if (!result) return null;
		return { text: result.text, stepCount: result.steps.length, elapsedMs: result.elapsedMs };
	};

	// Wire slices: dependencies flow inward, never sideways.
	track(registerInputHook(pi, state, { plan: (_state, prompt) => planFor(prompt) }));

	registerCommands(pi, state, {
		fetchAssets: async (onProgress) => {
			const lines: string[] = [];
			for (const asset of ASSETS) {
				const dest = assetPath(asset.file);
				onProgress(`${asset.name}: cached or downloading`);
				if (!(await fileExists(dest))) {
					await downloadAsset(asset.url, dest);
				}
				lines.push(`${asset.name} ok`);
			}
			return `needle3 assets ready in the cache:\n${lines.map((l) => `  ${l}`).join("\n")}`;
		},
		assetReport: async () => {
			const status = await assetStatus();
			return status
				.map((s) => `${s.name}=${s.present ? `${Math.round(s.bytes / 1024)} KB` : "missing"}`)
				.join(" ");
		},
		dryRunPlan: async (prompt) => {
			const result = await planFor(prompt);
			if (!result) {
				const ready = await assetsReady();
				return ready ? "no usable plan produced" : null;
			}
			return result.text;
		},
	});

	registerTools(pi, state, {
		dryRunPlan: async (prompt) => {
			const result = await planFor(prompt);
			return result ? result.text : null;
		},
		describeTools: () => describeManifest(),
	});

	// Drain listeners and free the WASM instance on shutdown.
	pi.on("session_shutdown", async () => {
		drainInputHook();
		while (unsubscribers.length > 0) {
			unsubscribers.pop()?.();
		}
		await releaseEngine(state);
	});
}

/** Tiny existence check so the fetch path can skip what is already cached. */
async function fileExists(path: string): Promise<boolean> {
	try {
		const { access } = await import("node:fs/promises");
		const { constants } = await import("node:fs");
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}
