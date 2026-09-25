/**
 * Where one eval run is written.
 *
 * Keyed by the checkpoint under test, not by a fixed name: comparing the English
 * base against a fine-tuned export is the entire point of this harness, and a
 * single `out.json` meant the second run silently overwrote the first — the exact
 * opposite of auditable evidence.
 *
 * The slug is the subfolder the layout selects, so the filename and the thing it
 * describes cannot disagree. The published English bundle lives at a repo root
 * and gets `english`.
 */

import { fileURLToPath } from "node:url";

/** Which checkpoint the current environment points at. */
export function checkpointSlug(): string {
	const subfolder = (process.env.PI_TINY_BOSS_SUBFOLDER ?? "").trim();
	const modelDir = (process.env.PI_TINY_BOSS_MODEL_DIR ?? process.env.LAYA_MODEL_DIR ?? "").trim();
	if (subfolder.length > 0) return sanitise(subfolder);
	if (modelDir.length > 0) return sanitise(modelDir.split(/[\/]/).filter(Boolean).pop() ?? "local");
	return "english";
}

/** A filename-safe form of a checkpoint name. */
function sanitise(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/** Absolute path of one run artifact, e.g. `outPath("out")`. */
export function outPath(kind: "out" | "gates"): URL {
	return new URL(`./${kind}.${checkpointSlug()}.json`, import.meta.url);
}

/** Kept so a caller can log where a run landed without rebuilding the name. */
export function outPathString(kind: "out" | "gates"): string {
	return fileURLToPath(outPath(kind));
}
