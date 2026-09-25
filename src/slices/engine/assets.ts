/**
 * Asset acquisition for the Laya engine.
 *
 * `@receptron/laya` owns the download and the cache layout. What this slice owns
 * is the *offline gate* — proving the bundle is already on disk before the prompt
 * path is allowed to touch it.
 *
 * That gate matters here. `Laya.load()` with no `modelDir` calls `ensureBundle`,
 * which issues a HEAD request per file even on a warm cache: a network round trip
 * on the prompt path, and a 1.6 GB download if the cache is empty. So the prompt
 * path never calls `Laya.load()` without a `modelDir` this slice has already
 * verified. Only `/tiny-boss fetch` may touch the network.
 *
 * The directory rule lives in `layout.ts`, which mirrors the library's
 * derivation. To keep that mirror from becoming the source of truth, `fetch`
 * writes a **record** of what the library actually returned — directory, file
 * list and layout — and the gate prefers the record over the mirror. A layout
 * change upstream therefore cannot silently make the gate inspect the wrong path:
 * the first fetch corrects it, and the version check below refuses a record
 * written by a different repo, revision or subfolder than the one now configured.
 */

import { mkdir, writeFile, readFile, access, constants, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { BUNDLE_FILES, defaultLayout, mirroredBundleDir, type BundleLayout } from "./layout.js";

export {
	BUNDLE_FILES,
	BUNDLE_BYTES_APPROX,
	DEFAULT_REPO,
	DEFAULT_REVISION,
	bundleDirFor,
	defaultLayout,
	describeLayout,
	layaCacheDir,
	mirroredBundleDir,
	type BundleLayout,
} from "./layout.js";

/** Our own bookkeeping directory. The weights live in the library's cache. */
export function stateDir(): string {
	const override = process.env.PI_TINY_BOSS_STATE_DIR;
	if (override && override.trim().length > 0) return override.trim();
	return join(homedir(), ".cache", "pi-tiny-boss", "laya");
}

/** Where the record of the last fetch is kept. */
function recordPath(): string {
	return join(stateDir(), "bundle.json");
}

/** Legacy location from 0.2.0, which held a bare directory path. */
function legacyRecordPath(): string {
	return join(stateDir(), "bundle-dir.txt");
}

/** What `/tiny-boss fetch` learned from the library. */
interface BundleRecord {
	/** The directory the library returned. */
	dir: string;
	/** The library's own file list at that moment. */
	files: string[];
	/** The layout that produced it, so a stale record can be detected. */
	layout: BundleLayout;
}

/** True when the record describes the layout currently configured. */
function recordMatches(record: BundleRecord, layout: BundleLayout): boolean {
	return (
		record.layout.repo === layout.repo &&
		record.layout.revision === layout.revision &&
		(record.layout.subfolder ?? null) === (layout.subfolder ?? null) &&
		record.layout.cacheDir === layout.cacheDir
	);
}

/**
 * Read the record, or null when there is none or it is unusable.
 *
 * A record for a *different* layout is treated as absent: switching
 * `PI_TINY_BOSS_SUBFOLDER` must not leave the gate reporting the previous
 * checkpoint as ready.
 */
function readRecord(): BundleRecord | null {
	const layout = defaultLayout();
	try {
		const raw = readFileSync(recordPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<BundleRecord>;
		if (typeof parsed?.dir !== "string" || !Array.isArray(parsed.files) || !parsed.layout) return null;
		const record = parsed as BundleRecord;
		if (!recordMatches(record, layout)) return null;
		const files = record.files.filter((f): f is string => typeof f === "string" && f.length > 0);
		return files.length > 0 ? { ...record, files } : null;
	} catch {
		// No structured record. Fall back to the bare path 0.2.0 wrote, so an
		// install that fetched before this version does not report MISSING and
		// re-download 1.6 GB for nothing.
		try {
			const legacy = readFileSync(legacyRecordPath(), "utf8").trim();
			if (legacy.length > 0) return { dir: legacy, files: [...BUNDLE_FILES], layout };
		} catch {
			// nothing recorded at all
		}
		return null;
	}
}

/**
 * The files one checkpoint consists of.
 *
 * The recorded list wins over the constant, because the library is the authority
 * on what a bundle contains; the constant only answers for a machine that has
 * never fetched.
 */
export function bundleFiles(): readonly string[] {
	return readRecord()?.files ?? BUNDLE_FILES;
}

/**
 * The bundle directory to load from.
 *
 * Precedence: an explicit override, then the recorded directory, then the
 * mirrored default. An override is also the supported way to point at your own
 * `export/export_onnx.py` output, and it is the only path that needs no fetch.
 */
export function bundleDir(): string {
	const override = process.env.PI_TINY_BOSS_MODEL_DIR ?? process.env.LAYA_MODEL_DIR;
	if (override && override.trim().length > 0) return override.trim();
	return readRecord()?.dir ?? mirroredBundleDir();
}

/** The layout in effect, for reporting. */
export function activeLayout(): BundleLayout {
	return defaultLayout();
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
	for (const file of bundleFiles()) {
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
 * A half-download is not a cache hit: `ensureBundle` writes to `.part-<pid>` and
 * renames, so a partial file under the real name means the cache was tampered
 * with or truncated, and loading from it would fail deep inside ONNX.
 */
export async function assetsReady(): Promise<boolean> {
	const status = await assetStatus();
	return status.length > 0 && status.every((a) => a.present);
}

/** Total bytes currently on disk, for `/tiny-boss status`. */
export async function cacheBytes(): Promise<number> {
	return (await assetStatus()).reduce((sum, a) => sum + a.bytes, 0);
}

/** Remember what the library actually did, so the mirror stays a fallback. */
async function recordBundle(dir: string, files: readonly string[], layout: BundleLayout): Promise<void> {
	await mkdir(stateDir(), { recursive: true });
	const record: BundleRecord = { dir, files: [...files], layout };
	await writeFile(recordPath(), JSON.stringify(record, null, 1), "utf8");
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
 * This is the only function in the plugin allowed to touch the network, and it is
 * reached only from `/tiny-boss fetch`. The package is imported dynamically so
 * that a machine without a working `onnxruntime-node` binding can still load the
 * extension and report the problem rather than failing at import time.
 */
export async function fetchBundle(
	onProgress?: (progress: FetchProgress) => void,
): Promise<{ dir: string; layout: BundleLayout; files: readonly string[]; resumed: boolean }> {
	const layout = defaultLayout();
	const wasReady = await assetsReady();
	// SAFETY: the package exports both members, but its declared types also carry
	// download options this plugin never passes. Only `repo`, `revision`,
	// `subfolder`, `onProgress` and `BUNDLE_FILES` are relied on, and a change to
	// any of them fails loudly at the first `/tiny-boss fetch`.
	const mod = (await import("@receptron/laya")) as unknown as {
		ensureBundle: (opts?: {
			repo?: string;
			revision?: string;
			subfolder?: string;
			onProgress?: (info: { file: string; received: number; total: number | null }) => void;
		}) => Promise<string>;
		BUNDLE_FILES: readonly string[];
	};
	const dir = await mod.ensureBundle({
		repo: layout.repo,
		revision: layout.revision,
		subfolder: layout.subfolder ?? undefined,
		onProgress: onProgress ? (info) => onProgress(info) : undefined,
	});
	// The library is the authority on both, so both are recorded from it.
	const files = Array.isArray(mod.BUNDLE_FILES) && mod.BUNDLE_FILES.length > 0 ? mod.BUNDLE_FILES : BUNDLE_FILES;
	await recordBundle(dir, files, layout);
	return { dir, layout, files, resumed: wasReady };
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
