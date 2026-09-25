/**
 * The contract between the plugin and Laya.
 *
 * Lives in `shared/` because two slices need it: the planner renders the
 * questions, and the engine hands them to `systemOne`. Slices must not import
 * each other, so the shared piece goes here.
 *
 * ## Why this is two passes and not one
 *
 * The old needle3 schema asked a 121M generative model for a JSON array of tool
 * names, and it answered `{"steps": []}` for most prompts. Laya cannot generate
 * text at all — it scores a fixed set of options per question — so the question
 * *is* the schema, and the design constraint moves from "keep the JSON flat" to
 * "keep every option set inside Laya's budget".
 *
 * Laya's own model card is explicit about that budget: options share a fixed
 * `head_max_len` (192 tokens on the English checkpoint, and the ONNX port throws
 * rather than truncates past it), and accuracy falls off sharply past about 20
 * options — on Banking77, 72 options scored 0.870 while 77 scored 0.425. The
 * manifest here is 22 tools on a typical machine, so one flat "which tool"
 * question is exactly the shape the model card warns about. It also has no way
 * to order its answer.
 *
 * So the plan is assembled from two coarse-to-fine passes, which is the model
 * card's own recommended remedy:
 *
 *   pass 1 (one forward pass, 1 + N questions)
 *     `first`      one choice over the six buckets — which need comes first
 *     `need_<cat>` one two-option choice per bucket — is this need present at all
 *
 *   pass 2 (one forward pass, only the buckets pass 1 kept)
 *     `tool_<cat>` one choice over that bucket's own tools, never more than seven
 *
 * Every option set stays at seven or below, ordering comes from pass 1 rather
 * than from the model, and the independent yes/no gates replace the `none` tool
 * that needle3 needed because it could not say "no tool". Laya answers all of
 * pass 1 in a single forward pass, so the whole plan costs two ~35 ms passes.
 */

import type { LayaQuestion, ToolCategory, ToolSpec } from "./types.js";

/** Question key for the ordering decision in pass one. */
export const FIRST_QUESTION = "first";

/** Question key prefix for the per-bucket gates in pass one. */
export const GATE_PREFIX = "need_";

/** Question key prefix for the per-bucket tool choice in pass two. */
export const TOOL_PREFIX = "tool_";

/** Canonical bucket order. Also the order steps are emitted in, after `first`. */
export const CATEGORY_ORDER: ToolCategory[] = ["search", "read", "edit", "execute", "vcs", "data"];

/** The label Laya is shown for each bucket, plus the gate it is asked. */
export interface CategoryMeta {
	/** Key Laya answers with, and the bucket's public name. */
	label: string;
	/** Four to six words, for the `first` question's option text. */
	blurb: string;
	/**
	 * The gate, phrased as a single yes/no need.
	 *
	 * Written in the first person and about *this* need only, because the same
	 * state answers six of these questions in one pass and a shared "does this
	 * request need tools" framing makes them all collapse to yes.
	 */
	gate: string;
}

export const CATEGORY_META: Record<ToolCategory, CategoryMeta> = {
	search: {
		label: "search",
		blurb: "find code or files by pattern",
		gate: "I must locate files or code by searching, because I do not already know the exact path.",
	},
	read: {
		label: "read",
		blurb: "read a file I can name",
		gate: "I must read the contents of a file that is already known by name.",
	},
	edit: {
		label: "edit",
		blurb: "change or create code",
		gate: "I must change an existing file or create a new one.",
	},
	execute: {
		label: "execute",
		blurb: "run a command, test or build",
		gate: "I must run a command, a test suite, a build or a package manager.",
	},
	vcs: {
		label: "vcs",
		blurb: "git, branches, PRs and diffs",
		gate: "The request is about version control: commits, branches, pull requests, CI or diffs.",
	},
	data: {
		label: "data",
		blurb: "query JSON or YAML",
		gate: "I must query or transform JSON or YAML instead of reading it as plain text.",
	},
};

/** One bucket of tools that competes inside a single `choice` question. */
export interface ToolGroup {
	category: ToolCategory;
	meta: CategoryMeta;
	tools: ToolSpec[];
}

