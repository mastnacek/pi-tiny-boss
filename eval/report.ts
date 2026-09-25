/**
 * Turn `eval/accuracy.ts` output into a scored report.
 *
 *   npm run eval    # accuracy.ts, then gates.ts, then this
 *
 * Kept separate from the runner so the scoring logic is readable on its own and
 * so a failed run leaves a truncated file rather than a misleading summary.
 */

import { readFileSync } from "node:fs";
import { checkpointSlug, outPath } from "./paths.js";

interface Gate {
	category: string;
	p: number;
	passed: boolean;
}

interface Case {
	prompt: string;
	ideal: string[];
	expectsNothing: boolean;
	first: string;
	hit: boolean;
	falsePositive: boolean;
	n: number;
	ms: number;
	gates: Gate[];
	answer: Array<{ category: string; tool: string | null; p: number }>;
	err: string | null;
}

interface Payload {
	tools: number;
	system: number;
	groups: Array<{ category: string; options: number }>;
	out: Case[];
	det: Record<string, string[]>;
	silent: Array<{ prompt: string; steps: number; first: string; passesGates: number; err: string | null }>;
}

const r = JSON.parse(readFileSync(outPath("out"), "utf8")) as Payload;
console.log(`checkpoint: ${checkpointSlug()}
`);

/**
 * Which dataset tool names imply which bucket.
 *
 * Declared before first use on purpose — a `const` read earlier in module
 * evaluation is a temporal-dead-zone crash, not an empty value.
 */
const GATE_TOOLS: Record<string, string[]> = {
	search: ["grep", "rg", "find", "fd"],
	read: ["read", "cat", "bat"],
	edit: ["edit", "write", "sd"],
	execute: ["bash", "git", "hyperfine"],
	data: ["jq"],
	vcs: [],
};

/** Bucket a case by what the ideal answer looks like. */
function bucket(ideal: string[]): string {
	if (ideal.includes("none")) return "discussion (expect nothing)";
	if (ideal.some((t) => ["bash", "git", "hyperfine"].includes(t))) return "execute";
	if (ideal.some((t) => ["edit", "write", "sd"].includes(t))) return "edit";
	if (ideal.some((t) => ["grep", "rg", "find", "fd"].includes(t))) return "search";
	return "read";
}

const pct = (n: number, d: number): string => (d === 0 ? "  -" : `${((n / d) * 100).toFixed(0)}%`.padStart(4));

console.log(`manifest: ${r.tools} tools (${r.system} discovered from PATH)`);
console.log(`buckets:  ${r.groups.map((g) => `${g.category}=${g.options}`).join(" ")}\n`);

const groups = new Map<string, Case[]>();
for (const c of r.out) {
	const key = bucket(c.ideal);
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key)!.push(c);
}
console.log("by category");
for (const [name, list] of groups) {
	const hits = list.filter((c) => c.hit).length;
	console.log(`  ${name.padEnd(26)} ${String(hits).padStart(2)}/${String(list.length).padEnd(3)} ${pct(hits, list.length)}`);
}

console.log("\nper prompt");
for (const c of r.out) {
	const mark = c.err ? "ERR " : c.hit ? " ok " : c.falsePositive ? "FP  " : "MISS";
	const got = c.err ? "error" : c.first;
	console.log(`  ${mark}  ${c.prompt.slice(0, 42).padEnd(43)}${got.padEnd(11)}n=${c.n} ${String(c.ms).padStart(5)}ms`);
}

const hits = r.out.filter((c) => c.hit).length;
const errs = r.out.filter((c) => c.err);
console.log(`\nACCURACY  ${hits}/${r.out.length} = ${pct(hits, r.out.length).trim()}`);
console.log(`ERRORS    ${errs.length}/${r.out.length} = ${pct(errs.length, r.out.length).trim()}`);
if (errs.length) console.log(`          ${[...new Set(errs.map((c) => c.err))].join(" | ")}`);

const silent = r.out.filter((c) => c.expectsNothing);
if (silent.length > 0) {
	const quiet = silent.filter((c) => c.n === 0).length;
	console.log(`DISCUSSION ${quiet}/${silent.length} prompts that need no tools produced no plan`);
}

// Latency: two forward passes, so this is the only number the hook's 4 s budget
// has to survive. Reported as percentiles because the mean hides the tail that
// actually breaches the budget.
const times = r.out.map((c) => c.ms).sort((a, b) => a - b);
const at = (q: number): number => times[Math.min(times.length - 1, Math.floor(times.length * q))] ?? 0;
console.log(`\nLATENCY   p50 ${at(0.5)}ms  p90 ${at(0.9)}ms  max ${times.at(-1) ?? 0}ms  (both passes)`);

// Calibration, per bucket gate. The old report showed needle3's confidence was
// worse than useless — higher on wrong answers than right ones. This is the same
// question asked of Laya, and it is the number that justifies or refutes the
// MIN_GATE_PROBABILITY floor.
const gateStats = { hit: [] as number[], miss: [] as number[], falsePositive: [] as number[] };
for (const c of r.out) {
	for (const gate of c.gates) {
		const wanted = c.ideal.some((t) => GATE_TOOLS[gate.category]?.includes(t));
		if (c.expectsNothing) gateStats.falsePositive.push(gate.p);
		else if (wanted === gate.passed) gateStats.hit.push(gate.p);
		else gateStats.miss.push(gate.p);
	}
}
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
console.log(
	`GATES     mean p ${mean(gateStats.hit).toFixed(2)} when the gate was right vs ` +
		`${mean(gateStats.miss).toFixed(2)} when it was wrong (${gateStats.miss.length} wrong)`,
);
if (gateStats.falsePositive.length > 0) {
	console.log(`          mean p ${mean(gateStats.falsePositive).toFixed(2)} on prompts that needed no tools at all`);
}

console.log("\ndeterminism (same prompt, 5 calls, one loaded session)");
for (const [p, seen] of Object.entries(r.det)) {
	console.log(`  ${p.slice(0, 42).padEnd(43)}${seen.join("  ")}`);
}

const leaked = r.silent.filter((s) => s.steps > 0);
console.log(`\nshort inputs  ${leaked.length}/${r.silent.length} produced a plan`);
if (leaked.length > 0) {
	console.log(`              every leak resolved to: ${[...new Set(leaked.map((s) => s.first))].join(", ")}`);
}
console.log("              the 24-character gate in the hook is what protects the session, not the model.");
