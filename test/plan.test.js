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
