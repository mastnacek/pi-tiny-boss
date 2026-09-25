/**
 * Gate-level scoring.
 *
 * The gate is the new mechanism this design adds, so it gets its own measurement
 * rather than being inferred from plan accuracy. For every labelled prompt, the
 * ideal tool set implies a set of buckets that *should* have fired; this compares
 * that against the buckets whose gate actually fired.
 *
 *   npm run eval    # runs accuracy.ts first, which produces out.json
 *
 * Precision matters more than recall here: a false gate costs a wrong step in
 * every plan, while a missed gate costs one missing hint the frontier model can
 * recover from. The report prints both anyway — picking a threshold without
 * seeing both numbers is guesswork.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { CATEGORY_ORDER } from "../src/shared/decision-schema.js";
import type { ToolCategory } from "../src/shared/types.js";

/** Which bucket a dataset tool name belongs to. Kept explicit: the dataset names
 * tools that are not in the manifest (cat, git, none), so a manifest lookup
 * would silently drop them. */
const TOOL_CATEGORY: Record<string, ToolCategory | null> = {
	grep: "search",
	rg: "search",
	find: "search",
	fd: "search",
	read: "read",
	cat: "read",
	bat: "read",
	edit: "edit",
	write: "edit",
	sd: "edit",
	bash: "execute",
	git: "execute",
	hyperfine: "execute",
	jq: "data",
	none: null,
};

interface Case {
	prompt: string;
	ideal: string[];
	gates: Array<{ category: ToolCategory; p: number; passed: boolean }>;
}

const payload = JSON.parse(readFileSync(new URL("./out.json", import.meta.url), "utf8")) as {
	out: Case[];
	silent: Array<{ prompt: string; passesGates: number }>;
};

/** Buckets the ideal answer implies. An unknown name is a hole in the map, not a silent zero. */
function expectedCategories(ideal: string[]): Set<ToolCategory> {
	const out = new Set<ToolCategory>();
	for (const tool of ideal) {
		const category = TOOL_CATEGORY[tool];
		if (category === undefined) throw new Error(`eval/dataset.json names "${tool}" with no bucket mapping`);
		if (category !== null) out.add(category);
	}
	return out;
}

interface Tally {
	expected: number;
	fired: number;
	truePositive: number;
}

const overall: Tally = { expected: 0, fired: 0, truePositive: 0 };
const byCategory = new Map<ToolCategory, Tally>(CATEGORY_ORDER.map((c) => [c, { expected: 0, fired: 0, truePositive: 0 }]));

/** Probability thresholds worth reading off this run before touching the defaults. */
const sweep = [0.5, 0.6, 0.7, 0.8, 0.9].map((threshold) => {
	let tp = 0;
	let fp = 0;
	let fn = 0;
	for (const c of payload.out) {
		const expected = expectedCategories(c.ideal);
		for (const gate of c.gates) {
			const fired = gate.p >= threshold;
			const wanted = expected.has(gate.category);
			if (fired && wanted) tp += 1;
			else if (fired && !wanted) fp += 1;
			else if (!fired && wanted) fn += 1;
		}
	}
	return { threshold, tp, fp, fn, precision: tp + fp === 0 ? 1 : tp / (tp + fp), recall: tp + fn === 0 ? 1 : tp / (tp + fn) };
});

for (const c of payload.out) {
	const expected = expectedCategories(c.ideal);
	const fired = new Set(c.gates.filter((g) => g.passed).map((g) => g.category));
	overall.expected += expected.size;
	overall.fired += fired.size;
	for (const category of expected) if (fired.has(category)) overall.truePositive += 1;

	// Per-bucket, every bucket is judged: a bucket that should have fired and did
	// not is a miss, and one that fired unbidden is a false positive.
	for (const category of CATEGORY_ORDER) {
		const tally = byCategory.get(category)!;
		if (expected.has(category)) {
			tally.expected += 1;
			if (fired.has(category)) tally.truePositive += 1;
		}
		if (fired.has(category)) tally.fired += 1;
	}
}

const pct = (n: number, d: number): string => (d === 0 ? "  -" : `${((n / d) * 100).toFixed(0)}%`.padStart(4));

console.log("gate precision and recall, per bucket\n");
console.log("  bucket    expected  fired   hit   precision  recall");
for (const [category, t] of byCategory) {
	const fp = t.fired - t.truePositive;
	console.log(
		`  ${category.padEnd(9)} ${String(t.expected).padStart(8)} ${String(t.fired).padStart(6)} ${String(t.truePositive).padStart(5)}` +
			`   ${pct(t.truePositive, t.fired).padStart(8)}  ${pct(t.truePositive, t.expected)}`,
	);
}
const fp = overall.fired - overall.truePositive;
const fn = overall.expected - overall.truePositive;
console.log(
	`\n  overall   ${String(overall.expected).padStart(8)} ${String(overall.fired).padStart(6)} ${String(overall.truePositive).padStart(5)}` +
		`   ${pct(overall.truePositive, overall.fired).padStart(8)}  ${pct(overall.truePositive, overall.expected)}`,
);
console.log(`            ${fp} false positives, ${fn} misses`);

console.log("\nthreshold sweep (what MIN_GATE_PROBABILITY buys)\n");
console.log("  threshold  precision  recall   tp   fp   fn");
for (const row of sweep) {
	console.log(
		`  ${row.threshold.toFixed(2).padStart(9)}  ${pct(Math.round(row.precision * 100), 100).padStart(8)}  ` +
			`${pct(Math.round(row.recall * 100), 100).padStart(6)}  ${String(row.tp).padStart(3)}  ${String(row.fp).padStart(3)}  ${String(row.fn).padStart(3)}`,
	);
}
console.log("\n  precision is the number to protect: a false gate puts a wrong step in");
console.log("  every plan, a miss costs one hint the frontier model can recover from.");

const leaked = payload.silent.filter((s) => s.passesGates > 0);
console.log(`\nshort inputs  ${leaked.length}/${payload.silent.length} still passed a gate`);
if (leaked.length > 0) console.log(`              ${leaked.map((s) => JSON.stringify(s.prompt)).join(", ")}`);

writeFileSync(
	new URL("./gates.json", import.meta.url),
	JSON.stringify({ overall: { ...overall, fp, fn }, byCategory: Object.fromEntries(byCategory), sweep }, null, 1),
);
console.log("\nwrote eval/gates.json");
