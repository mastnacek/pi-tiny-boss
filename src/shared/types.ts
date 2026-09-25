/**
 * Shared type kernel for pi-tiny-boss.
 * Slices import from here only — never from each other.
 */

/** One tool the tiny model is allowed to name. */
export interface ToolSpec {
	/** Tool name exactly as the coding model would call it. */
	name: string;
	/** One line, imperative, describing when to reach for it. */
	description: string;
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
	/** Tool name, or "none" when the tiny model thinks no tool is needed. */
	tool: string;
	/** Arguments it proposes, as a JSON-compatible object. */
	args: Record<string, unknown>;
	/** Short justification, shown to the coding model as a hint. */
	why: string;
	/** How to actually invoke it, when the manifest says so (a binary via bash). */
	invokedAs?: string;
	/** Ready-made invocation copied from the manifest. */
	example?: string;
}

/** The full plan plus the provenance the UI reports. */
export interface TinyPlan {
	steps: PlanStep[];
	/** Raw JSON the engine returned, for debugging. */
	raw: string;
	/** Wall-clock milliseconds the tiny model needed. */
	elapsedMs: number;
}

/**
 * The seam that makes the plugin testable: the planner never touches WASM,
 * it only talks to this interface, so tests inject a fake.
 */
export interface TinyEngine {
	/** Ask the tiny model for an ordered plan. Throws on engine failure. */
	plan(prompt: string, tools: ToolSpec[]): Promise<{ steps: PlanStep[]; raw: string }>;
	/** Release WASM resources. */
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
}
