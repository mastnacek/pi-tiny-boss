/**
 * Public boundary of the `engine` slice.
 *
 * The only place that knows the engine exists. Callers get a TinyEngine or a
 * typed failure — never a half-loaded ONNX session.
 */

export { EngineUnavailableError, createLayaEngine, threadCount } from "./laya.js";
export {
	BUNDLE_FILES,
	BUNDLE_BYTES_APPROX,
	DEFAULT_REPO,
	DEFAULT_REVISION,
	activeLayout,
	assetPath,
	assetStatus,
	assetsReady,
	bundleDir,
	bundleDirFor,
	bundleFiles,
	cacheBytes,
	defaultLayout,
	describeLayout,
	fetchBundle,
	layaCacheDir,
	mirroredBundleDir,
	readConfigSummary,
	stateDir,
	type BundleLayout,
	type FetchProgress,
} from "./assets.js";

import { createLayaEngine, EngineUnavailableError } from "./laya.js";
import { assetsReady } from "./assets.js";
import type { TinyBossState, TinyEngine } from "../../shared/types.js";
import { recordFailure } from "../../shared/state.js";

/** What `getEngine` reports back to the caller. */
export type EngineResolution =
	| { ok: true; engine: TinyEngine }
	| { ok: false; reason: "assets-missing" | "engine-error"; message: string };

/**
 * Return the cached engine, building it on first use.
 *
 * Building is the one slow call in the plugin: an ONNX session over 1.6 GB of
 * fp32 weights takes seconds, and it happens once per process. The duration is
 * recorded on state so `/tiny-boss status` can report it rather than leaving the
 * user to wonder why one prompt took a while.
 *
 * On failure the reason is latched so the input hook stops retrying on every
 * prompt — a missing cache must cost one failed call, not one per turn.
 */
export async function getEngine(
	state: TinyBossState,
): Promise<EngineResolution> {
	if (state.engine) return { ok: true, engine: state.engine };

	if (!(await assetsReady())) {
		const message = "Laya ONNX bundle is not cached — run /tiny-boss fetch (about 1.6 GB, once)";
		recordFailure(state, "assets-missing", message);
		return { ok: false, reason: "assets-missing", message };
	}

	const started = Date.now();
	try {
		const engine = await createLayaEngine();
		state.engine = engine;
		state.engineLoadMs = Date.now() - started;
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

/**
 * Build the engine without planning anything.
 *
 * `/tiny-boss warm` uses this so the one-time load happens when the user asks
 * for it, instead of being charged to whichever prompt happens to arrive first.
 */
export async function warmEngine(state: TinyBossState): Promise<EngineResolution> {
	await releaseEngine(state);
	return getEngine(state);
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
