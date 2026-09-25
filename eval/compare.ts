/**
 * Compare two recorded runs on the statistic that matters: does the gate's
 * probability separate "this need is real" from "it is not"?
 *
 * Plan accuracy conflates the model with the threshold. Mean p by ground truth
 * does not: if p is higher when the need is NOT real, no threshold can rescue it.
 */
import { readFileSync } from "node:fs";

interface Case { prompt: string; ideal: string[]; gates: Array<{ category: string; p: number; passed: boolean }>; hit: boolean; n: number; expectsNothing: boolean }

const TOOLS: Record<string, string[]> = {
	search: ["grep", "rg", "find", "fd"], read: ["read", "cat", "bat"], edit: ["edit", "write", "sd"],
	execute: ["bash", "git", "hyperfine"], vcs: ["gh"], data: ["jq"],
};
const load = (slug: string) => JSON.parse(readFileSync(new URL(`./out.${slug}.json`, import.meta.url), "utf8")) as { out: Case[] };

/** A tiny AUC: probability a random needed gate scores above a random unneeded one. */
function auc(pairs: Array<[boolean, number]>): number {
	const pos = pairs.filter(([w]) => w).map(([, p]) => p);
	const neg = pairs.filter(([w]) => !w).map(([, p]) => p);
	if (pos.length === 0 || neg.length === 0) return NaN;
	let wins = 0, ties = 0;
	for (const a of pos) for (const b of neg) a > b ? (wins += 1) : a === b ? (ties += 1) : null;
	return (wins + ties / 2) / (pos.length * neg.length);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

for (const slug of ["english", "typed-decisions"]) {
	const { out } = load(slug);
	const pairs: Array<[boolean, number]> = [];
	let fired = 0, accuracy = 0;
	const byCat = new Map<string, Array<[boolean, number]>>();
	for (const c of out) {
		if (c.hit) accuracy += 1;
		const expected = new Set<string>();
		for (const t of c.ideal) for (const [cat, names] of Object.entries(TOOLS)) if (names.includes(t)) expected.add(cat);
		for (const g of c.gates) {
			const wanted = expected.has(g.category);
			pairs.push([wanted, g.p]);
			if (g.passed) fired += 1;
			if (!byCat.has(g.category)) byCat.set(g.category, []);
			byCat.get(g.category)!.push([wanted, g.p]);
		}
	}
	const pos = pairs.filter(([w]) => w).map(([, p]) => p);
	const neg = pairs.filter(([w]) => !w).map(([, p]) => p);
	console.log(`\n=== ${slug} ===`);
	console.log(`  accuracy ${accuracy}/${out.length} = ${((accuracy / out.length) * 100).toFixed(0)}%   gate firings ${fired} of ${pairs.length}`);
	console.log(`  mean p when needed ${mean(pos).toFixed(3)} vs not needed ${mean(neg).toFixed(3)}   separation ${(mean(pos) - mean(neg)).toFixed(3)}`);
	console.log(`  AUC ${auc(pairs).toFixed(3)}  (0.5 = no signal; below 0.5 = inverted)`);
	console.log("  per bucket AUC:");
	for (const [cat, p] of [...byCat].sort()) {
		const a = auc(p);
		console.log(`    ${cat.padEnd(8)} ${Number.isNaN(a) ? "  n/a" : a.toFixed(3)}   n=${p.length}  mean p needed ${mean(p.filter(([w]) => w).map(([, x]) => x)).toFixed(2)} vs ${mean(p.filter(([w]) => !w).map(([, x]) => x)).toFixed(2)}`);
	}
}
