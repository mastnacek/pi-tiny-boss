/**
 * Plan assembly and rendering.
 *
 * Pure functions only: no ONNX, no UI, no pi imports. Everything here is
 * exercised directly by the test suite with hand-written Laya answers.
 *
 * The two jobs are deliberately separate. `gateOutcome` turns pass one's
 * probabilities into an ordered list of buckets, `assembleSteps` turns pass two's
 * choices into steps. Neither can see the engine.
 */

import {
	CATEGORY_META,
	FIRST_QUESTION,
	FORWARD_PASSES,
	MAX_STEPS,
	gateKey,
	toolKey,
	type ToolGroup,
} from "../../shared/decision-schema.js";
import type { LayaAnswers, PlanStep, ToolCategory, ToolSpec } from "../../shared/types.js";

/**
 * How sure Laya has to be that a bucket is needed before it is kept.
 *
 * Both floors are conservative defaults, not measured optima. The checkpoint's
 * own card puts raw ECE at 0.213 before temperature fitting, so its probabilities
 * are directionally useful and not yet trustworthy to three decimals; a floor of
 * 0.5 admits "clearly leans yes" and rejects "coin flip". The right way to set
 * these is `npm run eval` on your own prompts, and `/tiny-boss status` prints the
 * last plan's probabilities so the number is visible while you tune it.
 */
export const MIN_GATE_PROBABILITY = 0.5;

/** How much of its own bucket's probability mass a tool must win to be named. */
export const MIN_TOOL_PROBABILITY = 0.34;

/** One bucket's verdict from pass one. */
export interface GateResult {
	category: ToolCategory;
	/** P(the bucket is needed), i.e. the `B` option's probability. */
	probability: number;
	/** Answer confidence, 1 - normalised entropy. Reported, not gated on. */
	confidence: number;
	passed: boolean;
}

/** Pass one, read out. */
export interface GateOutcome {
	gates: GateResult[];
	/** Buckets that passed, with the `first` answer moved to the front. */
	order: ToolCategory[];
	/** What `first` answered, whether or not it survived its own gate. */
	firstAnswered: ToolCategory | null;
}

/** Probability of the option named `key`, or 0 when Laya did not report it. */
function probabilityOf(answers: LayaAnswers, question: string, key: string): number {
	const answer = answers[question];
	if (!answer) return 0;
	const value = answer.probabilities[key];
	return typeof value === "number" ? value : 0;
}

/** Which buckets this request needs, and in what order. */
export function gateOutcome(groups: ToolGroup[], answers: LayaAnswers): GateOutcome {
	const gates: GateResult[] = groups.map((group) => {
		const answer = answers[gateKey(group.category)];
		const probability = probabilityOf(answers, gateKey(group.category), "B");
		return {
			category: group.category,
			probability,
			confidence: answer?.confidence ?? 0,
			// The floor is applied even though a two-option argmax already implies
			// p >= 0.5: it is spelled out as a named number so raising it is a
			// one-line change, and it still rejects a malformed reply that names
			// `B` while putting its mass elsewhere.
			passed: answer?.choice === "B" && probability >= MIN_GATE_PROBABILITY,
		};
	});

	const kept = gates.filter((g) => g.passed);
	const first = answers[FIRST_QUESTION]?.choice;
	const firstCategory =
		typeof first === "string" && CATEGORY_META[first as ToolCategory] ? (first as ToolCategory) : null;

	// `first` is asked in the same pass as the gates, so it can name a bucket that
	// then failed its own gate. Demoting it is the only honest resolution: the gate
	// is the more specific question, and the order still has to be an order.
	const order: ToolCategory[] = [];
	if (firstCategory && kept.some((g) => g.category === firstCategory)) order.push(firstCategory);
	for (const gate of kept) {
		if (gate.category !== firstCategory) order.push(gate.category);
	}

	return { gates, order, firstAnswered: firstCategory };
}

