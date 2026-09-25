/**
 * needle3 engine: Emscripten WASM instantiation and one-shot planning.
 *
 * The real ABI, established by probing the shipped `needle.wasm` rather than
 * assumed — every earlier guess here was wrong:
 *
 *   _needle_load(modelPtr, modelLen: i64)  -> 0 on success
 *   _needle_init(systemPromptPtr, toolsJsonPtr) -> session handle
 *   _needle_complete(promptPtr, maxTokens, outPtr, outSize) -> tokens generated
 *
 * There is no `FS`, no `stringToUTF8` and no `_needle_last_error`. Errors come
 * back as a JSON envelope in the out buffer (`success`, `error`, `error_code`),
 * so failures are read from the reply rather than from a C error string.
 */

import { assetPath, readModelBytes, assetsReady } from "./assets.js";
import { pathToFileURL } from "node:url";
import { PLAN_SYSTEM_PROMPT, buildToolsJson } from "../../shared/plan-schema.js";
import { manifestTools } from "../../shared/manifest.js";
import type { PlanStep, TinyEngine, ToolSpec } from "../../shared/types.js";

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

/** The subset of the Emscripten module we actually call. */
interface NeedleModule {
	_malloc(size: number): number;
	_free(ptr: number): void;
	_needle_load(modelPtr: number, modelLen: bigint): number;
	_needle_init(systemPromptPtr: number, toolsJsonPtr: number): number;
	_needle_complete(promptPtr: number, maxTokens: number, out: number, outSize: number): number;
	_needle_reset(): void;
	UTF8ToString(ptr: number): string;
	HEAPU8: Uint8Array;
}

type NeedleFactory = (options: Record<string, unknown>) => Promise<NeedleModule> | NeedleModule;

/** Bytes reserved for the engine's JSON reply. */
const OUT_BUFFER_BYTES = 262144;

/**
 * Generation budget. needle3 reasons before it answers, so the budget is not
 * about output size: 512 tokens truncated mid tool-call on a 22-tool enum and
 * produced `error_code: "truncated"`. 1024 completes reliably.
 */
const MAX_TOKENS = 1024;

/**
 * C-string writer.
 *
 * The glue exports no `stringToUTF8`, so this encodes UTF-8 into a fresh malloc.
 * `HEAPU8` is re-read on every write: growing WASM memory detaches the old view,
 * and holding a stale one throws "detached ArrayBuffer".
 */
function makeEncoder(module: NeedleModule): (text: string) => number {
	return (text: string): number => {
		const bytes = new TextEncoder().encode(text);
		const ptr = module._malloc(bytes.length + 1);
		module.HEAPU8.set(bytes, ptr);
		module.HEAPU8[ptr + bytes.length] = 0;
		return ptr;
	};
}

/** Import the Emscripten glue and load the weights into the WASM heap. */
async function instantiate(): Promise<NeedleModule> {
	const jsPath = assetPath("needle.js");
	const wasmPath = assetPath("needle.wasm");
	// A bare Windows path is not a valid ESM specifier — the loader requires a
	// URL. pathToFileURL also handles the drive-letter case that hand-writing a
	// `file://` prefix gets wrong.
	const glue = (await import(pathToFileURL(jsPath).href)) as Record<string, unknown>;
	const createNeedle = (glue.default ?? glue.createNeedle) as NeedleFactory | undefined;
	if (typeof createNeedle !== "function") {
		throw new EngineUnavailableError("needle.js exports no createNeedle", "engine-error");
	}

	const module = await createNeedle({
		locateFile: (path: string) => (path.endsWith(".wasm") ? wasmPath : path),
	});

	// There is no Emscripten FS to preload into, so the weights go straight into
	// the heap. _malloc may grow memory, hence HEAPU8 is read afterwards.
	const modelBytes = await readModelBytes();
	const modelPtr = module._malloc(modelBytes.length);
	module.HEAPU8.set(modelBytes, modelPtr);
	const code = module._needle_load(modelPtr, BigInt(modelBytes.length));
	if (code !== 0) {
		throw new EngineUnavailableError(`needle_load returned ${code}`, "engine-error");
	}
	return module;
}

/** The error text needle3 reported, if the reply carries one. */
function replyError(raw: string): string | null {
	try {
		const parsed = JSON.parse(raw) as { success?: boolean; error?: unknown; error_code?: unknown };
		if (parsed?.success === true) return null;
		const message = typeof parsed?.error === "string" ? parsed.error : "unknown error";
		const code = typeof parsed?.error_code === "string" ? ` (${parsed.error_code})` : "";
		return `${message}${code}`;
	} catch {
		return null;
	}
}

/**
 * Build a ready-to-use engine.
 *
 * Throws EngineUnavailableError("assets-missing") when the cache is empty, which
 * is the normal state before `/tiny-boss fetch` has ever run.
 */
export async function createNeedleEngine(tools: ToolSpec[] = []): Promise<TinyEngine> {
	if (!(await assetsReady())) {
		throw new EngineUnavailableError(
			"needle3 assets are not cached — run /tiny-boss fetch",
			"assets-missing",
		);
	}

	let module: NeedleModule;
	try {
		module = await instantiate();
	} catch (error) {
		if (error instanceof EngineUnavailableError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new EngineUnavailableError(`engine load failed: ${message}`, "engine-error");
	}

	const encode = makeEncoder(module);

	// needle_init takes the manifest once, and the manifest is static for the
	// process, so this runs exactly once per session. The return value is a
	// session handle, not a status code: a negative value means failure.
	try {
		const handle = module._needle_init(
			encode(PLAN_SYSTEM_PROMPT),
			encode(buildToolsJson(manifestTools(tools))),
		);
		if (handle < 0) {
			throw new Error(`init handle ${handle}`);
		}
	} catch (error) {
		if (error instanceof EngineUnavailableError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new EngineUnavailableError(`needle_init failed: ${message}`, "engine-error");
	}

	return {
		plan: async (prompt: string, _tools: ToolSpec[]) => {
			const out = module._malloc(OUT_BUFFER_BYTES);
			try {
				module._needle_complete(encode(prompt), MAX_TOKENS, out, OUT_BUFFER_BYTES);
				const raw = module.UTF8ToString(out);
				const failure = replyError(raw);
				if (failure) throw new Error(`needle_complete: ${failure}`);
				// Parsing is the planner's job; hand back the raw JSON verbatim.
				return { steps: [] as PlanStep[], raw };
			} finally {
				module._free(out);
			}
		},
		close: async () => {
			try {
				module._needle_reset();
			} catch {
				// teardown is best effort
			}
		},
	};
}
