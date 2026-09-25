import test from "node:test";
import assert from "node:assert/strict";

import { modeLabel } from "../src/slices/commands/index.js";
import { createInitialState, recordPlan, recordFailure } from "../src/shared/state.js";
import { manifestTools, allowedToolNames } from "../src/shared/manifest.js";

test("toggles carry the live state marker, plain rows do not", () => {
	const on = createInitialState();
	assert.equal(modeLabel("on", on), "on ✓");
	assert.equal(modeLabel("off", on), "off");
	assert.equal(modeLabel("status", on), "status");
	assert.equal(modeLabel("fetch", on), "fetch");
	assert.equal(modeLabel("plan", on), "plan");

	const off = createInitialState();
	off.enabled = false;
	assert.equal(modeLabel("off", off), "off ✓");
	assert.equal(modeLabel("on", off), "on");
});

test("the manifest stays short and starts with the no-tool escape hatch", () => {
	const tools = manifestTools();
	assert.ok(tools.length <= 8, "needle3 degrades on long manifests");
	assert.equal(tools[0].name, "none");
	for (const tool of tools) {
		assert.ok(tool.description.length > 10, `${tool.name} needs a usable description`);
		assert.ok(tool.description.length < 200, `${tool.name} description must stay terse`);
	}
});

test("the allowed-name set matches the manifest exactly", () => {
	const allowed = allowedToolNames();
	assert.deepEqual(
		[...allowed].sort(),
		manifestTools().map((t) => t.name).sort(),
	);
	assert.ok(allowed.has("bash"));
	assert.ok(!allowed.has("task"), "delegating tools are out of scope for a 121M planner");
});

test("a successful plan clears any latched degradation", () => {
	const state = createInitialState();
	recordFailure(state, "engine-error", "boom");
	assert.equal(state.degraded, "engine-error");

	recordPlan(state, { steps: [{ tool: "read", args: {}, why: "look" }], raw: "{}", elapsedMs: 3 });
	assert.equal(state.degraded, null);
	assert.equal(state.lastError, null);
	assert.equal(state.planCount, 1);
	assert.equal(state.lastPlan.steps.length, 1);
});

test("recordFailure latches without touching the counters", () => {
	const state = createInitialState();
	recordPlan(state, { steps: [], raw: "{}", elapsedMs: 1 });
	recordFailure(state, "assets-missing", "cache empty");
	assert.equal(state.degraded, "assets-missing");
	assert.equal(state.lastError, "cache empty");
	assert.equal(state.planCount, 1, "a failure is not a plan");
});
