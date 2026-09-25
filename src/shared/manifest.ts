/**
 * The tool manifest handed to the tiny model.
 *
 * Curated, not discovered: pi does not expose the live tool registry to
 * extensions, so the built-ins below are hand-written and the rest is probed
 * from PATH. The list stays short on purpose — Laya's own model card puts the
 * reliability ceiling near twenty options, and the decision schema splits it
 * into buckets rather than asking one flat question.
 */

import type { ToolSpec } from "./types.js";

/** Built-in pi tools, described the way a planner would pick them. */
export const BUILTIN_TOOLS: ToolSpec[] = [
	{
		name: "grep",
		short: "regex content search, built in",
		category: "search",
		description: "Search file contents by regular expression. Use to locate where something lives.",
		source: "builtin",
	},
	{
		name: "find",
		short: "list files by name pattern, built in",
		category: "search",
		description: "List files and directories by name pattern. Use to map a tree without reading it.",
		source: "builtin",
	},
	{
		name: "ls",
		short: "list one directory level",
		category: "search",
		description: "List one directory level. Use when you only need the immediate shape.",
		source: "builtin",
	},
	{
		name: "read",
		short: "read a file with offset and limit",
		category: "read",
		description: "Read a file with optional offset and limit. Use to inspect code before judging it.",
		source: "builtin",
	},
	{
		name: "edit",
		short: "replace an exact string in an existing file",
		category: "edit",
		description: "Replace an exact string in an existing file. Use for surgical changes.",
		source: "builtin",
	},
	{
		name: "write",
		short: "create or overwrite a whole file",
		category: "edit",
		description: "Create or overwrite a whole file. Use for new files only.",
		source: "builtin",
	},
	{
		name: "bash",
		short: "run a shell command",
		category: "execute",
		description: "Run a shell command. Use for tests, builds, git and package managers.",
		source: "builtin",
	},
];

/**
 * The manifest actually passed to the engine.
 *
 * `extras` are discovered system binaries and user-configured tools. Built-ins
 * win on a name clash: a configured `read` must never shadow the real tool.
 */
export function manifestTools(extras: ToolSpec[] = []): ToolSpec[] {
	const merged: ToolSpec[] = [...BUILTIN_TOOLS];
	const seen = new Set(merged.map((t) => t.name));
	for (const tool of extras) {
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		merged.push(tool);
	}
	return merged;
}

/** Names the engine is allowed to emit, for validating its output. */
export function allowedToolNames(extras: ToolSpec[] = []): Set<string> {
	return new Set(manifestTools(extras).map((t) => t.name));
}
