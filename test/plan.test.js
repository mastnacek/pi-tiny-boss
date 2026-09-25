import test from "node:test";
import assert from "node:assert/strict";

import {
	groupTools,
	MAX_STEPS,
	toolKey,
	gateKey,
	FIRST_QUESTION,
} from "../src/shared/decision-schema.js";
import { manifestTools } from "../src/shared/manifest.js";
import {
	assembleSteps,
	gateOutcome,
	renderDirective,
	MIN_TOOL_PROBABILITY,
} from "../src/slices/planner/plan.js";
import { formatGroups, planPrompt } from "../src/slices/planner/index.js";
import { createInitialState } from "../src/shared/state.js";

// --- fakes ----------------------------------------------------------------

/** A gate answer: `B` means "this need is present". */
const gate = (yes, p = yes ? 0.9 : 0.05) => ({
	choice: yes ? "B" : "A",
	probabilities: { A: Math.round((1 - p) * 1e4) / 1e4, B: Math.round(p * 1e4) / 1e4 },
	confidence: 0.8,
});

/** A tool answer inside one bucket. */
const pick = (name, p = 0.7) => ({ choice: name, probabilities: { [name]: p }, confidence: 0.5 });

/** A two-pass fake engine. `map` is keyed by question key. */
function fakeEngine(map) {
	const calls = [];
	return {
		calls,
		async ask(state, questions) {
			const keys = Object.keys(questions);
			calls.push({ state, keys });
			const out = {};
			for (const key of keys) {
				const answer = map[key];
				if (!answer) throw new Error(`fake engine has no answer for ${key}`);
				out[key] = answer;
			}
			return out;
		},
		async close() {},
	};
}

const groups = groupTools(manifestTools());

// --- gate reading ---------------------------------------------------------

test("a bucket passes only when it is answered yes with real probability mass", () => {
	const answers = Object.fromEntries(groups.map((g) => [gateKey(g.category), gate(g.category === "read")]));
	const outcome = gateOutcome(groups, answers);
	assert.deepEqual(outcome.order, ["read"]);
	assert.equal(outcome.gates.filter((g) => g.passed).length, 1);
});

test("a reply that names B while putting its mass on A does not pass", () => {
	// Malformed, but the floor must not trust the label alone.
	assert.equal(gateOutcome(groups, { [gateKey("read")]: { choice: "B", probabilities: { A: 0.8, B: 0.2 }, confidence: 0.4 } }).order.length, 0);
});

test("the first answer orders the plan when it survived its own gate", () => {
	const answers = {
		[FIRST_QUESTION]: pick("execute", 0.9),
		[gateKey("search")]: gate(true),
		[gateKey("execute")]: gate(true),
		[gateKey("read")]: gate(false),
	};
	assert.deepEqual(gateOutcome(groups, answers).order, ["execute", "search"]);
});

test("a first answer that failed its own gate is demoted, not honoured", () => {
	const answers = {
		[FIRST_QUESTION]: pick("vcs", 0.9),
		[gateKey("vcs")]: gate(false),
		[gateKey("search")]: gate(true),
		[gateKey("edit")]: gate(true),
	};
	const outcome = gateOutcome(groups, answers);
	assert.deepEqual(outcome.order, ["search", "edit"], "the gate is the more specific question");
	assert.equal(outcome.firstAnswered, "vcs", "the answer is still reported");
});

test("no gate passing means no order at all", () => {
	const answers = {
		[FIRST_QUESTION]: pick("search", 0.9),
		...Object.fromEntries(groups.map((g) => [gateKey(g.category), gate(false)])),
	};
	assert.deepEqual(gateOutcome(groups, answers).order, []);
});

test("a missing answer is not a crash and not a pass", () => {
	const outcome = gateOutcome(groups, {});
	assert.deepEqual(outcome.order, []);
	assert.equal(outcome.gates.every((g) => g.probability === 0), true);
});

// --- assembly -------------------------------------------------------------

test("steps follow the gate order and carry their probabilities", () => {
	const answers = {
		[gateKey("execute")]: gate(true, 0.88),
		[gateKey("search")]: gate(true, 0.71),
		[toolKey("execute")]: pick("bash", 0.62),
		[toolKey("search")]: pick("grep", 0.55),
	};
	const steps = assembleSteps(groups, ["execute", "search"], answers);
	assert.deepEqual(steps.map((s) => s.tool), ["bash", "grep"]);
	assert.deepEqual(steps.map((s) => s.category), ["execute", "search"]);
	assert.equal(steps[0].gateProbability, 0.88);
	assert.equal(steps[0].toolProbability, 0.62);
});

test("a diffuse tool choice is dropped rather than forwarded", () => {
	const answers = {
		[gateKey("search")]: gate(true),
		[toolKey("search")]: { choice: "grep", probabilities: { grep: MIN_TOOL_PROBABILITY - 0.01 }, confidence: 0.05 },
	};
	assert.deepEqual(assembleSteps(groups, ["search"], answers), []);
});

test("a tool name outside its bucket is dropped, not forwarded", () => {
	const answers = {
		[gateKey("search")]: gate(true),
		[toolKey("search")]: pick("bash"),
	};
	assert.deepEqual(assembleSteps(groups, ["search"], answers), [], "bash does not compete in the search bucket");
});

test("a plan is capped at six steps", () => {
	const answers = {};
	const order = [];
	for (const group of groups) {
		answers[gateKey(group.category)] = gate(true);
		answers[toolKey(group.category)] = pick(group.tools[0].name);
		order.push(group.category);
	}
	const steps = assembleSteps(groups, order, answers);
	assert.equal(steps.length, Math.min(groups.length, MAX_STEPS));
	assert.ok(steps.length <= MAX_STEPS);
});

