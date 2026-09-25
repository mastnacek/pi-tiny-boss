/**
 * Where the ONNX bundle lives.
 *
 * `@receptron/laya` owns this layout, not this plugin. It is reimplemented here
 * for one reason: `import "@receptron/laya"` loads `onnxruntime-node` and its
 * native binding, and the offline gate has to answer "is the bundle on disk"
 * *before* anything is allowed to load. A machine whose native binding is broken
 * must still be able to load the extension and report a fixable problem.
 *
 * So the rule below is a mirror, and a mirror is only honest if it is verifiable.
 * Every constant and the derivation were checked against the library itself
 * rather than transcribed from its README:
 *
 *   - `defaultCacheDir()` matches `layaCacheDir()` under `LAYA_CACHE` set and
 *     unset, and under `XDG_CACHE_HOME` set and unset.
 *   - `DEFAULT_REPO` and `BUNDLE_FILES` match the library's exports.
 *   - the subfolder rule was read out of the URL `ensureBundle` actually builds
 *     for an unreachable repo: `multilingual` → `multilingual/laya.onnx`,
 *     `/nested/deep/` → `nested/deep/laya.onnx`.
 *
 * `test/layout.test.js` re-runs the first two checks whenever the library is
 * loadable, so drift breaks the suite instead of silently pointing the gate at
 * the wrong directory. The third needs a network round trip and is checked in
 * `fetchBundle` instead, by recording the directory the library returned.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Hugging Face repo the exported ONNX bundles are published to. */
export const DEFAULT_REPO = "receptron/laya-onnx";

/** Git revision inside that repo. */
export const DEFAULT_REVISION = "main";

/**
 * Files that make up one exported checkpoint, relative to the bundle directory.
 *
 * The authoritative copy is the library's own `BUNDLE_FILES`; this is the
 * fallback for a machine that has never fetched, and `fetchBundle` replaces it
 * with the library's list in the record it writes.
 */
export const BUNDLE_FILES = [
	"laya.onnx",
	"laya.onnx.data",
	"laya_config.json",
	"tokenizer/tokenizer.json",
	"tokenizer/tokenizer_config.json",
] as const;

/** Rough download size, for `/tiny-boss fetch` — fp32, so it is not small. */
export const BUNDLE_BYTES_APPROX = 1_700_000_000;

/** One checkpoint: a repo, a revision, and optionally a subfolder inside it. */
export interface BundleLayout {
	/** Root of the library's cache. */
	cacheDir: string;
	/** Hugging Face repo id, `owner/name`. */
	repo: string;
	/** Git revision. */
	revision: string;
	/**
	 * Checkpoint inside the repo, or null for the repo root.
	 *
	 * This is how the library documents publishing a variant — the README shows
	 * `subfolder: "multilingual"` — and the published repo currently carries only
	 * the English checkpoint at its root, so null is the shipped default.
	 */
	subfolder: string | null;
}

/** The library's cache root, mirroring `defaultCacheDir()` exactly. */
export function layaCacheDir(): string {
	const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
	return process.env.LAYA_CACHE ?? join(base, "receptron-laya");
}

/**
 * The layout to use, from the environment.
 *
 * `LAYA_CACHE` is the library's own variable and is honoured directly.
 * `PI_TINY_BOSS_SUBFOLDER` exists because the library takes `subfolder` as a
 * call option and has no variable for it, and the prompt path has no way to pass
 * options through — without it the plugin would be structurally unable to reach
 * any checkpoint that is not at a repo root.
 *
 * A *local* bundle needs no variable: `PI_TINY_BOSS_MODEL_DIR` / `LAYA_MODEL_DIR`
 * overrides the whole layout, which is the supported path for an export you built
 * yourself with the library's `export/export_onnx.py`.
 */
export function defaultLayout(): BundleLayout {
	const subfolder = (process.env.PI_TINY_BOSS_SUBFOLDER ?? "")
		.trim()
		.replace(/^\/+|\/+$/g, "");
	return {
		cacheDir: layaCacheDir(),
		repo: DEFAULT_REPO,
		revision: DEFAULT_REVISION,
		subfolder: subfolder.length > 0 ? subfolder : null,
	};
}

/**
 * The bundle directory for a layout.
 *
 * Mirrors `ensureBundle`'s derivation, including the detail that matters: the
 * repo's `/` becomes `--` so the two path segments collapse into one cache
 * directory.
 *
 * It deliberately does NOT reproduce the trailing separator of the library's own
 * return value. `ensureBundle` builds its file name as `subfolder + "/" + file`,
 * so its `dir` string ends in a separator while pointing at the same directory —
 * `path.resolve`, which `Laya.load` applies, normalises it away anyway. Emitting
 * one here would make two strings for one directory, and on Windows the test for
 * this caught exactly that: `path.join` preserves a trailing separator, so the
 * mirror and the record would never compare equal.
 */
export function bundleDirFor(layout: BundleLayout): string {
	const segments = [layout.cacheDir, layout.repo.replace("/", "--"), layout.revision];
	if (layout.subfolder) segments.push(layout.subfolder.replace(/^\/+|\/+$/g, ""));
	return join(...segments);
}

/** The layout the library uses by default, resolved to a directory. */
export function mirroredBundleDir(): string {
	return bundleDirFor(defaultLayout());
}

/** Human-readable one-liner for `/tiny-boss status`. */
export function describeLayout(layout: BundleLayout): string {
	const checkpoint = layout.subfolder ? `${layout.repo}/${layout.subfolder}` : layout.repo;
	return `${checkpoint}@${layout.revision}`;
}
