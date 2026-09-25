/**
 * Shared type kernel for pi-tiny-boss.
 * Slices import from here only — never from each other.
 *
 * The kernel is deliberately free of any `@receptron/laya` import. Laya's own
 * `Question` / `ChoiceAnswer` types are declared structurally below, and the
 * engine slice is the single place that casts them to the real ones. That keeps
 * every other slice — and the whole test suite — independent of a 1.7 GB native
 * dependency being installed and loadable.
 */

/** The buckets the manifest is split into, because Laya degrades past ~20 options. */
export type ToolCategory = "search" | "read" | "edit" | "execute" | "vcs" | "data";

/** One tool the tiny model is allowed to name. */
export interface ToolSpec {
	/** Tool name exactly as the coding model would call it. */
	name: string;
	/** One line, imperative, describing when to reach for it. */
	description: string;
	/**
	 * A few words for the decision prompt.
	 *
	 * Laya scores every option inside a fixed `head_max_len` (192 tokens), so a
	 * full `description` per option overflows the budget and makes `ask` throw.
	 * Kept explicit rather than derived, because truncating a sentence produces
	 * labels like "Ripgrep" that carry nothing to decide on.
	 */
	short?: string;
	/** Which decision bucket this tool competes in. Defaults to `search`. */
	category?: ToolCategory;
	/**
	 * How the coding model actually runs this, when it differs from `name`.
	 * A detected binary is named `rg` but must be invoked as `bash`.
	 */
	invokedAs?: string;
	/** A ready-made invocation, handed to the model verbatim. */
	example?: string;
	/** Provenance, for `/tiny-boss tools`. */
	source?: "builtin" | "system" | "user";
}

/** A single step of the plan the tiny model produced. */
export interface PlanStep {
	/** Tool name. */
	tool: string;
	/** Arguments it proposes, as a JSON-compatible object. */
	args: Record<string, unknown>;
	/** Short justification, shown to the coding model as a hint. */
	why: string;
	/** How to actually invoke it, when the manifest says so (a binary via bash). */
	invokedAs?: string;
	/** Ready-made invocation copied from the manifest. */
	example?: string;
	/** Which decision bucket it came from, for the status display. */
	category?: ToolCategory;
	/** P(that bucket was needed), straight from Laya and not temperature-fitted. */
	gateProbability?: number;
	/** P(this tool over its siblings in the bucket). */
	toolProbability?: number;
}

/** The full plan plus the provenance the UI reports. */
export interface TinyPlan {
	steps: PlanStep[];
	/** Answer probabilities, for debugging. Never leaves `details`. */
	raw: string;
	/** Wall-clock milliseconds the tiny model needed, both passes included. */
	elapsedMs: number;
}

// --- the Laya seam -------------------------------------------------------

/**
 * A `choice` question, structurally identical to `@receptron/laya`'s.
 *
 * Only `choice` is used. Laya's `noul` primitive has a documented defect on the
 * English checkpoint (it follows its own `false:` / `true:` labels rather than
 * the state), and the checkpoint's own model card recommends asking the same
 * thing as a two-option `choice` with neutral keys. That is what the gates are.
 */
export interface LayaQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

/** Laya's answer to one `choice` question. */
export interface LayaChoiceAnswer {
	choice: string;
	/** Probability per option key, temperature-scaled by the checkpoint. */
	probabilities: Record<string, number>;
	/** 1 - normalised entropy. Reported, and used as the confidence floor. */
	confidence: number;
}

/** One forward pass: answer every question about `state`, batched. */
export type LayaAnswers = Record<string, LayaChoiceAnswer>;

/**
 * The seam that makes the plugin testable: the planner never touches ONNX, it
 * only talks to this interface, so tests inject a fake and never download 1.7 GB.
 */
export interface TinyEngine {
	/** Answer every question in one forward pass. Throws on engine failure. */
	ask(state: string, questions: Record<string, LayaQuestion>): Promise<LayaAnswers>;
	/** Release the ONNX session. */
	close(): Promise<void>;
}

/** Why the plugin is not planning right now. */
export type DegradedReason =
	| "disabled"
	| "assets-missing"
	| "engine-error"
	| "no-plan"
	| "subagent";

export interface TinyBossState {
	/** Master switch, flipped by `/tiny-boss on|off`. */
	enabled: boolean;
	/** Set once the engine fails, so we stop retrying on every prompt. */
	degraded: DegradedReason | null;
	/** Last human-readable failure, shown by `/tiny-boss status`. */
	lastError: string | null;
	/** Timestamp of the last successful plan. */
	lastRunTimestamp: number;
	/** How many prompts the tiny boss has planned. */
	planCount: number;
	/** The most recent plan, restored for status display. */
	lastPlan: TinyPlan | null;
	/** Lazily-created engine, kept across prompts for latency. */
	engine: TinyEngine | null;
	/**
	 * How long the one-time ONNX session load took.
	 *
	 * Reported because it is the only call that violates "never block": a cold
	 * load costs seconds, and a user deserves to see the number rather than
	 * wonder why one prompt felt slow.
	 */
	engineLoadMs: number | null;
}
