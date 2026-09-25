/**
 * The tool manifest handed to the tiny model.
 *
 * Curated, not discovered: pi does not expose the live tool registry to
 * extensions, and needle3 is only useful with a SHORT list. A 40-tool manifest
 * on a 121M model produces confident nonsense, so this stays deliberately small
 * and is extended by hand when a new tool earns a slot.
 */

import type { ToolSpec } from "./types.js";

/** Built-in pi tools, described the way a planner would pick them. */
export const BUILTIN_TOOLS: ToolSpec[] = [
	{
		name: "grep",
		description: "Search file contents by regular expression. Use to locate where something lives.",
		source: "builtin",
	},
	{
		name: "find",
		description: "List files and directories by name pattern. Use to map a tree without reading it.",
		source: "builtin",
	},
	{
		name: "read",
		description: "Read a file with optional offset and limit. Use to inspect code before judging it.",
		source: "builtin",
	},
	{
		name: "edit",
		description: "Replace an exact string in an existing file. Use for surgical changes.",
		source: "builtin",
	},
	{
		name: "write",
		description: "Create or overwrite a whole file. Use for new files only.",
		source: "builtin",
	},
	{
		name: "bash",
		description: "Run a shell command. Use for tests, builds, git and package managers.",
		source: "builtin",
	},
	{
		name: "ls",
		description: "List one directory level. Use when you only need the immediate shape.",
		source: "builtin",
	},
];

/** Tools this plugin itself offers the tiny boss for self-reporting. */
export const SELF_TOOLS: ToolSpec[] = [
	{
		name: "none",
		description:
			"No tool is needed. Use when the request is a question, a discussion, or plain text to answer.",
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
	const merged: ToolSpec[] = [...SELF_TOOLS, ...BUILTIN_TOOLS];
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