/** Wrap a tool name into a renderable step, carrying the manifest's invocation. */
function stepFor(tool: ToolSpec, category: ToolCategory, gate: number, toolProbability: number): PlanStep {
	return {
		tool: tool.name,
		args: {},
		why: "",
		invokedAs: tool.invokedAs,
		example: tool.example,
		category,
		gateProbability: round3(gate),
		toolProbability: round3(toolProbability),
	};
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Pass two, assembled into steps.
 *
 * Ordering follows `order` from pass one, and each step keeps the probability
 * that produced it. A bucket whose tool choice is a coin flip is dropped rather
 * than forwarded: a diffuse answer over a bucket is the model saying it has no
 * opinion, and passing that on as a recommendation is worse than passing nothing.
 */
export function assembleSteps(
	groups: ToolGroup[],
	order: ToolCategory[],
	answers: LayaAnswers,
): PlanStep[] {
	const byCategory = new Map(groups.map((g) => [g.category, g]));
	const steps: PlanStep[] = [];

	for (const category of order) {
		if (steps.length >= MAX_STEPS) break;
		const group = byCategory.get(category);
		if (!group) continue;

		const answer = answers[toolKey(category)];
		if (!answer) continue;

		const spec = group.tools.find((t) => t.name === answer.choice);
		if (!spec) continue;

		const toolProbability = probabilityOf(answers, toolKey(category), spec.name);
		if (toolProbability < MIN_TOOL_PROBABILITY) continue;

		steps.push(stepFor(spec, category, probabilityOf(answers, gateKey(category), "B"), toolProbability));
	}

	return steps;
}

/**
 * Render one step as a compact, model-readable line.
 *
 * A detected binary is named by the tiny model (`rg`) but must be run through
 * `bash`, so the line shows the real invocation and names the binary it came
 * from. A plan the model cannot execute is worse than no plan.
 */
function renderStep(step: PlanStep, index: number): string {
	const stamp = `p=${step.toolProbability ?? 0}`;
	if (step.invokedAs === "bash" && step.example) {
		const command = JSON.stringify({ command: step.example });
		return `${index + 1}. bash ${command} (via ${step.tool}, ${stamp})`;
	}
	const args = Object.keys(step.args).length > 0 ? ` ${JSON.stringify(step.args)}` : "";
	return `${index + 1}. ${step.tool}${args} (${stamp})`;
}

/** Provenance the directive is allowed to state as fact. */
export interface DirectiveMeta {
	/** Wall-clock cost of both passes. */
	elapsedMs: number;
	/** How many buckets passed the gate, including any dropped in pass two. */
	requested: number;
}

/**
 * Build the block appended to the user's prompt.
 *
 * Three things are stated plainly because each was measured: the model is
 * Laya and not a text generator, its probabilities are raw and unfitted, and the
 * plan is advisory. A 421M decision model on buckets it has never been
 * fine-tuned for is a weak prior, and pretending otherwise would be malpractice
 * — Laya's own card reports 0.362 accuracy for the base English checkpoint on
 * typed decisions, below the 0.461 majority-class baseline.
 */
export function renderDirective(plan: PlanStep[], userPrompt: string, meta: DirectiveMeta): string {
	const lines = plan.map(renderStep);
	return [
		"",
		"<tiny-boss-plan>",
		`Laya, a local System One decision model (${FORWARD_PASSES} forward passes, ${meta.elapsedMs} ms,`,
		`offline, no API key), scored ${meta.requested} candidate need(s) and kept these.`,
		"The probabilities are raw and not temperature-fitted on your data.",
		"",
		...lines,
		"",
		"Use a tool only if it fits the work. Laya decides which kind of need exists",
		"first; it does not read files and it cannot see the repository. If a step is",
		"wrong, skip it and say why in one sentence.",
		"</tiny-boss-plan>",
		"",
		userPrompt,
	].join("\n");
}
