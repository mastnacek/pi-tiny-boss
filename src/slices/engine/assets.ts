/**
 * Asset acquisition for the Laya engine.
 *
 * Big difference from the needle3 version of this file: the plugin no longer
 * owns the download. `@receptron/laya` fetches its own ONNX bundle (~1.6 GB, fp32)
 * into `~/.cache/receptron-laya`, and owns the layout, freshness check and
 * atomic rename. What this slice owns is the *offline gate* — proving the bundle
 * is already on disk before the prompt path is allowed to touch it.
 *
 * That gate matters more here than it did with a 36 MB WASM blob. `Laya.load()`
 * with no `modelDir` calls `ensureBundle`, which issues a HEAD request per file
 * even on a warm cache: a network round trip on the prompt path, and a 1.6 GB
 * download if the cache is empty. So the prompt path never calls `Laya.load()`
 * without a `modelDir` that this slice has already verified. Only
 * `/tiny-boss fetch` is allowed to hit the network.
 *
 * The bundle directory has to be derivable without importing the package
 * (`import "@receptron/laya"` pulls in `onnxruntime-node` and its native
 * binding), so the default layout is mirrored below and `/tiny-boss fetch`
 * records the directory the library actually returned. The mirror is a
 * fallback, not the source of truth.
 */

import { mkdir, writeFile, readFile, access, constants, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Our own bookkeeping directory. The weights live in the library's cache. */
export function stateDir(): string {
	const override = process.env.PI_TINY_BOSS_STATE_DIR;
	if (override && override.trim().length > 0) return override.trim();
	return join(homedir(), ".cache", "pi-tiny-boss", "laya");
}

/** Where the recorded bundle path is kept, so the mirror is only a fallback. */
function bundleRecordPath(): string {
	return join(stateDir(), "bundle-dir.txt");
}

/** Hugging Face repo the exported ONNX bundle is published to. */
export const BUNDLE_REPO = "receptron/laya-onnx";

/** Revision, and the subfolder that mirrors `@receptron/laya`'s `ensureBundle`. */
export const BUNDLE_REVISION = "main";

/** The five files one exported checkpoint consists of. */
export const BUNDLE_FILES = [
	"laya.onnx",
	"laya.onnx.data",
	"laya_config.json",
	"tokenizer/tokenizer.json",
	"tokenizer/tokenizer_config.json",
] as const;

/** Rough download size, for `/tiny-boss fetch` — fp32, so it is not small. */
export const BUNDLE_BYTES_APPROX = 1_700_000_000;

/** The library's own cache root, mirrored without importing it. */
export function layaCacheDir(): string {
	const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
	return process.env.LAYA_CACHE ?? join(base, "receptron-laya");
}

/** Where `ensureBundle` puts the English checkpoint, when nothing is recorded. */
export function mirroredBundleDir(): string {
	return join(layaCacheDir(), BUNDLE_REPO.replace("/", "--"), BUNDLE_REVISION);
}

/**
 * The bundle directory to load from.
 *
 * Precedence: an explicit override, then the directory `/tiny-boss fetch`
 * recorded, then the mirrored default. An override is also the supported way to
 * point at your own `export/export_onnx.py` output.
 *
 * The record is what retires the mirror: it is written from the directory the
 * library actually returned, so an upstream layout change cannot silently make
 * the offline gate look at the wrong path.
 */
export function bundleDir(): string {
	const override = process.env.PI_TINY_BOSS_MODEL_DIR ?? process.env.LAYA_MODEL_DIR;
	if (override && override.trim().length > 0) return override.trim();
	const recorded = readFileSyncIfPresent(bundleRecordPath());
	if (recorded) return recorded;
	return mirroredBundleDir();
}

/** Read a one-line marker file, or undefined when it is absent or empty. */
function readFileSyncIfPresent(path: string): string | undefined {
	// Synchronous on purpose: the status command calls `bundleDir` and must not
	// become async just to read a few bytes.
	try {
		const text = readFileSync(path, "utf8").trim();
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

export function assetPath(file: string): string {
	return join(bundleDir(), file);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** Which assets are present, and how big they are. */
export interface AssetStatus {
	name: string;
	file: string;
	present: boolean;
	bytes: number;
}

export async function assetStatus(): Promise<AssetStatus[]> {
	const out: AssetStatus[] = [];
	for (const file of BUNDLE_FILES) {
		const path = assetPath(file);
		let bytes = 0;
		if (await exists(path)) {
			try {
				bytes = (await stat(path)).size;
			} catch {
				bytes = 0;
			}
		}
		out.push({ name: file, file, present: bytes > 0, bytes });
	}
	return out;
}

/**
 * True only when every bundle file is on disk.
 *
 * A half-download is not a cache hit: `ensureBundle` writes to `.part-<pid>`
 * and renames, so a partial file under the real name means the cache was
 * tampered with or truncated, and loading from it would fail deep inside ONNX.
 */
export async function assetsReady(): Promise<boolean> {
	const status = await assetStatus();
	return status.every((a) => a.present);
}

/** Total bytes currently on disk, for `/tiny-boss status`. */
export async function cacheBytes(): Promise<number> {
	return (await assetStatus()).reduce((sum, a) => sum + a.bytes, 0);
}

/** Remember the directory the library actually used, so the mirror is retired. */
async function recordBundleDir(dir: string): Promise<void> {
	await mkdir(stateDir(), { recursive: true });
	await writeFile(bundleRecordPath(), dir, "utf8");
}

/** Progress line for `/tiny-boss fetch`. */
export interface FetchProgress {
	file: string;
	received: number;
	total: number | null;
}

/**
 * Download the ONNX bundle, once.
 *
 * This is the only function in the plugin allowed to touch the network, and it
 * is reached only from `/tiny-boss fetch`. The package is imported dynamically
 * so that a machine without a working `onnxruntime-node` binding can still load
 * the extension and report the problem, instead of failing at import time.
 */
export async function fetchBundle(
	onProgress?: (progress: FetchProgress) => void,
): Promise<{ dir: string; resumed: boolean }> {
	const wasReady = await assetsReady();
	// SAFETY: the package exports `ensureBundle`, but its declared return type also
	// carries Hugging Face download options this plugin never passes and a
	// `BUNDLE_FILES` constant that is read from disk instead (see the note at the
	// top of this file). Only `repo`, `revision` and `onProgress` are relied on, and
	// a change to any of them fails loudly at the first `/tiny-boss fetch`.
	const mod = (await import("@receptron/laya")) as unknown as {
		ensureBundle: (opts?: {
			repo?: string;
			revision?: string;
			onProgress?: (info: { file: string; received: number; total: number | null }) => void;
		}) => Promise<string>;
	};
	const dir = await mod.ensureBundle({
		repo: BUNDLE_REPO,
		revision: BUNDLE_REVISION,
		onProgress: onProgress ? (info) => onProgress(info) : undefined,
	});
	await recordBundleDir(dir);
	return { dir, resumed: wasReady };
}

/** Read the Laya config next to the bundle, for `/tiny-boss status`. */
export async function readConfigSummary(): Promise<string> {
	try {
		const raw = await readFile(assetPath("laya_config.json"), "utf8");
		const config = JSON.parse(raw) as { max_len?: number; head_max_len?: number };
		return `max_len=${config.max_len ?? "?"} head_max_len=${config.head_max_len ?? "?"}`;
	} catch {
		return "config unreadable";
	}
}
