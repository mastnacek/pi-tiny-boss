import test from "node:test";
import assert from "node:assert/strict";

import { parsePlan, renderDirective, buildToolsJson } from "../src/slices/planner/plan.js";
import { manifestTools } from "../src/shared/manifest.js";

const tools = manifestTools();

/** Wrap steps the way needle3 wraps them, in a function_calls envelope. */
const envelope = (steps) =>
	JSON.stringify({
		function_calls: [
			{ name: "emit_plan", arguments: { steps } },
		],
	});

test("a well-formed plan is parsed in order", () => {
	const raw = envelope([
		{ tool: "grep", args: { pattern: "on(" }, why: "find the listeners" },
		{ tool: "read", args: { path: "index.ts" }, why: "read the entry" },
	]);
	const steps = parsePlan(raw, tools);
	assert.equal(steps.length, 2);
	assert.equal(steps[0].tool, "grep");
	assert.equal(steps[1].tool, "read");
	assert.deepEqual(steps[0].args, { pattern: "on(" });
	assert.equal(steps[0].why, "find the listeners");
});

test("a tool outside the manifest is dropped, not passed through", () => {
	const raw = envelope([
		{ tool: "rm", args: {}, why: "destroy everything" },
		{ tool: "read", args: { path: "a.ts" }, why: "read it" },
	]);
	const steps = parsePlan(raw, tools);
	assert.equal(steps.length, 1);
	assert.equal(steps[0].tool, "read");
});

test("non-JSON output yields no plan instead of throwing", () => {
	assert.deepEqual(parsePlan("I think you should grep first", tools), []);
	assert.deepEqual(parsePlan("", tools), []);
	assert.deepEqual(parsePlan("{}", tools), []);
	assert.deepEqual(parsePlan("[]", tools), []);
	assert.deepEqual(parsePlan(JSON.stringify({ function_calls: [] }), tools), []);
});

test("a plan is capped at six steps", () => {
	const raw = envelope(
		Array.from({ length: 12 }, (_unused, i) => ({ tool: "read", args: { path: `${i}.ts` }, why: "s" })),
	);
	assert.equal(parsePlan(raw, tools).length, 6);
});

test("a missing args object becomes an empty object, not a crash", () => {
	const steps = parsePlan(envelope([{ tool: "ls", why: "look around" }]), tools);
	assert.equal(steps.length, 1);
	assert.deepEqual(steps[0].args, {});
});

test("an array-valued args is dropped rather than spread into a tool call", () => {
	const steps = parsePlan(envelope([{ tool: "ls", args: [1, 2], why: "look" }]), tools);
	assert.equal(steps.length, 1, "the step survives so the order is not lost");
	assert.deepEqual(steps[0].args, {}, "but the array must never become the arguments");
});

test("the directive keeps the user prompt intact and last", () => {
	const steps = parsePlan(envelope([{ tool: "grep", args: { pattern: "x" }, why: "find it" }]), tools);
	const prompt = "why is the sidebar leaking listeners on reload?";
	const out = renderDirective(steps, prompt);

	assert.ok(out.includes(prompt), "the original prompt must survive verbatim");
	assert.ok(out.includes("<tiny-boss-plan>"), "the block must be delimited");
	assert.ok(out.includes("</tiny-boss-plan>"));
	assert.ok(out.includes("1. grep"), "steps must be numbered");
	assert.ok(out.trimEnd().endsWith(prompt), "the prompt must come after the plan");
});

test("the directive tells the model it may overrule the plan", () => {
	const steps = parsePlan(envelope([{ tool: "read", why: "look" }]), tools);
	const out = renderDirective(steps, "do the thing");
	assert.match(out, /hint, not an order/i);
});

test("an over-long why is truncated so the block stays readable", () => {
	const long = "x".repeat(500);
	const steps = parsePlan(envelope([{ tool: "read", why: long }]), tools);
	assert.equal(steps[0].why.length, 240);
});

test("the init manifest is a single emit_plan tool with an ordered step list", () => {
	const manifest = JSON.parse(buildToolsJson(tools));
	assert.equal(manifest.length, 1);
	assert.equal(manifest[0].name, "emit_plan");
	const steps = manifest[0].parameters.properties.steps;
	assert.equal(steps.type, "array");
	assert.deepEqual(steps.items.properties.tool.enum, tools.map((t) => t.name));
	assert.deepEqual(steps.items.required, ["tool", "why"]);
});