/**
 * A short option label for a tool.
 *
 * Explicit `short` when the manifest provides one; otherwise the first clause of
 * the description, capped at eight words. User-supplied tools take the derived
 * path, which is why the cap exists.
 */
export function shortLabel(tool: ToolSpec): string {
	if (tool.short && tool.short.trim().length > 0) return tool.short.trim();
	const first = tool.description.split(/[.;(]/)[0]?.trim() ?? tool.description;
	const words = first.split(/\s+/).slice(0, 8).join(" ");
	return words.length > 0 ? words : tool.name;
}

/**
 * Split the manifest into non-empty buckets, in canonical order.
 *
 * A tool with no `category` lands in `search`, which is the one bucket every
 * machine has something in — so an un-categorised user tool is still reachable
 * rather than silently invisible to the model.
 */
export function groupTools(tools: ToolSpec[]): ToolGroup[] {
	const byCategory = new Map<ToolCategory, ToolSpec[]>();
	for (const tool of tools) {
		const category = tool.category ?? "search";
		const bucket = byCategory.get(category);
		if (bucket) bucket.push(tool);
		else byCategory.set(category, [tool]);
	}
	const groups: ToolGroup[] = [];
	for (const category of CATEGORY_ORDER) {
		const bucket = byCategory.get(category);
		if (!bucket || bucket.length === 0) continue;
		groups.push({ category, meta: CATEGORY_META[category], tools: bucket });
	}
	return groups;
}

/** Answer key for the gate of one bucket. */
export function gateKey(category: ToolCategory): string {
	return `${GATE_PREFIX}${category}`;
}

/** Answer key for the tool choice inside one bucket. */
export function toolKey(category: ToolCategory): string {
	return `${TOOL_PREFIX}${category}`;
}

/**
 * Pass one: which need comes first, and which needs exist at all.
 *
 * The `first` option text is a blurb rather than the bucket name because
 * `search: search` tells the model nothing, and pass one's whole job is to pick
 * between six candidate needs on wording alone.
 */
export function stageOneQuestions(groups: ToolGroup[]): Record<string, LayaQuestion> {
	const questions: Record<string, LayaQuestion> = {};

	questions[FIRST_QUESTION] = {
		type: "choice",
		instructions:
			"For this request, which kind of work has to happen FIRST? Pick the one that is the unavoidable first move.",
		criteria: Object.fromEntries(groups.map((g) => [g.category, g.meta.blurb])),
	};

	for (const group of groups) {
		questions[gateKey(group.category)] = {
			type: "choice",
			instructions:
				`Consider only this one need on its own, and answer whether it is present in the request: ` +
				`"${group.meta.gate}"`,
			// Neutral keys, with the meaning in the descriptions. Laya's `noul`
			// primitive follows its own `false:` / `true:` labels on this
			// checkpoint, so the model card recommends exactly this shape.
			criteria: { A: "no, this need is not present", B: "yes, this need is present" },
		};
	}

	return questions;
}

/**
 * Pass two: name the concrete tool inside each bucket that survived pass one.
 *
 * Only the surviving buckets are asked, so a two-bucket plan costs two
 * questions and a six-bucket plan costs six — never more than the number of
 * buckets, and never more than seven options each.
 */
export function stageTwoQuestions(
	groups: ToolGroup[],
	categories: ToolCategory[],
): Record<string, LayaQuestion> {
	const wanted = new Set(categories);
	const questions: Record<string, LayaQuestion> = {};
	for (const group of groups) {
		if (!wanted.has(group.category)) continue;
		questions[toolKey(group.category)] = {
			type: "choice",
			instructions:
				`The request does need this kind of work: ${group.meta.blurb}. ` +
				"Which single tool is the best first choice for it? Pick exactly one.",
			criteria: Object.fromEntries(group.tools.map((t) => [t.name, shortLabel(t)])),
		};
	}
	return questions;
}

/** How many separate forward passes one plan costs. Reported by the planner. */
export const FORWARD_PASSES = 2;

/** Maximum number of steps in a plan. Matches the old needle3 cap. */
export const MAX_STEPS = 6;
