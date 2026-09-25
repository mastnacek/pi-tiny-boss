/**
 * Public boundary of the `discovery` slice.
 *
 * Turns "what is installed" into ToolSpec entries the planner can hand to
 * needle3. Imported only by the composition root, which then passes the result
 * down as data — no slice reaches into another.
 */

import { detectBinaries, resolveOnPath } from "./probe.js";
import { CATALOGUE, type CatalogueEntry } from "./catalogue.js";
import type { ToolSpec } from "../../shared/types.js";

export { CATALOGUE } from "./catalogue.js";
export { detectBinaries, resolveOnPath } from "./probe.js";
export type { DetectedBinary } from "./probe.js";

/**
 * Detected binaries as tools the tiny model may name.
 *
 * `name` is the binary, because that is what needle should reason about.
 * `invokedAs` records how the big model actually runs it — always `bash` here,
 * since pi has no tool for an arbitrary executable.
 */
export function systemTools(detected: Array<{ binary: string; entry: CatalogueEntry }>): ToolSpec[] {
	return detected.map(({ binary, entry }) => ({
		name: binary,
		description: entry.description,
		invokedAs: "bash",
		example: entry.example,
		source: "system" as const,
	}));
}

/** One-shot convenience for the command layer and the composition root. */
export function discoverSystemTools(pathEnv: string = process.env.PATH ?? ""): ToolSpec[] {
	return systemTools(detectBinaries(pathEnv));
}

/** One-line-per-entry report for `/tiny-boss tools`. */
export function formatDetection(
	detected: Array<{ binary: string; path: string }>,
	missing: string[],
): string {
	const lines: string[] = [];
	for (const { binary, path } of detected) {
		lines.push(`  ${binary.padEnd(12)} ${path}`);
	}
	if (missing.length > 0) {
		lines.push("");
		lines.push(`  not installed: ${missing.join(", ")}`);
	}
	return lines.join("\n");
}
