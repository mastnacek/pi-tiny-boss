import test from "node:test";
import assert from "node:assert/strict";

import { registerInputHook, drainInputHook, shouldPlan } from "../src/slices/hook/index.js";
import { createInitialState, recordFailure } from "../src/shared/state.js";

/** Minimal stand-in for ExtensionAPI that captures the input handler. */
function fakePi() {
	const handlers = {};
	return {
		pi: {
			on(event, handler) {
				handlers[event] = handler;
				return () => {
					delete handlers[event];
				};
			},
		},
		fire: (name, event, ctx) => handlers[name](event, ctx),
		has: (name) => Boolean(handlers[name]),
	};
}

const ctx = { hasUI: false };
const LONG = "why does the sidebar leak listeners on every reload of the extension?";

test("shouldPlan rejects short prompts and slash commands", () => {
	assert.equal(shouldPlan("ok"), false);
	assert.equal(shouldPlan("   "), false);
	assert.equal(shouldPlan("/tiny-boss status"), false);
	assert.equal(shouldPlan(LONG), true);
});

test("a plan rewrites the prompt with action=transform", async () => {
	const { pi, fire } = fakePi();
	const state = createInitialState();
	registerInputHook(pi, state, {
		plan: async () => ({ text: "PLAN\n\n" + LONG, stepCount: 2, elapsedMs: 7 }),
	});

	const result = await fire("input", { type: "input", text: LONG, source: "interactive" }, ctx);
	assert.equal(result.action, "transform");
	assert.ok(result.text.startsWith("PLAN"));
	assert.ok(result.text.includes(LONG));
});

test("no plan means the prompt passes through untouched", async () => {
	const { pi, fire } = fakePi();
	registerInputHook(pi, createInitialState(), { plan: async () => null });

	const result = await fire("input", { type: "input", text: LONG, source: "interactive" }, ctx);
	assert.equal(result.action, "continue");
	assert.equal(result.text, undefined);
});

test("a throwing planner never escapes the hook", async () => {
	const { pi, fire } = fakePi();
	registerInputHook(pi, createInitialState(), {
		plan: async () => {
			throw new Error("WASM exploded");
		},
	});

	const result = await fire("input", { type: "input", text: LONG, source: "interactive" }, ctx);
	assert.equal(result.action, "continue");
});

test("a disabled plugin does not plan", async () => {
	const { pi, fire } = fakePi();
	const state = createInitialState();
	state.enabled = false;
	let called = 0;
	registerInputHook(pi, state, {
		plan: async () => {
			called += 1;
			return null;
		},
	});

	const result = await fire("input", { type: "input", text: LONG, source: "interactive" }, ctx);
	assert.equal(result.action, "continue");
	assert.equal(called, 0);
});

test("a latched failure is not retried on later prompts", async () => {
	const { pi, fire } = fakePi();
	const state = createInitialState();
	recordFailure(state, "assets-missing", "cache empty");
	let called = 0;
	registerInputHook(pi, state, {
		plan: async () => {
			called += 1;
			return { text: "x", stepCount: 1, elapsedMs: 1 };
		},
	});

	for (let i = 0; i < 5; i += 1) {
		const result = await fire("input", { type: "input", text: LONG, source: "interactive" }, ctx);
		assert.equal(result.action, "continue");
	}
	assert.equal(called, 0, "the planner must not be called again after latching");
});

test("extension-sourced input is never re-planned", async () => {
	const { pi, fire } = fakePi();
	let called = 0;
	registerInputHook(pi, createInitialState(), {
		plan: async () => {
			called += 1;
			return { text: "x", stepCount: 1, elapsedMs: 1 };
		},
	});

	const result = await fire("input", { type: "input", text: LONG, source: "extension" }, ctx);
	assert.equal(result.action, "continue");
	assert.equal(called, 0);
});

test("the hook subscribes to the input event and drains cleanly", () => {
	const { pi, has } = fakePi();
	registerInputHook(pi, createInitialState(), { plan: async () => null });
	assert.equal(has("input"), true);
	drainInputHook();
	assert.equal(has("input"), false, "draining must remove the listener");
});
