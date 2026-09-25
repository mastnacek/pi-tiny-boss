/**
 * needle3 engine: Emscripten WASM instantiation and one-shot planning.
 *
 * The C ABI is:
 *   _needle_init(systemPrompt, toolsJson, toolIndexPath) -> int
 *   _needle_complete(prompt, maxTokens, outBuf, outBufSize) -> int
 *   _needle_last_error() -> char*
 *   _needle_reset()
 *
 * Everything is defensive: this module is reached from the `input` hook, and an
 * exception here would surface as a broken session rather than a missing plan.
 */

import { assetPath, readModelBytes, assetsReady } from "./assets.js";
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
	FS?: { writeFile(path: string, data: Uint8Array): void };
	_malloc(size: number): number;
	_free(ptr: number): void;
	_needle_init(systemPrompt: number, toolsJson: number, toolIndexPath: number): number;
	_needle_complete(prompt: number, maxTokens: number, out: number, outSize: number): number;
	_needle_last_error(): number;
	_needle_reset(): void;
	stringToUTF8?(str: string, maxBytes?: number): number;
	UTF8ToString?(ptr: number): string;
	HEAPU8: Uint8Array;
	onRuntimeInitialized?: () => void;
	onAbort?: (reason: unknown) => void;
}

type NeedleFactory = (options: Record<string, unknown>) => Promise<NeedleModule> | NeedleModule;

/** Bytes reserved for the engine's JSON reply. */
const OUT_BUFFER_BYTES = 8192;
/** Generation cap. needle3 answers with a handful of fields, never prose. */
const MAX_TOKENS = 512;

/** C-string writer, falling back to Emscripten's allocator helpers. */
function makeEncoder(module: NeedleModule): (text: string) => number {
	if (typeof module.stringToUTF8 === "function") return (text) => module.stringToUTF8!(text);
	return (text) => {
		const bytes = new TextEncoder().encode(text);
		const ptr = module._malloc(bytes.length + 1);
		module.HEAPU8.set(bytes, ptr);
		module.HEAPU8[ptr + bytes.length] = 0;
		return ptr;
	};
}

/** C-string reader with a manual fallback. */
function makeDecoder(module: NeedleModule): (ptr: number) => string {
	if (typeof module.UTF8ToString === "function") return (ptr) => module.UTF8ToString!(ptr);
	return (ptr) => {
		if (!ptr) return "";
		const bytes = module.HEAPU8.slice(ptr);
		const end = bytes.indexOf(0);
		return new TextDecoder().decode(end >= 0 ? bytes.slice(0, end) : bytes);
	};
}

/** Import the Emscripten glue, preload the model, and wait for the runtime. */
async function instantiate(): Promise<NeedleModule> {
	const jsPath = assetPath("needle.js");
	const wasmPath = assetPath("needle.wasm");
	const glue = (await import(/* @vite-ignore */ jsPath)) as Record<string, unknown>;
	const createNeedle = (glue.default ?? glue.createNeedle) as NeedleFactory | undefined;
	if (typeof createNeedle !== "function") {
		throw new EngineUnavailableError("needle.js exports no createNeedle", "engine-error");
	}

	const modelBytes = await readModelBytes();
	const module = await createNeedle({
		locateFile: (path: string) => (path.endsWith(".wasm") ? wasmPath : path),
	});

	// Write the weights into the Emscripten virtual FS after construction: the
	// preRun hook runs before the factory resolves, so this ordering is the only
	// one that reliably lands the bytes in time for needle_init.
	try {
		module.FS?.writeFile("/needle3.cact", modelBytes);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new EngineUnavailableError(`model preload failed: ${message}`, "engine-error");
	}

	if (typeof module.onRuntimeInitialized === "function") {
		await new Promise<void>((resolve, reject) => {
			module.onRuntimeInitialized = () => resolve();
			module.onAbort = (reason) => reject(new Error(`WASM aborted: ${String(reason)}`));
		});
	}
	return module;
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
	const decode = makeDecoder(module);

	// needle_init takes the tool manifest once, and the manifest is static for
	// the process, so this runs exactly once per session.
	try {
		const code = module._needle_init(
			encode(PLAN_SYSTEM_PROMPT),
			encode(buildToolsJson(manifestTools(tools))),
			0,
		);
		if (code < 0) {
			throw new Error(decode(module._needle_last_error()) || `exit code ${code}`);
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
				const code = module._needle_complete(encode(prompt), MAX_TOKENS, out, OUT_BUFFER_BYTES);
				if (code < 0) {
					throw new Error(decode(module._needle_last_error()) || `exit code ${code}`);
				}
				// Parsing is the planner's job; hand back the raw JSON verbatim.
				return { steps: [] as PlanStep[], raw: decode(out) };
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
