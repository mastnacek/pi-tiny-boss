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
	assert.equal(modeLabel("warm", on), "warm");
	assert.equal(modeLabel("plan", on), "plan");

	const off = createInitialState();
	off.enabled = false;
	assert.equal(modeLabel("off", off), "off ✓");
	assert.equal(modeLabel("on", off), "on");
});

test("the manifest is small, bucketed and describes every tool", () => {
	const tools = manifestTools();
	// The list stays short on purpose: Laya's own model card puts the reliability
	// ceiling near twenty options, and the decision schema splits it into buckets.
	assert.ok(tools.length <= 8, "the built-in manifest must stay short");
	assert.ok(!tools.some((t) => t.name === "none"), "Laya's per-bucket gates replaced the `none` tool");
	for (const tool of tools) {
		assert.ok(tool.description.length > 10, `${tool.name} needs a usable description`);
		assert.ok(tool.description.length < 200, `${tool.name} description must stay terse`);
		assert.ok(tool.category, `${tool.name} needs a bucket`);
	}
});

test("the allowed-name set matches the manifest exactly", () => {
	const allowed = allowedToolNames();
	assert.deepEqual(
		[...allowed].sort(),
		manifestTools().map((t) => t.name).sort(),
	);
	assert.ok(allowed.has("bash"));
	assert.ok(!allowed.has("none"), "a tool named `none` is what the gates replaced");
	assert.ok(!allowed.has("task"), "delegating tools are out of scope for a local planner");
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
