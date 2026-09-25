import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delimiter } from "node:path";

import { resolveOnPath, detectBinaries, systemTools, CATALOGUE } from "../src/slices/discovery/index.js";
import { manifestTools, allowedToolNames } from "../src/shared/manifest.js";
import { parsePlan, renderDirective } from "../src/slices/planner/plan.js";

/** A throwaway PATH containing fake binaries, so tests never touch the real one. */
function fakePath(files) {
	const dir = mkdtempSync(join(tmpdir(), "tiny-boss-path-"));
	for (const name of files) {
		mkdirSync(join(dir, "bin"), { recursive: true });
		writeFileSync(join(dir, "bin", name), "not a real binary");
	}
	return { dir: join(dir, "bin"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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
	const catalogue = [{ binary: "rg", aliases: ["ripgrep"], description: "d", example: "rg x" }];
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
	const catalogue = [{ binary: "rg", aliases: ["ripgrep"], description: "d", example: "rg x" }];
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
	const catalogue = [
		{ binary: "rg", description: "d", example: "rg x" },
		{ binary: "jq", description: "d", example: "jq x" },
	];
	try {
		const found = detectBinaries(dir, ".EXE", catalogue);
		assert.deepEqual(found.map((f) => f.binary), ["jq"]);
	} finally {
		cleanup();
	}
});

test("systemTools marks every detected binary as invoked through bash", () => {
	const tools = systemTools([
		{
			binary: "rg",
			entry: { binary: "rg", description: "ripgrep", example: 'rg -n "x" .' },
		},
	]);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "rg");
	assert.equal(tools[0].invokedAs, "bash", "pi has no tool for an arbitrary executable");
	assert.equal(tools[0].example, 'rg -n "x" .');
	assert.equal(tools[0].source, "system");
});

test("the shipped catalogue has no duplicate binaries", () => {
	const names = CATALOGUE.map((c) => c.binary);
	assert.equal(new Set(names).size, names.length);
	for (const entry of CATALOGUE) {
		assert.ok(entry.description.length > 20, `${entry.binary} needs a real description`);
		assert.ok(entry.example.length > 0, `${entry.binary} needs a runnable example`);
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
	assert.ok(allowed.has("none"));
	assert.ok(!allowed.has("rm"), "an unknown tool is never allowed");
});

test("a plan naming a detected binary renders as a runnable bash command", () => {
	const tools = manifestTools([
		{
			name: "rg",
			description: "ripgrep",
			invokedAs: "bash",
			example: 'rg -n --type ts "pi.on\\(" .',
			source: "system",
		},
	]);
	const raw = JSON.stringify({
		function_calls: [{ name: "emit_plan", arguments: { tools: ["rg"] } }],
	});
	const steps = parsePlan(raw, tools);
	assert.equal(steps.length, 1, "the binary is a legal step once detected");
	assert.equal(steps[0].invokedAs, "bash");

	const out = renderDirective(steps, "why do listeners leak?");
	assert.match(out, /1\. bash \{"command":"rg -n --type ts/);
	assert.match(out, /\(via rg\)/);
	assert.ok(out.includes("why do listeners leak?"), "the prompt still survives");
});

test("a binary absent from the manifest is dropped, not rendered", () => {
	const raw = JSON.stringify({
		function_calls: [{ name: "emit_plan", arguments: { tools: ["lazygit"] } }],
	});
	assert.deepEqual(parsePlan(raw, manifestTools()), []);
});
