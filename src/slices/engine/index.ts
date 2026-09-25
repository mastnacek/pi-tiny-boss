/**
 * Public boundary of the `engine` slice.
 *
 * The only place that knows the engine exists. Callers get a TinyEngine or a
 * typed failure — never a half-built WASM module.
 */

export { EngineUnavailableError, createNeedleEngine } from "./needle.js";
export { ASSETS, CACHE_DIR, assetPath, assetStatus, assetsReady, downloadAsset } from "./assets.js";

import { createNeedleEngine, EngineUnavailableError } from "./needle.js";
import { assetsReady } from "./assets.js";
import type { TinyBossState, TinyEngine, ToolSpec } from "../../shared/types.js";
import { recordFailure } from "../../shared/state.js";

/** What `getEngine` reports back to the caller. */
export type EngineResolution =
	| { ok: true; engine: TinyEngine }
	| { ok: false; reason: "assets-missing" | "engine-error"; message: string };

/**
 * Return the cached engine, building it on first use.
 *
 * On failure the reason is latched into state so the input hook stops retrying
 * on every prompt — a missing cache must cost one failed call, not one per turn.
 */
export async function getEngine(
	state: TinyBossState,
	tools: ToolSpec[] = [],
): Promise<EngineResolution> {
	if (state.engine) return { ok: true, engine: state.engine };

	if (!(await assetsReady())) {
		const message = "needle3 assets are not cached — run /tiny-boss fetch";
		recordFailure(state, "assets-missing", message);
		return { ok: false, reason: "assets-missing", message };
	}

	try {
		const engine = await createNeedleEngine(tools);
		state.engine = engine;
		state.degraded = null;
		state.lastError = null;
		return { ok: true, engine };
	} catch (error) {
		const reason = error instanceof EngineUnavailableError ? error.reason : "engine-error";
		const message = error instanceof Error ? error.message : String(error);
		recordFailure(state, reason, message);
		return { ok: false, reason, message };
	}
}

/** Release the cached engine. Safe to call when nothing was ever built. */
export async function releaseEngine(state: TinyBossState): Promise<void> {
	const engine = state.engine;
	state.engine = null;
	if (!engine) return;
	try {
		await engine.close();
	} catch {
		// teardown is best effort
	}
}
