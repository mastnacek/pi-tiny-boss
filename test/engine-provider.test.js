import test from "node:test";
import assert from "node:assert/strict";
import { cpus } from "node:os";

import {
	parseProvider,
	providerOrder,
	recommendedThreads,
	threadCount,
} from "../src/slices/engine/laya.js";

/**
 * Provider and thread policy.
 *
 * Importing this module does not load `onnxruntime-node` — the package is
 * imported dynamically inside `createLayaEngine` — so this whole file runs
 * without a native binding, which is the same property that lets the extension
 * load on a machine where the binding is broken.
 */

/** Run `body` with env overrides in place, then restore them exactly. */
function withEnv(vars, body) {
	const saved = {};
	for (const [key, value] of Object.entries(vars)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return body();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("auto prefers the GPU and keeps the CPU as a fallback", () => {
	assert.deepEqual(providerOrder("auto"), ["webgpu", "cpu"]);
	assert.deepEqual(providerOrder("cpu"), ["cpu"]);
	assert.deepEqual(providerOrder("webgpu"), ["webgpu"]);
	assert.deepEqual(providerOrder("dml"), ["dml"]);
});

test("dml is never in the automatic chain", () => {
	// It is bundled and it is a GPU provider on paper, but it builds a session and
	// then dies on the first inference (Reshape node, MLOperatorAuthorImpl
	// 0x80070057). Loading is not evidence that a provider works.
	assert.equal(providerOrder("auto").includes("dml"), false);
});

test("an unknown or absent PI_TINY_BOSS_EP means auto, not a crash", () => {
	// Including names that a user might reasonably try and that ONNX does not
	// publish for Node at all: cuda and tensorrt.
	for (const value of [undefined, "", "   ", "cuda", "tensorrt", "CPU-x"]) {
		assert.equal(parseProvider(value), "auto", `unexpected for ${JSON.stringify(value)}`);
	}
	assert.equal(parseProvider(" cpu "), "cpu");
	assert.equal(parseProvider("WEBGPU"), "webgpu");
	assert.equal(parseProvider("Dml"), "dml");
});

test("the thread default reproduces the measured optimum and never uses every thread", () => {
	// Measured p50 for one plan on a 24C/32T i9-14900K: 4 threads 1131 ms,
	// 24 threads 578 ms, 32 threads 793 ms.
	assert.equal(recommendedThreads(32), 24, "the measured optimum");
	assert.ok(recommendedThreads(32) < 32, "all logical threads oversubscribed and lost 37%");
	assert.ok(recommendedThreads(4) >= 1, "a small machine must still get a usable worker");
	assert.equal(recommendedThreads(1), 1);
	assert.equal(recommendedThreads(0), 1);
	assert.equal(recommendedThreads(128), 32, "clamped");
	for (const logical of [1, 2, 4, 8, 16, 32, 64, 128]) {
		const threads = recommendedThreads(logical);
		assert.ok(threads >= 1 && threads <= 32, `${logical} -> ${threads}`);
		assert.ok(threads <= logical || logical === 1, `${logical} -> ${threads} over-subscribes a small machine`);
	}
});

test("PI_TINY_BOSS_THREADS overrides the policy", () => {
	withEnv({ PI_TINY_BOSS_THREADS: "3" }, () => assert.equal(threadCount(), 3));
	withEnv({ PI_TINY_BOSS_THREADS: "64" }, () => assert.equal(threadCount(), 64, "an explicit number is not clamped"));
	withEnv({ PI_TINY_BOSS_THREADS: undefined }, () =>
		assert.equal(threadCount(), recommendedThreads(cpus().length)),
	);
	// Garbage falls back to the policy rather than to zero threads, which ONNX
	// would reject or silently serialise.
	for (const bad of ["", "abc", "0", "-4", "1.5"]) {
		withEnv({ PI_TINY_BOSS_THREADS: bad }, () =>
			assert.equal(threadCount(), recommendedThreads(cpus().length), `unexpected for ${JSON.stringify(bad)}`),
		);
	}
});