test("a detected binary keeps its bash translation and its example", () => {
	const withRg = groupTools(
		manifestTools([
			{
				name: "rg",
				description: "ripgrep",
				short: "regex search, gitignore-aware",
				category: "search",
				invokedAs: "bash",
				example: 'rg -n --type ts "pi.on\\(" .',
				source: "system",
			},
		]),
	);
	const answers = { [gateKey("search")]: gate(true), [toolKey("search")]: pick("rg") };
	const steps = assembleSteps(withRg, ["search"], answers);
	assert.equal(steps.length, 1);
	assert.equal(steps[0].invokedAs, "bash");

	const out = renderDirective(steps, "why do listeners leak?", { elapsedMs: 41, requested: 1 });
	assert.match(out, /1\. bash \{"command":"rg -n --type ts/);
	assert.match(out, /\(via rg, p=0\.7\)/);
});

// --- rendering ------------------------------------------------------------

test("the directive keeps the user prompt intact and last", () => {
	const answers = { [gateKey("search")]: gate(true), [toolKey("search")]: pick("grep") };
	const steps = assembleSteps(groups, ["search"], answers);
	const prompt = "why is the sidebar leaking listeners on reload?";
	const out = renderDirective(steps, prompt, { elapsedMs: 12, requested: 1 });

	assert.ok(out.includes(prompt), "the original prompt must survive verbatim");
	assert.ok(out.includes("<tiny-boss-plan>"));
	assert.ok(out.includes("</tiny-boss-plan>"));
	assert.ok(out.trimEnd().endsWith(prompt), "the prompt must come after the plan");
});

test("the directive states the model's real limits", () => {
	const answers = { [gateKey("search")]: gate(true), [toolKey("search")]: pick("grep") };
	const out = renderDirective(assembleSteps(groups, ["search"], answers), "do the thing", {
		elapsedMs: 30,
		requested: 1,
	});
	assert.match(out, /raw and not temperature-fitted/i, "unfitted calibration must be stated");
	assert.match(out, /it does not read files/i, "the model cannot see the repo and must say so");
	assert.match(out, /skip it and say why/i, "the plan is advisory, not an order");
	assert.match(out, /2 forward passes/, "the cost is reported, not implied");
});

test("formatGroups names every bucket and which tools are in it", () => {
	const text = formatGroups(extras());
	assert.match(text, /^search\s+\(/m);
	for (const group of groups) assert.ok(text.includes(group.category), `${group.category} is missing`);
	assert.match(text, /bash/, "the execute bucket is listed");
});

/** A small extra manifest for the formatting test. */
function extras() {
	return [{ name: "rg", description: "ripgrep", category: "search", invokedAs: "bash", example: "rg x" }];
}

// --- planner degradation --------------------------------------------------

test("a throwing engine yields no plan, never an exception", async () => {
	const state = createInitialState();
	const engine = {
		ask: async () => {
			throw new Error("systemOne: unexpected model outputs");
		},
		close: async () => {},
	};
	assert.equal(await planPrompt(state, { prompt: "run the tests", engine }), null);
	assert.equal(state.planCount, 0, "a failure is not a plan");
	assert.equal(state.lastPlan, null);
});

test("an engine slower than the budget yields no plan", async () => {
	const state = createInitialState();
	const engine = {
		ask: () => new Promise(() => {}), // never settles
		close: async () => {},
	};
	assert.equal(await planPrompt(state, { prompt: "run the tests", engine, timeoutMs: 20 }), null);
});

test("no gate passing ends the plan after one pass", async () => {
	const state = createInitialState();
	const map = {
		[FIRST_QUESTION]: pick("search"),
		...Object.fromEntries(groups.map((g) => [gateKey(g.category), gate(false)])),
	};
	const engine = fakeEngine(map);
	assert.equal(await planPrompt(state, { prompt: "what is the capital of France?", engine }), null);
	assert.equal(engine.calls.length, 1, "the second pass must not run when nothing was needed");
});

test("a two-pass plan is recorded on state, with both passes billed", async () => {
	const state = createInitialState();
	const engine = fakeEngine({
		[FIRST_QUESTION]: pick("execute"),
		...Object.fromEntries(groups.map((g) => [gateKey(g.category), gate(g.category === "execute")])),
		[toolKey("execute")]: pick("bash"),
	});

	const result = await planPrompt(state, { prompt: "run the test suite", engine });
	assert.ok(result, "a usable plan must survive");
	assert.deepEqual(result.steps.map((s) => s.tool), ["bash"]);
	assert.equal(engine.calls.length, 2, "one forward pass per stage");
	assert.equal(state.planCount, 1);
	assert.equal(state.degraded, null);
	assert.ok(state.lastPlan, "the plan is kept for /tiny-boss status");
	assert.ok(state.lastPlan.raw.includes("second"), "both answer sets are kept for debugging");
});

test("both passes receive the prompt as Laya's state", async () => {
	const state = createInitialState();
	const engine = fakeEngine({
		[FIRST_QUESTION]: pick("read"),
		...Object.fromEntries(groups.map((g) => [gateKey(g.category), gate(g.category === "read")])),
		[toolKey("read")]: pick("read"),
	});
	await planPrompt(state, { prompt: "explain this file", engine });
	assert.deepEqual(engine.calls.map((c) => c.state), ["explain this file", "explain this file"]);
});
