import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The files a bundle must have to be loadable, whatever produced it.
 * Mirrors `CORE_BUNDLE_FILES` in the slice; the two tests that depend on the
 * strict five-file list use `BUNDLE_FILES` explicitly.
 */
const CORE_FILES = ["laya.onnx", "laya_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"];

import {
	assetPath,
	assetStatus,
	assetsReady,
	BUNDLE_FILES,
	bundleDir,
	bundleFiles,
	cacheBytes,
	defaultLayout,
	layaCacheDir,
	mirroredBundleDir,
	stateDir,
} from "../src/slices/engine/assets.js";

/**
 * The offline gate.
 *
 * This is the safety-critical part of the engine slice: `Laya.load()` without a
 * verified `modelDir` starts a 1.7 GB download from the prompt path, and the
 * library's own `ensureBundle` issues a HEAD request per file even on a warm
 * cache. So "is the bundle on disk" has to be answerable without importing the
 * package and without touching the network.
 */

/** Run `body` with env overrides in place, then restore them exactly. */
async function withEnv(vars, body) {
	const saved = {};
	for (const [key, value] of Object.entries(vars)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await body();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "tiny-boss-assets-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the bundle is the five files one exported checkpoint consists of", () => {
	assert.deepEqual([...BUNDLE_FILES], [
		"laya.onnx",
		"laya.onnx.data",
		"laya_config.json",
		"tokenizer/tokenizer.json",
		"tokenizer/tokenizer_config.json",
	]);
});

/**
 * Every test here pins its own state directory *and* its own cache root.
 *
 * `bundleDir()` prefers the path a real `/tiny-boss fetch` recorded, and falls
 * back to a path under the real cache root — so a test that pinned neither would
 * read the operator's actual bundle and assert against it. That is a test that
 * passes or fails depending on whether the feature was ever used on this machine,
 * which is worse than no test. Creating a local export under the real cache (which
 * is exactly what running the export pipeline does) was enough to reintroduce
 * that, so `LAYA_CACHE` is pinned here for every test rather than per test.
 */
const emptyState = (stateDirPath) => ({
	PI_TINY_BOSS_MODEL_DIR: undefined,
	LAYA_MODEL_DIR: undefined,
	PI_TINY_BOSS_STATE_DIR: stateDirPath,
	LAYA_CACHE: stateDirPath,
});

test("an explicit model directory wins over everything else", async () => {
	const { dir, cleanup } = tempDir();
	try {
		await withEnv({ ...emptyState(dir), PI_TINY_BOSS_MODEL_DIR: dir }, async () => {
			assert.equal(bundleDir(), dir);
			assert.equal(assetPath("laya.onnx"), join(dir, "laya.onnx"));
		});
	} finally {
		cleanup();
	}
});

test("LAYA_MODEL_DIR is the fallback when the plugin's own override is unset", async () => {
	const { dir, cleanup } = tempDir();
	try {
		await withEnv({ ...emptyState(dir), LAYA_MODEL_DIR: dir }, async () => {
			assert.equal(bundleDir(), dir);
		});
	} finally {
		cleanup();
	}
});

test("LAYA_CACHE moves the mirrored default, and the plugin does not own it", async () => {
	const { dir, cleanup } = tempDir();
	try {
		await withEnv({ ...emptyState(dir), LAYA_CACHE: dir }, async () => {
			assert.equal(layaCacheDir(), dir);
			assert.ok(mirroredBundleDir().startsWith(dir), "the mirrored path lives under the library's cache");
			assert.equal(bundleDir(), mirroredBundleDir(), "with nothing recorded, the mirror is the answer");
		});
	} finally {
		cleanup();
	}
});

test("a recorded bundle directory beats the mirror but not an explicit override", async () => {
	const state = tempDir();
	const fetched = tempDir();
	const override = tempDir();
	try {
		mkdirSync(state.dir, { recursive: true });
		writeFileSync(join(state.dir, "bundle-dir.txt"), fetched.dir, "utf8");
		await withEnv({ ...emptyState(state.dir) }, async () => {
			assert.equal(stateDir(), state.dir);
			// The record exists because the library owns the cache layout: it is
			// written from the directory `ensureBundle` actually returned, so an
			// upstream layout change cannot silently point the gate at nothing.
			assert.equal(bundleDir(), fetched.dir, "the record retires the mirror");
			await withEnv({ PI_TINY_BOSS_MODEL_DIR: override.dir }, async () => {
				assert.equal(bundleDir(), override.dir, "an explicit override still wins");
			});
		});
	} finally {
		state.cleanup();
		fetched.cleanup();
		override.cleanup();
	}
});

test("an empty record file falls back to the mirror instead of an empty path", async () => {
	const state = tempDir();
	try {
		mkdirSync(state.dir, { recursive: true });
		writeFileSync(join(state.dir, "bundle-dir.txt"), "\n", "utf8");
		await withEnv({ ...emptyState(state.dir) }, async () => {
			assert.equal(bundleDir(), mirroredBundleDir());
		});
	} finally {
		state.cleanup();
	}
});

/**
 * Write the structured record a real fetch leaves behind.
 *
 * The layout's cache root is forced to `statePath`, because a test pins both
 * `PI_TINY_BOSS_STATE_DIR` and `LAYA_CACHE` to that one temp directory: a record
 * written from the ambient env would carry the operator's real cache root and then
 * be rejected by `recordMatches` for describing a different layout.
 */
function writeRecord(statePath, over = {}) {
	mkdirSync(statePath, { recursive: true });
	const record = {
		dir: join(statePath, "bundle"),
		files: ["laya.onnx", "laya.onnx.data", "laya_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"],
		layout: { ...defaultLayout(), cacheDir: statePath },
		...over,
	};
	writeFileSync(join(statePath, "bundle.json"), JSON.stringify(record), "utf8");
	return record;
}

test("a fetch record is the authority on both the directory and the file list", async () => {
	const state = tempDir();
	try {
		const record = writeRecord(state.dir);
		await withEnv({ ...emptyState(state.dir) }, async () => {
			assert.equal(bundleDir(), record.dir, "the gate must inspect what the library actually returned");
			assert.deepEqual([...bundleFiles()], record.files, "the library owns what a bundle contains");
			assert.equal(assetPath("laya.onnx"), join(record.dir, "laya.onnx"));
		});
	} finally {
		state.cleanup();
	}
});

test("the recorded file list is what decides cache completeness, not the bundled constant", async () => {
	const state = tempDir();
	try {
		// A future bundle with one extra file: the constant knows nothing about it,
		// and reporting ready without it would load an incomplete session.
		const extra = "decoder.onnx";
		const record = writeRecord(state.dir, { files: [...BUNDLE_FILES, extra] });
		mkdirSync(record.dir, { recursive: true });
		for (const file of BUNDLE_FILES) {
			const path = join(record.dir, file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "data");
		}
		await withEnv({ ...emptyState(state.dir) }, async () => {
			assert.equal(await assetsReady(), false, `${extra} is missing, so the bundle is incomplete`);
			assert.equal((await assetStatus()).length, BUNDLE_FILES.length + 1);
		});
	} finally {
		state.cleanup();
	}
});

test("a record for a different checkpoint is ignored, so a layout change is not reported ready", async () => {
	const state = tempDir();
	try {
		// Fetched the English root, then the operator switched to a subfolder. The
		// record describes a bundle that is not the one now configured.
		writeRecord(state.dir, { dir: join(state.dir, "english"), layout: { ...defaultLayout(), subfolder: null } });
		await withEnv({ ...emptyState(state.dir), PI_TINY_BOSS_SUBFOLDER: "typed-decisions" }, async () => {
			assert.equal(bundleDir(), mirroredBundleDir(), "the stale record must not win");
			assert.ok(bundleDir().endsWith("typed-decisions"), `wrong checkpoint: ${bundleDir()}`);
			assert.equal(await assetsReady(), false, "a fetch is required for the new checkpoint");
		});
	} finally {
		state.cleanup();
	}
});

test("an empty directory is not a cache hit", async () => {
	const { dir, cleanup } = tempDir();
	try {
		await withEnv({ ...emptyState(dir), PI_TINY_BOSS_MODEL_DIR: dir }, async () => {
			assert.equal(await assetsReady(), false);
			assert.equal(await cacheBytes(), 0);
			const status = await assetStatus();
			assert.equal(status.length, CORE_FILES.length);
			assert.equal(status.every((s) => !s.present), true);
		});
	} finally {
		cleanup();
	}
});

test("an unrecorded bundle needs the graph, config and tokenizer, but not .data", async () => {
	const { dir, cleanup } = tempDir();
	try {
		// A self-contained export is a legitimate shape: the library's own
		// export_onnx.py asks for external_data=False, and only a large checkpoint
		// ends up with a .data sidecar. Demanding one would refuse a working bundle.
		for (const file of CORE_FILES) writeFile(file, dir);
		await withEnv({ ...emptyState(dir), PI_TINY_BOSS_MODEL_DIR: dir }, async () => {
			assert.equal(await assetsReady(), true, "a single-file export must be usable");
			assert.equal((await assetStatus()).length, CORE_FILES.length);
		});
	} finally {
		cleanup();
	}
});

test("a recorded bundle is still held to the library's full file list", async () => {
	const state = tempDir();
	try {
		// The record is what protects a *fetched* bundle, where a missing .data
		// means a truncated download rather than a different export shape.
		await withEnv({ ...emptyState(state.dir) }, async () => {
			const record = writeRecord(state.dir);
			for (const file of CORE_FILES) writeFile(file, record.dir);
			assert.equal(await assetsReady(), false, "laya.onnx.data is missing from a recorded bundle");
		});
	} finally {
		state.cleanup();
	}
});

test("a half-downloaded bundle is not a cache hit either", async () => {
	const { dir, cleanup } = tempDir();
	try {
		await withEnv({ ...emptyState(dir), PI_TINY_BOSS_MODEL_DIR: dir }, async () => {
			// Every core file but one: the shape an interrupted copy would leave.
			for (const file of CORE_FILES.slice(0, -1)) writeFile(file, dir);
			assert.equal(await assetsReady(), false);
			assert.equal((await assetStatus()).filter((s) => s.present).length, CORE_FILES.length - 1);
		});
	} finally {
		cleanup();
	}
});

test("a complete bundle is a cache hit and reports its real size", async () => {
	const { dir, cleanup } = tempDir();
	try {
		await withEnv({ ...emptyState(dir), PI_TINY_BOSS_MODEL_DIR: dir }, async () => {
			for (const file of BUNDLE_FILES) writeFile(file, dir);
			assert.equal(await assetsReady(), true);
			assert.equal(await cacheBytes(), CORE_FILES.length * 4);
			const status = await assetStatus();
			assert.equal(status.every((s) => s.present && s.bytes === 4), true);
		});
	} finally {
		cleanup();
	}
});

/** Write a 4-byte file at `dir/file`, creating parent directories. */
function writeFile(file, dir) {
	const path = join(dir, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "data");
}
