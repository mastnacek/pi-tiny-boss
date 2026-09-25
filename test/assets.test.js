import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
 * Every test here pins its own state directory.
 *
 * `bundleDir()` prefers the path a real `/tiny-boss fetch` recorded, which on a
 * machine that has run one is the user's actual cache — so a test that only sets
 * `LAYA_CACHE` would read the operator's bundle and assert against it. That is a
 * test that passes or fails depending on whether the feature was ever used, which
 * is worse than no test. Pinning `PI_TINY_BOSS_STATE_DIR` removes the dependency.
 */
const emptyState = (stateDirPath) => ({
	PI_TINY_BOSS_MODEL_DIR: undefined,
	LAYA_MODEL_DIR: undefined,
	PI_TINY_BOSS_STATE_DIR: stateDirPath,
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

/** Write the structured record a real fetch leaves behind. */
function writeRecord(statePath, over = {}) {
	mkdirSync(statePath, { recursive: true });
	const record = {
		dir: join(statePath, "bundle"),
		files: ["laya.onnx", "laya.onnx.data", "laya_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"],
		layout: defaultLayout(),
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
			assert.equal(status.length, BUNDLE_FILES.length);
			assert.equal(status.every((s) => !s.present), true);
		});
	} finally {
		cleanup();
	}
});

test("a half-downloaded bundle is not a cache hit either", async () => {
	const { dir, cleanup } = tempDir();
	try {
		await withEnv({ ...emptyState(dir), PI_TINY_BOSS_MODEL_DIR: dir }, async () => {
			// Four of five files present: the exact shape an interrupted fetch
			// would leave if the library did not rename atomically.
			for (const file of BUNDLE_FILES.slice(0, -1)) writeFile(file, dir);
			assert.equal(await assetsReady(), false);
			assert.equal((await assetStatus()).filter((s) => s.present).length, BUNDLE_FILES.length - 1);
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
			assert.equal(await cacheBytes(), BUNDLE_FILES.length * 4);
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
