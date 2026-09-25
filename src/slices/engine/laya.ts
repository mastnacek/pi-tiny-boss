/**
 * Laya engine: ONNX session over the exported checkpoint, and one batched
 * `systemOne` call per pass.
 *
 * Laya is a typed decision model, not a text generator. It scores a fixed set of
 * options per question and returns calibrated probabilities, so there is nothing
 * to parse and nothing to truncate — the failure mode that dominated needle3
 * (59% of replies ended in `error_code: "truncated"`) does not exist here.
 *
 * Two ABI facts are load-bearing, both taken from `@receptron/laya` rather than
 * guessed:
 *
 *   Laya.load({ modelDir })   no network at all when `modelDir` is given
 *   systemOne(state, qs)      every question of one call is batched into ONE
 *                             forward pass, and it THROWS when a question's
 *                             options exceed `head_max_len` rather than truncating
 *
 * The second one is why the decision schema keeps every option set small and
 * why an overflow is surfaced as a hard engine error instead of a silent
 * mis-decision.
 */

import { cpus } from "node:os";
import { assetsReady, bundleDir } from "./assets.js";
import type { LayaAnswers, LayaChoiceAnswer, LayaQuestion, TinyEngine } from "../../shared/types.js";

/** Raised when the engine cannot be built, so the hook can latch degradation. */
export class EngineUnavailableError extends Error {
	constructor(
		message: string,
		readonly reason: "assets-missing" | "engine-error",
	) {
		super(message);
		this.name = "EngineUnavailableError";
	}
}

/** The subset of the `@receptron/laya` surface we call. Declared structurally. */
interface LayaSession {
	systemOne(state: unknown, questions: Record<string, unknown>): Promise<{ answers: Record<string, unknown> }>;
	close(): Promise<void>;
}

interface LayaModule {
	Laya: {
		load(options: {
			modelDir: string;
			sessionOptions?: Record<string, unknown>;
		}): Promise<LayaSession>;
	};
}

/**
 * ONNX thread count.
 *
 * Deliberately not "all cores": this runs inside an interactive TUI where the
 * user is typing, and a 421M-parameter encoder saturating every core for a
 * speculative hint is a bad trade. Four threads keeps a pass in the tens of
 * milliseconds while leaving the machine usable.
 */
export function threadCount(): number {
	const override = Number(process.env.PI_TINY_BOSS_THREADS ?? "");
	if (Number.isInteger(override) && override > 0) return override;
	return Math.max(1, Math.min(4, cpus().length));
}

/**
 * Build a loaded engine from an already-verified cache.
 *
 * Throws `EngineUnavailableError("assets-missing")` when the bundle is not on
 * disk, which is the normal state before `/tiny-boss fetch` has ever run. The
 * check comes first because `Laya.load()` without `modelDir` would start a
 * 1.6 GB download from the prompt path.
 */
export async function createLayaEngine(): Promise<TinyEngine> {
	if (!(await assetsReady())) {
		throw new EngineUnavailableError(
			"Laya ONNX bundle is not cached — run /tiny-boss fetch (about 1.6 GB, once)",
			"assets-missing",
		);
	}

	let session: LayaSession;
	try {
		// Imported dynamically: onnxruntime-node loads a native binding, and a
		// machine where that fails must still load the extension and say so.
		//
		// SAFETY: `@receptron/laya` is a runtime dependency, and its published
		// `Laya` class is structurally wider than `LayaModule` above — it carries
		// tokenizer and config members this plugin never touches. The cast names the
		// subset actually called rather than depending on upstream's exact type
		// shape. A member renamed upstream surfaces as a load failure latched into
		// `engine-error`, not as a silent mis-decision.
		const mod = (await import("@receptron/laya")) as unknown as LayaModule;
		session = await mod.Laya.load({
			modelDir: bundleDir(),
			sessionOptions: { intraOpNumThreads: threadCount() },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new EngineUnavailableError(`Laya.load failed: ${message}`, "engine-error");
	}

	return {
		ask: async (state: string, questions: Record<string, LayaQuestion>): Promise<LayaAnswers> => {
			let result: { answers: Record<string, unknown> };
			try {
				result = await session.systemOne(state, questions);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// The one message worth translating: it means our option text no
				// longer fits the checkpoint's budget, which is our bug, not a
				// transient failure, and it must not be mistaken for one.
				const hint = /head_max_len/.test(message)
					? " (option text exceeds the checkpoint's head_max_len budget — shorten `short` labels)"
					: "";
				throw new Error(`systemOne: ${message}${hint}`);
			}
			return coerceAnswers(questions, result.answers);
		},
		close: async () => {
			try {
				await session.close();
			} catch {
				// teardown is best effort
			}
		},
	};
}

/**
 * Validate the reply before it reaches the planner.
 *
 * Laya answers every question it was given, and a missing or malformed answer
 * means the seam is broken rather than that the model produced junk. Junk from a
 * generative model degrades to "no plan"; a broken seam must be loud, so this
 * throws and the hook latches an engine error.
 */
function coerceAnswers(
	questions: Record<string, LayaQuestion>,
	answers: Record<string, unknown>,
): LayaAnswers {
	const out: LayaAnswers = {};
	for (const key of Object.keys(questions)) {
		const answer = answers[key] as Partial<LayaChoiceAnswer> | undefined;
		if (!answer || typeof answer.choice !== "string") {
			throw new Error(`systemOne returned no choice for question ${JSON.stringify(key)}`);
		}
		const probabilities: Record<string, number> = {};
		for (const [option, value] of Object.entries(answer.probabilities ?? {})) {
			if (typeof value === "number" && Number.isFinite(value)) probabilities[option] = value;
		}
		out[key] = {
			choice: answer.choice,
			probabilities,
			confidence: typeof answer.confidence === "number" ? answer.confidence : 0,
		};
	}
	return out;
}
