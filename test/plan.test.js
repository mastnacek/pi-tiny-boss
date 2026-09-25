import test from "node:test";
import assert from "node:assert/strict";

import { parsePlan, renderDirective, buildToolsJson } from "../src/slices/planner/plan.js";
import { manifestTools } from "../src/shared/manifest.js";

const tools = manifestTools();

/** Wrap a tool list the way needle3 wraps it, in a function_calls envelope. */
const envelope = (list) =>
	JSON.stringify({ function_calls: [{ name: "emit_plan", arguments: { tools: list } }] });

test("a well-formed plan is parsed in order", () => {
	const steps = parsePlan(envelope(["grep", "read", "edit"]), tools);
	assert.equal(steps.length, 3);
	assert.deepEqual(steps.map((s) => s.tool), ["grep", "read", "edit"]);
});

test("the plan carries no arguments, only tool names", () => {
	const steps = parsePlan(envelope(["grep"]), tools);
	assert.deepEqual(steps[0].args, {}, "needle3 names tools; the model supplies arguments");
	assert.equal(steps[0].why, "");
});

test("a tool outside the manifest is dropped, not passed through", () => {
	const steps = parsePlan(envelope(["rm", "read", "sudo"]), tools);
	assert.deepEqual(steps.map((s) => s.tool), ["read"]);
});

test("a fully unknown plan yields no steps rather than a partial one", () => {
	assert.deepEqual(parsePlan(envelope(["rm", "sudo"]), tools), []);
	assert.deepEqual(parsePlan(envelope([]), tools), []);
});

test("non-JSON output yields no plan instead of throwing", () => {
	assert.deepEqual(parsePlan("I think you should grep first", tools), []);
	assert.deepEqual(parsePlan("", tools), []);
	assert.deepEqual(parsePlan("{}", tools), []);
	assert.deepEqual(parsePlan("[]", tools), []);
	assert.deepEqual(parsePlan(JSON.stringify({ function_calls: [] }), tools), []);
});

test("suppressed_calls are read as well as function_calls", () => {
	// needle3 routes schema-valid output to suppressed_calls; reading only
	// function_calls would report "no plan" for output that is really there.
	const raw = JSON.stringify({
		function_calls: [],
		suppressed_calls: [{ name: "emit_plan", arguments: { tools: ["bash"] } }],
	});
	assert.deepEqual(parsePlan(raw, tools).map((s) => s.tool), ["bash"]);
});

test("function_calls wins when both envelopes are present", () => {
	const raw = JSON.stringify({
		function_calls: [{ name: "emit_plan", arguments: { tools: ["read"] } }],
		suppressed_calls: [{ name: "emit_plan", arguments: { tools: ["bash"] } }],
	});
	assert.deepEqual(parsePlan(raw, tools).map((s) => s.tool), ["read"]);
});

test("a plan is capped at six steps", () => {
	const steps = parsePlan(envelope(["read", "read", "read", "read", "read", "read", "read", "bash"]), tools);
	assert.equal(steps.length, 6);
});

test("a non-string entry is skipped, not coerced", () => {
	const steps = parsePlan(envelope(["read", 42, null, "bash"]), tools);
	assert.deepEqual(steps.map((s) => s.tool), ["read", "bash"]);
});

test("the directive keeps the user prompt intact and last", () => {
	const steps = parsePlan(envelope(["grep"]), tools);
	const prompt = "why is the sidebar leaking listeners on reload?";
	const out = renderDirective(steps, prompt);

	assert.ok(out.includes(prompt), "the original prompt must survive verbatim");
	assert.ok(out.includes("<tiny-boss-plan>"), "the block must be delimited");
	assert.ok(out.includes("</tiny-boss-plan>"));
	assert.ok(out.includes("1. grep"), "steps must be numbered");
	assert.ok(out.trimEnd().endsWith(prompt), "the prompt must come after the plan");
});

test("the directive tells the model it may overrule the plan", () => {
	const out = renderDirective(parsePlan(envelope(["read"]), tools), "do the thing");
	assert.match(out, /weak hint, not an order/i);
	assert.match(out, /frequently wrong/i);
});

test("the init manifest is one flat tool: an array of names", () => {
	const manifest = JSON.parse(buildToolsJson(tools));
	assert.equal(manifest.length, 1);
	assert.equal(manifest[0].name, "emit_plan");
	const list = manifest[0].parameters.properties.tools;
	assert.equal(list.type, "array");
	assert.deepEqual(list.items.enum, tools.map((t) => t.name));
	assert.deepEqual(manifest[0].parameters.required, ["tools"]);
	// The flat shape is deliberate: the nested object form with free-text `why`
	// is what needle3 answers with an empty array to.
	assert.equal(list.items.type, "string");
});

// --- planner degradation -------------------------------------------------
// 59% of real needle3 replies are `error_code: "truncated"`, which the engine
// surfaces as a throw. That is the dominant path, so it gets locked down here.

import { planPrompt } from "../src/slices/planner/index.js";
import { createInitialState } from "../src/shared/state.js";

test("a throwing engine yields no plan, never an exception", async () => {
	const state = createInitialState();
	const engine = {
		plan: async () => {
			throw new Error("needle_complete: tool call truncated: token budget exhausted (truncated)");
		},
		close: async () => {},
	};
	const result = await planPrompt(state, { prompt: "run the tests", engine });
	assert.equal(result, null, "the prompt must pass through untouched");
	assert.equal(state.planCount, 0, "a failure is not a plan");
	assert.equal(state.lastPlan, null);
});

test("an engine that returns unusable JSON yields no plan", async () => {
	const state = createInitialState();
	const engine = {
		plan: async () => ({ steps: [], raw: "not json at all" }),
		close: async () => {},
	};
	assert.equal(await planPrompt(state, { prompt: "run the tests", engine }), null);
	assert.equal(state.planCount, 0);
});

test("an engine slower than the budget yields no plan", async () => {
	const state = createInitialState();
	const engine = {
		plan: () => new Promise(() => {}), // never settles
		close: async () => {},
	};
	const result = await planPrompt(state, { prompt: "run the tests", engine, timeoutMs: 20 });
	assert.equal(result, null, "a hung engine must not block the prompt path");
});

test("a usable plan from the engine is recorded on state", async () => {
	const state = createInitialState();
	const engine = {
		plan: async () => ({
			steps: [],
			raw: JSON.stringify({ function_calls: [{ name: "emit_plan", arguments: { tools: ["bash"] } }] }),
		}),
		close: async () => {},
	};
	const result = await planPrompt(state, { prompt: "run the tests", engine });
	assert.ok(result, "a parseable plan must survive");
	assert.equal(result.steps[0].tool, "bash");
	assert.equal(state.planCount, 1);
	assert.ok(state.lastPlan, "the plan is kept for /tiny-boss status");
});
