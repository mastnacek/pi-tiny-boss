/**
 * Run the decision model against the labelled prompt set.
 *
 *   npm run eval          # this, then eval/gates.ts, then eval/report.ts
 *
 * Unlike the needle3 harness this one does NOT measure truncation, token budget
 * or session decay — Laya generates nothing, so none of those failure modes
 * exist. What is worth measuring instead is whether the two-pass gate design
 * reaches the right buckets, whether the probabilities mean anything, and what
 * the whole thing costs in wall-clock time.
 *
 * Requires the ONNX bundle (`/tiny-boss fetch`, about 1.6 GB). Writes
 * `eval/out.json`; `eval/report.ts` scores it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { checkpointSlug, outPath } from "./paths.js";
import { createLayaEngine } from "../src/slices/engine/laya.js";
import { detectBinaries, systemTools } from "../src/slices/discovery/index.js";
import { manifestTools } from "../src/shared/manifest.js";
import {
	FIRST_QUESTION,
	groupTools,
	stageOneQuestions,
	stageTwoQuestions,
	toolKey,
} from "../src/shared/decision-schema.js";
import { assembleSteps, gateOutcome } from "../src/slices/planner/plan.js";
import type { PlanStep, ToolCategory } from "../src/shared/types.js";

const dataset = JSON.parse(readFileSync(new URL("./dataset.json", import.meta.url), "utf8")) as {
	cases: Array<[string, string[]]>;
	mustBeSilent: string[];
};

const tools = manifestTools(systemTools(detectBinaries()));
const groups = groupTools(tools);

let engine: Awaited<ReturnType<typeof createLayaEngine>>;
try {
	engine = await createLayaEngine();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`\nCannot measure: ${message}\n`);
	console.error("Download the bundle first: /tiny-boss fetch   (about 1.6 GB, once)\n");
	process.exit(1);
}

/** One full two-pass decision, with everything a report could want. */
async function decide(prompt: string) {
	const started = Date.now();
	try {
		const first = await engine.ask(prompt, stageOneQuestions(groups));
		const outcome = gateOutcome(groups, first);
		const second = outcome.order.length > 0 ? await engine.ask(prompt, stageTwoQuestions(groups, outcome.order)) : {};
		const steps = assembleSteps(groups, outcome.order, second);
		return {
			ms: Date.now() - started,
			steps: steps as PlanStep[],
			first: (first[FIRST_QUESTION]?.choice ?? null) as ToolCategory | null,
			gates: outcome.gates.map((g) => ({ category: g.category, p: g.probability, passed: g.passed })),
			answer: outcome.gates
				.filter((g) => g.passed)
				.map((g) => {
					const chosen = second[toolKey(g.category)];
					return {
						category: g.category,
						tool: chosen?.choice ?? null,
						p: chosen ? (chosen.probabilities[chosen.choice] ?? 0) : 0,
					};
				}),
			err: null as string | null,
		};
	} catch (error) {
		return {
			ms: Date.now() - started,
			steps: [] as PlanStep[],
			first: null as ToolCategory | null,
			gates: [] as Array<{ category: ToolCategory; p: number; passed: boolean }>,
			answer: [] as Array<{ category: ToolCategory; tool: string | null; p: number }>,
			err: error instanceof Error ? error.message : String(error),
		};
	}
}

const out: unknown[] = [];
for (const [prompt, ideal] of dataset.cases) {
	const r = await decide(prompt);
	const expectsNothing = ideal.includes("none");
	out.push({
		prompt,
		ideal,
		expectsNothing,
		first: r.steps[0]?.tool ?? (r.err ? "ERROR" : "(none)"),
		hit: expectsNothing ? r.steps.length === 0 : r.steps.some((s) => ideal.includes(s.tool)),
		falsePositive: expectsNothing && r.steps.length > 0,
		n: r.steps.length,
		ms: r.ms,
		gates: r.gates,
		answer: r.answer,
		err: r.err,
	});
}

// Determinism: the old harness found needle3 decayed into `none` after ~30 calls
// in one session. Laya is stateless per call, so this checks that the claim holds
// rather than assuming it.
const det: Record<string, string[]> = {};
for (const prompt of [
	"run the test suite and fix whatever fails",
	"find where the pi.on subscriptions are declared",
	"what is the capital of France?",
]) {
	const seen: string[] = [];
	for (let i = 0; i < 5; i += 1) seen.push((await decide(prompt)).steps.map((s) => s.tool).join("+") || "(none)");
	det[prompt] = seen;
}

// Short and garbage inputs. The hook's 24-character gate is what protects the
// session; this measures what the model would have said if it were not there.
const silent: unknown[] = [];
for (const prompt of dataset.mustBeSilent) {
	const r = await decide(prompt);
	silent.push({
		prompt,
		steps: r.steps.length,
		first: r.steps[0]?.tool ?? "(none)",
		passesGates: r.gates.filter((g) => g.passed).length,
		err: r.err,
	});
}

writeFileSync(
	outPath("out"),
	JSON.stringify(
		{
			tools: tools.length,
			system: tools.filter((t) => t.source === "system").length,
			groups: groups.map((g) => ({ category: g.category, options: g.tools.length })),
			out,
			det,
			silent,
		},
		null,
		1,
	),
);
console.log(`checkpoint: ${checkpointSlug()}  (PI_TINY_BOSS_SUBFOLDER=${process.env.PI_TINY_BOSS_SUBFOLDER ?? "(unset)"})`);
console.log(`wrote eval/out.${checkpointSlug()}.json — ${out.length} cases, ${dataset.mustBeSilent.length} short-input probes`);
await engine.close();
