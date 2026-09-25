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
import { detectBinaries, systemTools, formatDetection, CATALOGUE } from "./src/slices/discovery/index.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "./src/shared/types.js";
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

	// What the machine actually has, probed once per load. needle3 may name any
	// of these; the plan renderer turns a binary into a runnable bash command.
	const detected = detectBinaries();
	const extras: ToolSpec[] = [...systemTools(detected), ...readUserTools()];

	/** The one function the hook and the commands both call. */
	const planFor = async (prompt: string): Promise<HookPlan | null> => {
		const resolution = await getEngine(state, extras);
		if (!resolution.ok) return null;
		const result = await planPrompt(state, {
			prompt,
			engine: resolution.engine,
			tools: extras,
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
		toolReport: () => {
			const found = new Set(detected.map((d) => d.binary));
			const missing = CATALOGUE.map((c) => c.binary).filter((b) => !found.has(b));
			const lines = [
				`needle3 can name ${detected.length + extras.length - extras.filter((e) => e.source === "user").length} tools on this machine:`,
				"",
				formatDetection(detected, missing),
			];
			const userTools = extras.filter((e) => e.source === "user");
			if (userTools.length > 0) {
				lines.push("", "from ~/.pi/agent/pi-tiny-boss.tools.json:");
				userTools.forEach((t) => lines.push(`  ${t.name.padEnd(12)} ${t.description}`));
			}
			return lines.join("\n");
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
		describeTools: () => describeManifest(extras),
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

/**
 * Extra tools from `~/.pi/agent/pi-tiny-boss.tools.json`.
 *
 * Shape: `{ "tools": [{ "name": "...", "description": "..." }] }`. Malformed or
 * missing file yields an empty list — a bad config must not break the hook.
 */
function readUserTools(): ToolSpec[] {
	try {
		const raw = readFileSync(join(homedir(), ".pi", "agent", "pi-tiny-boss.tools.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		const list =
			parsed && typeof parsed === "object" && Array.isArray((parsed as { tools?: unknown }).tools)
				? ((parsed as { tools: unknown[] }).tools)
				: [];
		return list
			.filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
			.map((t) => ({
				name: String(t.name ?? "").trim(),
				description: String(t.description ?? "").trim(),
				invokedAs: typeof t.invokedAs === "string" ? t.invokedAs : "bash",
				example: typeof t.example === "string" ? t.example : undefined,
				source: "user" as const,
			}))
			.filter((t) => t.name.length > 0 && t.description.length > 0);
	} catch {
		return [];
	}
}
