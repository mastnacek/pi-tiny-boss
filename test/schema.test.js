import test from "node:test";
import assert from "node:assert/strict";

import {

	groupTools,
	shortLabel,
	stageOneQuestions,
	stageTwoQuestions,
	toolKey,
	gateKey,
	FIRST_QUESTION,
} from "../src/shared/decision-schema.js";
import { manifestTools } from "../src/shared/manifest.js";

const groups = groupTools(manifestTools());

// --- schema ---------------------------------------------------------------

test("every bucket's option set stays inside Laya's budget", () => {
	for (const group of groups) {
		const question = stageTwoQuestions(groups, [group.category])[toolKey(group.category)];
		const options = Object.keys(question.criteria);
		// Laya's own recommendation: fewer than about 20 options, and the ONNX
		// port throws when the option text overflows head_max_len (192 tokens).
		assert.ok(options.length <= 7, `${group.category} asks ${options.length} options`);
		assert.equal(options.length, group.tools.length);
	}
});

test("stage one asks one ordering question plus one gate per bucket", () => {
	const questions = stageOneQuestions(groups);
	assert.deepEqual(Object.keys(questions)[0], FIRST_QUESTION, "ordering is asked first");
	assert.equal(Object.keys(questions).length, groups.length + 1);

	for (const group of groups) {
		const q = questions[gateKey(group.category)];
		assert.equal(q.type, "choice");
		// Neutral keys with the meaning in the descriptions: Laya's `noul`
		// primitive follows its own `false:` / `true:` labels on this
		// checkpoint, and this shape is the model card's documented remedy.
		assert.deepEqual(Object.keys(q.criteria), ["A", "B"]);
		assert.match(q.criteria.B, /yes/i);
		assert.match(q.criteria.A, /no/i);
	}
});

test("stage one asks a different gate per bucket, not one shared question", () => {
	const questions = stageOneQuestions(groups);
	const instructions = groups.map((g) => questions[gateKey(g.category)].instructions);
	assert.equal(new Set(instructions).size, groups.length, "six identical gates would all collapse to yes");
	for (const group of groups) {
		assert.ok(
			questions[gateKey(group.category)].instructions.includes(group.meta.gate),
			`the ${group.category} gate must state its own need`,
		);
	}
});

test("stage two asks only about the buckets that survived the gate", () => {
	const questions = stageTwoQuestions(groups, ["read", "edit"]);
	assert.deepEqual(Object.keys(questions).sort(), [toolKey("edit"), toolKey("read")].sort());
	assert.deepEqual(Object.keys(questions[toolKey("read")].criteria), ["read"]);
});

test("the ordering question's option text is a blurb, not the bucket name", () => {
	const questions = stageOneQuestions(groups);
	for (const group of groups) {
		const text = questions[FIRST_QUESTION].criteria[group.category];
		assert.notEqual(text, group.category, "`search: search` tells the model nothing");
		assert.ok(text.split(/\s+/).length >= 4, `${group.category} blurb is too terse to decide on`);
	}
});

// --- grouping -------------------------------------------------------------

test("groupTools keeps canonical order and drops empty buckets", () => {
	const tools = [
		{ name: "uv", description: "python", category: "execute" },
		{ name: "grep", description: "search", category: "search" },
		{ name: "edit", description: "edit", category: "edit" },
	];
	assert.deepEqual(
		groupTools(tools).map((g) => g.category),
		["search", "edit", "execute"],
		"canonical order, and no empty read/vcs/data buckets",
	);
});

test("a tool with no category falls into search, not out of the manifest", () => {
	const groups = groupTools([{ name: "mytool", description: "a user tool with no bucket" }]);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].category, "search");
	assert.deepEqual(groups[0].tools.map((t) => t.name), ["mytool"]);
});

test("shortLabel prefers the explicit short and otherwise caps the description", () => {
	assert.equal(shortLabel({ name: "rg", description: "long", short: "regex search" }), "regex search");
	assert.equal(
		shortLabel({ name: "x", description: "one two three four five six seven eight nine ten." }),
		"one two three four five six seven eight",
	);
	// A blank short must not become the option text.
	assert.equal(shortLabel({ name: "x", description: "alpha beta", short: "   " }), "alpha beta");
});

test("every shipped tool has option text short enough to be scored", () => {
	for (const tool of manifestTools()) {
		const label = shortLabel(tool);
		assert.ok(label.length > 0, `${tool.name} has no option text`);
		assert.ok(label.split(/\s+/).length <= 8, `${tool.name} option text is too long for head_max_len`);
	}
});
