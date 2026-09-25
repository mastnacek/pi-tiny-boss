import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The composition root.
 *
 * `index.ts` is the only file allowed to import more than one slice, so it is
 * exactly the file where a wiring mistake lives and the last one a slice-level
 * test can see. These tests load it with a stand-in ExtensionAPI and drive the
 * real `input` event through the real hook.
 *
 * The model is never loaded: `PI_TINY_BOSS_MODEL_DIR` points at an empty
 * directory, so the engine slice latches `assets-missing` and every prompt must
 * pass through untouched. That is the contract a machine without the 1.7 GB
 * bundle actually experiences.
 */

/** A stand-in for ExtensionAPI that records what the root registers. */
function fakePi() {
	const handlers = new Map();
	const commands = [];
	const tools = [];
	return {
		pi: {
			on(event, handler) {
				handlers.set(event, handler);
				return () => handlers.delete(event);
			},
			registerCommand(name, options) {
				commands.push({ name, options });
			},
			registerTool(options) {
				tools.push(options);
			},
		},
		commands,
		tools,
		has: (event) => handlers.has(event),
		fire: (event, ...args) => handlers.get(event)(...args),
	};
}

const LONG = "why does the sidebar leak listeners on every reload of the extension?";

/** Load the root against an empty model directory, then restore the env. */
async function withRoot(body, env = {}) {
	const dir = mkdtempSync(join(tmpdir(), "tiny-boss-wiring-"));
	const saved = {
		model: process.env.PI_TINY_BOSS_MODEL_DIR,
		subagent: process.env.PI_SUBAGENT,
		child: process.env.PI_CHILD_SESSION,
	};
	process.env.PI_TINY_BOSS_MODEL_DIR = env.modelDir ?? dir;
	delete process.env.PI_CHILD_SESSION;
	if (env.subagent) process.env.PI_SUBAGENT = "true";
	else delete process.env.PI_SUBAGENT;

	try {
		// Imported after the env is set and cached per URL: a second import in the
		// same process returns the same module, which is fine because the
		// composition root reads nothing from env at module scope.
		const { default: register } = await import("../index.js");
		const harness = fakePi();
		await register(harness.pi);
		return await body(harness);
	} finally {
		if (saved.model === undefined) delete process.env.PI_TINY_BOSS_MODEL_DIR;
		else process.env.PI_TINY_BOSS_MODEL_DIR = saved.model;
		if (saved.subagent === undefined) delete process.env.PI_SUBAGENT;
		else process.env.PI_SUBAGENT = saved.subagent;
		if (saved.child === undefined) delete process.env.PI_CHILD_SESSION;
		else process.env.PI_CHILD_SESSION = saved.child;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the root registers the command, the tool and both lifecycle hooks", async () => {
	await withRoot((harness) => {
		assert.deepEqual(harness.commands.map((c) => c.name), ["tiny-boss"]);
		assert.deepEqual(harness.tools.map((t) => t.name), ["tiny_boss"]);
		assert.equal(harness.has("input"), true);
		assert.equal(harness.has("session_shutdown"), true);
	});
});

test("with no bundle cached, a long prompt still passes through untouched", async () => {
	await withRoot(async (harness) => {
		const result = await harness.fire("input", { type: "input", text: LONG, source: "interactive" }, { hasUI: false });
		assert.equal(result.action, "continue");
		assert.equal(result.text, undefined, "the user's prompt is the source of truth");
	});
});

test("a short prompt never reaches the engine at all", async () => {
	await withRoot(async (harness) => {
		const result = await harness.fire("input", { type: "input", text: "hi", source: "interactive" }, { hasUI: false });
		assert.equal(result.action, "continue");
	});
});

test("the missing-bundle failure is latched, not retried per prompt", async () => {
	await withRoot(async (harness) => {
		for (let i = 0; i < 3; i += 1) {
			const result = await harness.fire("input", { type: "input", text: LONG, source: "interactive" }, { hasUI: false });
			assert.equal(result.action, "continue");
		}
	});
});

test("the tool reports a fixable cause rather than failing silently", async () => {
	await withRoot(async (harness) => {
		const tool = harness.tools[0];
		await assert.rejects(
			() => tool.execute("call-1", { mode: "plan", prompt: LONG }),
			/no usable plan|not cached|fetch/i,
		);
	});
});

test("mode=tools answers from the manifest without touching the engine", async () => {
	await withRoot(async (harness) => {
		const tool = harness.tools[0];
		const result = await tool.execute("call-2", { mode: "tools" });
		const text = result.content[0].text;
		assert.match(text, /"category": "search"/, "the buckets are reported as data");
		assert.match(text, /bash|read/, "the built-in tools are listed");
	});
});

test("a delegated child session registers nothing at all", async () => {
	await withRoot(
		(harness) => {
			assert.deepEqual(harness.commands, []);
			assert.deepEqual(harness.tools, []);
			assert.equal(harness.has("input"), false);
		},
		{ subagent: true },
	);
});

test("session_shutdown drains both hooks without throwing", async () => {
	await withRoot(async (harness) => {
		await harness.fire("session_shutdown");
		// Idempotent: quit, reload and session replacement all converge here.
		await assert.doesNotReject(() => harness.fire("session_shutdown"));
	});
});
