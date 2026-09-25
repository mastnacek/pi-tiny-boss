import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BUNDLE_FILES,
	DEFAULT_REPO,
	bundleDirFor,
	defaultLayout,
	describeLayout,
	layaCacheDir,
	mirroredBundleDir,
} from "../src/slices/engine/layout.js";

/**
 * The layout mirror.
 *
 * `@receptron/laya` owns this rule. The plugin reimplements it because importing
 * the package loads `onnxruntime-node`, and the offline gate must run before
 * anything can load. A mirror that is never compared to the original is a
 * liability, so the last test in this file cross-checks it against the library
 * itself whenever the package is loadable.
 */

/** A layout with everything explicit, so a test never reads the ambient env. */
const layout = (over = {}) => ({
	cacheDir: join("C", "cache", "receptron-laya"),
	repo: "owner/name",
	revision: "main",
	subfolder: null,
	...over,
});

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

test("the repo's slash becomes a doubled dash, so one repo is one cache directory", () => {
	assert.equal(
		bundleDirFor(layout({ repo: "receptron/laya-onnx" })),
		join("C", "cache", "receptron-laya", "receptron--laya-onnx", "main"),
	);
});

test("a subfolder becomes a path segment inside the revision directory", () => {
	assert.equal(
		bundleDirFor(layout({ subfolder: "typed-decisions" })),
		join("C", "cache", "receptron-laya", "owner--name", "main", "typed-decisions"),
	);
	// The library appends a trailing slash and path.join drops it; nesting must
	// survive, which is the case its own README does not show.
	assert.equal(
		bundleDirFor(layout({ subfolder: "nested/deep" })),
		join("C", "cache", "receptron-laya", "owner--name", "main", "nested", "deep"),
	);
});

test("surrounding slashes in a subfolder are stripped, not treated as a root", () => {
	assert.equal(
		bundleDirFor(layout({ subfolder: "/typed-decisions/" })),
		bundleDirFor(layout({ subfolder: "typed-decisions" })),
	);
});

test("no subfolder means the repo root, which is all upstream publishes today", () => {
	const dir = bundleDirFor(layout({ subfolder: null }));
	assert.equal(dir, join("C", "cache", "receptron-laya", "owner--name", "main"));
	// The library appends a separator to the string it returns. The mirror must not,
	// so that one directory has one spelling: the record keeps what the library
	// returned and `path.resolve` in Laya.load makes the two equivalent.
	for (const candidate of [dir, bundleDirFor(layout({ subfolder: "typed-decisions" }))]) {
		assert.equal(candidate.at(-1) === "/" || candidate.at(-1) === "\\", false, `trailing separator in ${candidate}`);
	}
});

test("PI_TINY_BOSS_SUBFOLDER selects a checkpoint, and blank values mean the root", async () => {
	await withEnv({ PI_TINY_BOSS_SUBFOLDER: "typed-decisions", LAYA_CACHE: join("C", "c") }, () => {
		assert.equal(defaultLayout().subfolder, "typed-decisions");
	});
	await withEnv({ PI_TINY_BOSS_SUBFOLDER: "/typed-decisions/", LAYA_CACHE: join("C", "c") }, () => {
		assert.equal(defaultLayout().subfolder, "typed-decisions");
	});
	for (const blank of [undefined, "", "   ", "/"]) {
		await withEnv({ PI_TINY_BOSS_SUBFOLDER: blank, LAYA_CACHE: join("C", "c") }, () => {
			assert.equal(defaultLayout().subfolder, null, `${JSON.stringify(blank)} must mean the repo root`);
		});
	}
});

test("LAYA_CACHE and XDG_CACHE_HOME place the cache root", async () => {
	await withEnv({ LAYA_CACHE: join("X", "lc"), XDG_CACHE_HOME: join("X", "xdg") }, () => {
		assert.equal(layaCacheDir(), join("X", "lc"), "the library's own variable wins");
	});
	await withEnv({ LAYA_CACHE: undefined, XDG_CACHE_HOME: join("X", "xdg") }, () => {
		assert.equal(layaCacheDir(), join("X", "xdg", "receptron-laya"));
	});
});

test("the mirrored default is the library's layout with the library's constants", () => {
	const dir = mirroredBundleDir();
	assert.ok(dir.includes("receptron--laya-onnx"), `unexpected repo segment: ${dir}`);
	assert.ok(dir.endsWith(join("main")), `unexpected revision segment: ${dir}`);
	assert.ok(dir.startsWith(layaCacheDir()), "the mirror lives under the library's cache");
});

test("describeLayout reports the checkpoint, not just a path", () => {
	assert.equal(describeLayout(layout()), "owner/name@main");
	assert.equal(describeLayout(layout({ subfolder: "multilingual" })), "owner/name/multilingual@main");
});

test("the bundled constants are the documented English checkpoint", () => {
	assert.equal(DEFAULT_REPO, "receptron/laya-onnx");
	assert.deepEqual([...BUNDLE_FILES], [
		"laya.onnx",
		"laya.onnx.data",
		"laya_config.json",
		"tokenizer/tokenizer.json",
		"tokenizer/tokenizer_config.json",
	]);
});

// --- cross-check against the library -------------------------------------
//
// The test above asserts the mirror against itself. This one asserts it against
// `@receptron/laya`, and is the reason the mirror is allowed to exist. It skips
// rather than fails when the native binding cannot be loaded, because the plugin
// is deliberately designed to keep working — and keep its suite green — on a
// machine where `onnxruntime-node` is broken.

test("the mirror equals the library's own constants and cache root", async (t) => {
	let lib;
	try {
		lib = await import("@receptron/laya");
	} catch (error) {
		t.skip(`@receptron/laya is not loadable here: ${error instanceof Error ? error.message : error}`);
		return;
	}

	assert.equal(DEFAULT_REPO, lib.DEFAULT_REPO, "repo drift would point the gate at another checkpoint");
	assert.deepEqual([...BUNDLE_FILES], [...lib.BUNDLE_FILES], "file-list drift would report MISSING forever");

	const dir = mkdtempSync(join(tmpdir(), "tiny-boss-layout-"));
	try {
		for (const env of [
			{ LAYA_CACHE: undefined, XDG_CACHE_HOME: undefined },
			{ LAYA_CACHE: undefined, XDG_CACHE_HOME: dir },
			{ LAYA_CACHE: dir, XDG_CACHE_HOME: dir },
		]) {
			await withEnv(env, () => {
				assert.equal(
					layaCacheDir(),
					lib.defaultCacheDir(),
					`cache root drift under ${JSON.stringify(env)}`,
				);
			});
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
