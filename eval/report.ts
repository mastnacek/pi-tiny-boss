/**
 * Turn `eval/accuracy.ts` output into a scored report.
 *
 *   npm run eval > eval/out.json && npm run eval:report
 *
 * Kept separate from the runner so the scoring logic is readable on its own and
 * so a failed run leaves a truncated file rather than a misleading summary.
 */

import { readFileSync } from "node:fs";

interface Case {
	prompt: string;
	ideal: string[];
	first: string;
	hit: boolean;
	n: number;
	ms: number;
	conf: number;
	reasoning: string;
	err: string | null;
}

interface Payload {
	tools: number;
	system: number;
	out: Case[];
	det: Record<string, string[]>;
	silent: Array<{ prompt: string; steps: number; first: string; err: string | null }>;
}

const r = JSON.parse(readFileSync(new URL("./out.json", import.meta.url), "utf8")) as Payload;

/** Bucket a case by what the ideal answer looks like. */
function bucket(ideal: string[]): string {
	if (ideal.includes("none")) return "discussion (expect none)";
	if (ideal.some((t) => ["bash", "git", "hyperfine"].includes(t))) return "execute";
	if (ideal.some((t) => ["edit", "write", "sd"].includes(t))) return "edit";
	if (ideal.some((t) => ["grep", "rg", "find", "fd"].includes(t))) return "search";
	return "read";
}

const pct = (n: number, d: number): string => (d === 0 ? "  -" : `${((n / d) * 100).toFixed(0)}%`.padStart(4));

console.log(`manifest: ${r.tools} tools (${r.system} discovered from PATH)\n`);

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
	const mark = c.err ? "ERR " : c.hit ? " ok " : "MISS";
	const got = c.err ? "truncated" : c.first;
	console.log(
		`  ${mark}  ${c.prompt.slice(0, 42).padEnd(43)}${got.padEnd(11)}n=${c.n} ${String(c.ms).padStart(5)}ms conf=${c.conf.toFixed(2)}`,
	);
}

const hits = r.out.filter((c) => c.hit).length;
const errs = r.out.filter((c) => c.err);
console.log(`\nACCURACY  ${hits}/${r.out.length} = ${pct(hits, r.out.length).trim()}`);
console.log(`ERRORS    ${errs.length}/${r.out.length} = ${pct(errs.length, r.out.length).trim()}`);
if (errs.length) console.log(`          ${[...new Set(errs.map((c) => c.err))].join(" | ")}`);

// The model's own confidence score. Reported because it is worthless: a
// confident wrong answer is worse than an uncertain one.
const scored = r.out.filter((c) => !c.err && c.conf > 0);
if (scored.length) {
	const wrong = scored.filter((c) => !c.hit);
	const meanAll = scored.reduce((a, c) => a + c.conf, 0) / scored.length;
	const meanWrong = wrong.length ? wrong.reduce((a, c) => a + c.conf, 0) / wrong.length : 0;
	console.log(
		`\nCONFIDENCE  mean ${meanAll.toFixed(2)} on all replies vs ${meanWrong.toFixed(2)} on the ${wrong.length} wrong ones` +
			" — the model is not calibrated.",
	);
}

console.log("\ndeterminism (same prompt, 5 calls, one session)");
for (const [p, seen] of Object.entries(r.det)) {
	console.log(`  ${p.slice(0, 42).padEnd(43)}${seen.join(" ")}`);
}

const leaked = r.silent.filter((s) => s.steps > 0);
console.log(`\nsilent gate  ${leaked.length}/${r.silent.length} short inputs still produced a plan`);
if (leaked.length) {
	console.log(`             every leak resolved to: ${[...new Set(leaked.map((s) => s.first))].join(", ")}`);
}
console.log("             the 24-character gate in the hook is what protects the session, not the model.");
