/**
 * pi-tiny-boss — a local System One decision model picks your tools before the big one does.
 *
 * Composition root only. This is the ONE place allowed to import more than one
 * slice, so it owns the wiring: engine → planner → hook, and engine → commands.
 * Everything below it receives its dependencies through function arguments.
 *
 * Flow, once per user prompt:
 *
 *   input event → shouldPlan gate → getEngine → planPrompt (two Laya passes) → transform
 *
 * Every arrow has a failure branch that returns the prompt untouched. A broken
 * decision model is invisible, not fatal.
 *
 * The engine changed from needle3 to Laya in 0.2.0. The plugin's name, the
 * `/tiny-boss` command and the `tiny_boss` tool kept their names on purpose:
 * they are the install identity and every muscle memory attached to it, and
 * "tiny" is now a misnomer for a 421M-parameter checkpoint — a fact the README
 * states plainly rather than hides behind a rename.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInitialState } from "./src/shared/state.js";
import {
	activeLayout,
	assetStatus,
	assetsReady,
	BUNDLE_BYTES_APPROX,
	bundleDir,
	bundleFiles,
	cacheBytes,
	describeLayout,
	fetchBundle,
	getEngine,
	layaCacheDir,
	readConfigSummary,
	releaseEngine,
	warmEngine,
} from "./src/slices/engine/index.js";
import { describeManifest, formatGroups, planPrompt } from "./src/slices/planner/index.js";
import { detectBinaries, systemTools, formatDetection, CATALOGUE } from "./src/slices/discovery/index.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolCategory, ToolSpec } from "./src/shared/types.js";
import { CATEGORY_ORDER } from "./src/shared/decision-schema.js";
import { registerInputHook, drainInputHook, type HookPlan } from "./src/slices/hook/index.js";
import { registerCommands } from "./src/slices/commands/index.js";
import { registerTools } from "./src/slices/tools/index.js";

/** Planning budget for the two forward passes. Exceeding it means we pass the prompt through. */
const PLAN_TIMEOUT_MS = 4000;

/** Subagent recursion guard: never plan inside a delegated child session. */
function isDelegatedSession(): boolean {
	return process.env.PI_SUBAGENT === "true" || Boolean(process.env.PI_CHILD_SESSION);
}

/** Render a byte count the way a human reads a cache line. */
function mb(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
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

	// What the machine actually has, probed once per load. Laya may name any of
	// these; the plan renderer turns a binary into a runnable bash command.
	const detected = detectBinaries();
	const extras: ToolSpec[] = [...systemTools(detected), ...readUserTools()];

	/** The one function the hook and the commands both call. */
	const planFor = async (prompt: string): Promise<HookPlan | null> => {
		const resolution = await getEngine(state);
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
			onProgress(`downloading the Laya ONNX bundle (~${mb(BUNDLE_BYTES_APPROX)}) into ${layaCacheDir()}`);
			const last = new Map<string, string>();
			const { dir, layout, files, resumed } = await fetchBundle((progress) => {
				const line = `${progress.file} ${mb(progress.received)}${progress.total ? ` / ${mb(progress.total)}` : ""}`;
				// One notification per file per 8 MB, not per chunk: the fetch streams a
				// 1.6 GB file and a notify per chunk would drown the TUI.
				const key = `${progress.file}:${Math.floor(progress.received / (8 * 1024 * 1024))}`;
				if (last.get(progress.file) === key) return;
				last.set(progress.file, key);
				onProgress(line);
			});
			const status = await assetStatus();
			const lines = [
				resumed ? "the bundle was already complete; verified it" : "bundle downloaded",
				`  checkpoint: ${describeLayout(layout)}`,
				`  dir:        ${dir}`,
				`  files:      ${files.length} (the library's own list, recorded)`,
				...status.map((s) => `  ${s.name} ${mb(s.bytes)}`),
				"",
				"Run /tiny-boss warm to load the ONNX session now, or the next prompt",
				"will pay that one-time cost instead.",
			];
			return lines.join("\n");
		},
		warmEngine: async () => {
			if (!(await assetsReady())) {
				return `Laya ONNX bundle is not cached for ${describeLayout(activeLayout())} — run /tiny-boss fetch first (~1.6 GB, once)`;
			}
			const resolution = await warmEngine(state);
			if (!resolution.ok) return `warm failed — ${resolution.message}`;
			return `Laya session loaded in ${state.engineLoadMs ?? 0}ms (${bundleDir()})`;
		},
		assetReport: async () => {
			const ready = await assetsReady();
			const bytes = await cacheBytes();
			const config = ready ? await readConfigSummary() : "n/a";
			return [
				`${ready ? "ready" : "MISSING"} — ${bundleFiles().length} files, ${mb(bytes)} (${config})`,
				`            ${describeLayout(activeLayout())}`,
				`            ${bundleDir()}`,
			].join("\n");
		},
		toolReport: () => {
			const found = new Set(detected.map((d) => d.binary));
			const missing = CATALOGUE.map((c) => c.binary).filter((b) => !found.has(b));
			const known = detected.length + extras.filter((e) => e.source === "user").length;
			const lines = [
				`Laya decides among ${known} tools on this machine, in ${CATEGORY_ORDER.length} buckets:`,
				"",
				formatGroups(extras),
				"",
				"detected binaries:",
				formatDetection(detected, missing),
			];
			const userTools = extras.filter((e) => e.source === "user");
			if (userTools.length > 0) {
				lines.push("", "from ~/.pi/agent/pi-tiny-boss.tools.json:");
				userTools.forEach((t) =>
					lines.push(`  ${t.name.padEnd(12)} [${t.category ?? "search"}] ${t.description}`),
				);
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

	// Drain listeners and free the ONNX session on shutdown.
	pi.on("session_shutdown", async () => {
		drainInputHook();
		while (unsubscribers.length > 0) {
			unsubscribers.pop()?.();
		}
		await releaseEngine(state);
	});
}

/**
 * Extra tools from `~/.pi/agent/pi-tiny-boss.tools.json`.
 *
 * Shape: `{ "tools": [{ "name": "...", "description": "...", "short": "...",
 * "category": "execute" }] }`. `short` and `category` are optional; a missing
 * `short` is derived from the description and a missing `category` falls into
 * `search`, which is where `groupTools` puts anything unlabelled.
 *
 * Malformed or missing file yields an empty list — a bad config must not break
 * the hook.
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
			.map((t) => {
				const category = String(t.category ?? "").trim() as ToolCategory;
				return {
					name: String(t.name ?? "").trim(),
					description: String(t.description ?? "").trim(),
					short: typeof t.short === "string" ? t.short.trim() : undefined,
					category: CATEGORY_ORDER.includes(category) ? category : "search",
					invokedAs: typeof t.invokedAs === "string" ? t.invokedAs : "bash",
					example: typeof t.example === "string" ? t.example : undefined,
					source: "user" as const,
				};
			})
			.filter((t) => t.name.length > 0 && t.description.length > 0);
	} catch {
		return [];
	}
}
