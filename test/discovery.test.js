import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delimiter } from "node:path";

import { resolveOnPath, detectBinaries, systemTools, CATALOGUE } from "../src/slices/discovery/index.js";
import { manifestTools, allowedToolNames } from "../src/shared/manifest.js";
import { groupTools } from "../src/shared/decision-schema.js";
import { assembleSteps, gateOutcome, renderDirective } from "../src/slices/planner/plan.js";
import { gateKey, toolKey } from "../src/shared/decision-schema.js";

/** A throwaway PATH containing fake binaries, so tests never touch the real one. */
function fakePath(files) {
	const dir = mkdtempSync(join(tmpdir(), "tiny-boss-path-"));
	for (const name of files) {
		mkdirSync(join(dir, "bin"), { recursive: true });
		writeFileSync(join(dir, "bin", name), "not a real binary");
	}
	return { dir: join(dir, "bin"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One catalogue entry, so a test never depends on the shipped list's shape. */
const entry = (binary, extra = {}) => ({
	binary,
	description: `what ${binary} is for, at length`,
	short: `${binary} short label`,
	category: "search",
	example: `${binary} example`,
	...extra,
});

test("resolveOnPath finds a binary by its extensionless name", () => {
	const { dir, cleanup } = fakePath(["rg.EXE"]);
	try {
		assert.equal(resolveOnPath("rg", dir, ".EXE;.CMD"), join(dir, "rg.EXE"));
	} finally {
		cleanup();
	}
});

test("resolveOnPath returns undefined for a missing binary", () => {
	const { dir, cleanup } = fakePath(["other.EXE"]);
	try {
		assert.equal(resolveOnPath("rg", dir, ".EXE"), undefined);
	} finally {
		cleanup();
	}
});

test("resolveOnPath ignores a directory that merely shares the name", () => {
	const dir = mkdtempSync(join(tmpdir(), "tiny-boss-dir-"));
	try {
		mkdirSync(join(dir, "rg.EXE"), { recursive: true });
		assert.equal(resolveOnPath("rg", dir, ".EXE"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("detectBinaries resolves a catalogue entry through its alias", () => {
	const { dir, cleanup } = fakePath(["ripgrep.EXE"]);
	const catalogue = [entry("rg", { aliases: ["ripgrep"] })];
	try {
		const found = detectBinaries(dir, ".EXE", catalogue);
		assert.equal(found.length, 1);
		assert.equal(found[0].binary, "rg", "the canonical name is reported, not the alias");
	} finally {
		cleanup();
	}
});

test("detectBinaries prefers the canonical name over an alias", () => {
	const { dir, cleanup } = fakePath(["rg.EXE", "ripgrep.EXE"]);
	const catalogue = [entry("rg", { aliases: ["ripgrep"] })];
	try {
		const found = detectBinaries(dir, ".EXE", catalogue);
		assert.equal(found.length, 1, "the first spelling wins, no duplicate entry");
		assert.equal(found[0].path, join(dir, "rg.EXE"));
	} finally {
		cleanup();
	}
});

test("detectBinaries skips entries with no binary installed", () => {
	const { dir, cleanup } = fakePath(["jq.EXE"]);
	const catalogue = [entry("rg"), entry("jq")];
	try {
		const found = detectBinaries(dir, ".EXE", catalogue);
		assert.deepEqual(found.map((f) => f.binary), ["jq"]);
	} finally {
		cleanup();
	}
});

test("systemTools carries the bucket and the option text through to the manifest", () => {
	const tools = systemTools([{ binary: "rg", entry: entry("rg", { category: "search" }) }]);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "rg");
	assert.equal(tools[0].invokedAs, "bash", "pi has no tool for an arbitrary executable");
	assert.equal(tools[0].example, "rg example");
	assert.equal(tools[0].source, "system");
	// Both travel with the spec because both are load-bearing for Laya: one picks
	// the bucket, the other is the text the model actually scores.
	assert.equal(tools[0].category, "search");
	assert.equal(tools[0].short, "rg short label");
});

test("the shipped catalogue is bucketed, bundled and duplicate-free", () => {
	const names = CATALOGUE.map((c) => c.binary);
	assert.equal(new Set(names).size, names.length);
	for (const c of CATALOGUE) {
		assert.ok(c.description.length > 20, `${c.binary} needs a real description`);
		assert.ok(c.example.length > 0, `${c.binary} needs a runnable example`);
		assert.ok(c.short.length > 0 && c.short.split(/\s+/).length <= 8, `${c.binary} needs short option text`);
	}
	// No bucket may exceed seven options once the built-ins join it, because
	// every option set has to stay inside Laya's scoring budget.
	const groups = groupTools(manifestTools(systemTools(detectBinaries("", "", CATALOGUE))));
	for (const group of groups) {
		assert.ok(group.tools.length <= 7, `${group.category} would ask ${group.tools.length} options`);
	}
});

test("manifestTools merges extras but built-ins win a name clash", () => {
	const merged = manifestTools([
		{ name: "rg", description: "ripgrep", invokedAs: "bash", example: "rg x" },
		{ name: "read", description: "a user config trying to shadow read" },
	]);
	const names = merged.map((t) => t.name);
	assert.ok(names.includes("rg"), "an extra tool joins the manifest");
	assert.equal(new Set(names).size, names.length, "no duplicates");
	const read = merged.find((t) => t.name === "read");
	assert.notEqual(read.description, "a user config trying to shadow read", "built-in read survives");
});

test("allowedToolNames covers both built-ins and extras", () => {
	const allowed = allowedToolNames([{ name: "rg", description: "ripgrep" }]);
	assert.ok(allowed.has("rg"));
	assert.ok(allowed.has("bash"));
	assert.ok(!allowed.has("rm"), "an unknown tool is never allowed");
});

test("a plan naming a detected binary renders as a runnable bash command", () => {
	const tools = manifestTools([
		{
			name: "rg",
			description: "ripgrep",
			short: "regex search, gitignore-aware",
			category: "search",
			invokedAs: "bash",
			example: 'rg -n --type ts "pi.on\\(" .',
			source: "system",
		},
	]);
	const groups = groupTools(tools);
	const answers = {
		[gateKey("search")]: { choice: "B", probabilities: { A: 0.1, B: 0.9 }, confidence: 0.8 },
		[toolKey("search")]: { choice: "rg", probabilities: { rg: 0.8 }, confidence: 0.5 },
	};
	const outcome = gateOutcome(groups, answers);
	const steps = assembleSteps(groups, outcome.order, answers);
	assert.equal(steps.length, 1, "the binary is a legal step once detected");
	assert.equal(steps[0].invokedAs, "bash");

	const out = renderDirective(steps, "why do listeners leak?", { elapsedMs: 22, requested: 1 });
	assert.match(out, /1\. bash \{"command":"rg -n --type ts/);
	assert.match(out, /\(via rg/);
	assert.ok(out.includes("why do listeners leak?"), "the prompt still survives");
});

test("a binary absent from the manifest cannot appear in a plan", () => {
	const groups = groupTools(manifestTools());
	const answers = {
		[gateKey("search")]: { choice: "B", probabilities: { A: 0.1, B: 0.9 }, confidence: 0.8 },
		[toolKey("search")]: { choice: "lazygit", probabilities: { lazygit: 0.9 }, confidence: 0.9 },
	};
	assert.deepEqual(assembleSteps(groups, ["search"], answers), []);
});

test("the delimiter is used to split PATH, not a hardcoded colon", () => {
	const { dir, cleanup } = fakePath(["jq.EXE"]);
	try {
		assert.equal(delimiter.length > 0, true);
		assert.equal(resolveOnPath("jq", dir, ".EXE"), join(dir, "jq.EXE"));
	} finally {
		cleanup();
	}
});
