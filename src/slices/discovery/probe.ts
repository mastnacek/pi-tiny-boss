/**
 * PATH probe for the catalogue binaries.
 *
 * No shelling out and no `which`: this walks PATH once and stats candidates.
 * The PATH source is a parameter so the tests never depend on the machine.
 */

import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { CatalogueEntry } from "./catalogue.js";
import { CATALOGUE } from "./catalogue.js";

/** A binary that was actually found. */
export interface DetectedBinary {
	binary: string;
	path: string;
	entry: CatalogueEntry;
}

/** Extensions a command may carry on Windows. */
function candidateExtensions(pathEnv: string, pathext: string): string[] {
	if (!delimiter) return [""];
	const exts = pathext
		.split(";")
		.map((e) => e.trim())
		.filter(Boolean);
	return exts.length > 0 ? ["", ...exts] : [""];
}

/** Resolve one command name against a PATH string. */
export function resolveOnPath(
	name: string,
	pathEnv: string,
	pathext = process.env.PATHEXT ?? ".EXE;.CMD;.BAT",
): string | undefined {
	const dirs = pathEnv.split(delimiter).filter(Boolean);
	for (const dir of dirs) {
		for (const ext of candidateExtensions(pathEnv, pathext)) {
			const candidate = join(dir, name + ext);
			try {
				if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
			} catch {
				// unreadable entry: keep walking
			}
		}
	}
	return undefined;
}

/**
 * Probe every catalogue entry, honouring aliases.
 *
 * The first name that resolves wins, so an explicit `rg` beats a stray alias.
 */
export function detectBinaries(
	pathEnv: string = process.env.PATH ?? "",
	pathext?: string,
	catalogue: CatalogueEntry[] = CATALOGUE,
): DetectedBinary[] {
	const found: DetectedBinary[] = [];
	for (const entry of catalogue) {
		const names = [entry.binary, ...(entry.aliases ?? [])];
		for (const name of names) {
			const resolved = resolveOnPath(name, pathEnv, pathext);
			if (resolved) {
				found.push({ binary: entry.binary, path: resolved, entry });
				break;
			}
		}
	}
	return found;
}
