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
			executionProviders?: string[];
			sessionOptions?: Record<string, unknown>;
		}): Promise<LayaSession>;
	};
}

/**
 * ONNX thread count, used by whichever part of the graph lands on the CPU.
 *
 * Measured on a 24-core / 32-thread i9-14900K, p50 for one plugin plan:
 *
 *   threads= 4   1131 ms      threads=16    671 ms
 *   threads= 8    781 ms      threads=24    578 ms   <- best
 *   threads=12    711 ms      threads=32    793 ms   <- all logical, worse
 *
 * The old default of 4 cost 2x for nothing. The optimum sat at the physical core
 * count, and going to every logical thread oversubscribed and lost 37% again. The
 * 0.75 factor reproduces that optimum here and stays below the logical count
 * everywhere else, which matters because this inference runs in the TUI process:
 * a plan that saturates every thread makes the user's own machine feel broken.
 */
export function recommendedThreads(logical: number): number {
	return Math.max(1, Math.min(32, Math.round(logical * 0.75)));
}

export function threadCount(): number {
	const override = Number(process.env.PI_TINY_BOSS_THREADS ?? "");
	if (Number.isInteger(override) && override > 0) return override;
	return recommendedThreads(cpus().length);
}

/** Execution providers the plugin may ask for. */
export type ProviderChoice = "auto" | "cpu" | "webgpu" | "dml";

const PROVIDERS: ProviderChoice[] = ["auto", "cpu", "webgpu", "dml"];

/** Parse `PI_TINY_BOSS_EP`, defaulting to `auto` for anything unrecognised. */
export function parseProvider(value: string | undefined): ProviderChoice {
	const trimmed = (value ?? "").trim().toLowerCase();
	return (PROVIDERS as string[]).includes(trimmed) ? (trimmed as ProviderChoice) : "auto";
}

/**
 * Providers to try, in order.
 *
 * `auto` prefers `webgpu` and falls back to `cpu`. The 5060 Ti this was measured
 * on answered a plan in 129 ms on webgpu against 509 ms on 24 CPU threads, with
 * probabilities matching to two decimals — so the GPU of an ordinary Windows
 * desktop is worth using, and it is reachable *without* CUDA: the published
 * `onnxruntime-node` bundles only `cpu`, `dml` and `webgpu`
 * (`listSupportedBackends()`), and there is no CUDA provider in the binary at all.
 *
 * `dml` is not in the auto chain despite also being bundled and also being a GPU
 * provider on paper: it builds a session and then dies on the first inference
 * (`Reshape` node, `MLOperatorAuthorImpl` 0x80070057). Loading is not evidence
 * that a provider works, which is why the probe below exists.
 */
export function providerOrder(choice: ProviderChoice): string[] {
	if (choice === "auto") return ["webgpu", "cpu"];
	return choice === "cpu" ? ["cpu"] : [choice];
}

/** The question the probe asks. Deliberately tiny: one two-option choice. */
const PROBE_STATE = "run the test suite";
const PROBE_QUESTIONS: Record<string, LayaQuestion> = {
	probe: { type: "choice", instructions: "Is this request asking to run something?", criteria: { A: "no", B: "yes" } },
};

/**
 * Prove a provider actually executes the graph, not merely that it loaded.
 *
 * One pass costs about 130 ms on the GPU and about 100 ms on the CPU once per
 * session, and it is the difference between a degraded fallback and a broken
 * prompt path: a provider that loads but cannot run a `Reshape` fails here, while
 * the caller still has a working engine to fall back to.
 */
async function probe(session: LayaSession): Promise<void> {
	const result = await session.systemOne(PROBE_STATE, PROBE_QUESTIONS);
	const answer = result.answers?.probe as Partial<LayaChoiceAnswer> | undefined;
	if (!answer || typeof answer.choice !== "string") {
		throw new Error("probe returned no choice");
	}
}

/**
 * Build a loaded engine from an already-verified cache.
 *
 * Throws `EngineUnavailableError("assets-missing")` when the bundle is not on
 * disk, which is the normal state before `/tiny-boss fetch` has ever run. The
 * check comes first because `Laya.load()` without `modelDir` would start a
 * 1.6 GB download from the prompt path.
 *
 * Providers are tried in order and each one is probed with a real decision before
 * it is accepted, so a provider that loads but cannot execute falls through to the
 * next instead of breaking the first prompt of the session.
 */
export async function createLayaEngine(): Promise<TinyEngine> {
	if (!(await assetsReady())) {
		throw new EngineUnavailableError(
			"Laya ONNX bundle is not cached — run /tiny-boss fetch (about 1.6 GB, once)",
			"assets-missing",
		);
	}

	let mod: LayaModule;
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
		mod = (await import("@receptron/laya")) as unknown as LayaModule;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new EngineUnavailableError(`@receptron/laya failed to load: ${message}`, "engine-error");
	}

	const requested = parseProvider(process.env.PI_TINY_BOSS_EP);
	const order = providerOrder(requested);
	const failures: string[] = [];

	for (const provider of order) {
		let session: LayaSession | undefined;
		try {
			session = await mod.Laya.load({
				modelDir: bundleDir(),
				executionProviders: [provider],
				sessionOptions: { intraOpNumThreads: threadCount() },
			});
			await probe(session);
			return makeEngine(session, provider);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// First line only: a failed provider reports a native stack that would
			// be unreadable in a notify, and the first line names the real cause.
			failures.push(`${provider}: ${message.split("\n")[0]}`);
			try {
				await session?.close();
			} catch {
				// teardown is best effort
			}
		}
	}

	throw new EngineUnavailableError(
		`no execution provider could run the model — ${failures.join("; ")}`,
		"engine-error",
	);
}

/** Wrap a probed session behind the seam the planner talks to. */
function makeEngine(session: LayaSession, provider: string): TinyEngine {
	return {
		provider,
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
