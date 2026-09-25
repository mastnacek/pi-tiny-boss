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
	},
	{
		name: "find",
		description: "List files and directories by name pattern. Use to map a tree without reading it.",
	},
	{
		name: "read",
		description: "Read a file with optional offset and limit. Use to inspect code before judging it.",
	},
	{
		name: "edit",
		description: "Replace an exact string in an existing file. Use for surgical changes.",
	},
	{
		name: "write",
		description: "Create or overwrite a whole file. Use for new files only.",
	},
	{
		name: "bash",
		description: "Run a shell command. Use for tests, builds, git and package managers.",
	},
	{
		name: "ls",
		description: "List one directory level. Use when you only need the immediate shape.",
	},
];

/** Tools this plugin itself offers the tiny boss for self-reporting. */
export const SELF_TOOLS: ToolSpec[] = [
	{
		name: "none",
		description:
			"No tool is needed. Use when the request is a question, a discussion, or plain text to answer.",
	},
];

/** The manifest actually passed to the engine. */
export function manifestTools(): ToolSpec[] {
	return [...SELF_TOOLS, ...BUILTIN_TOOLS];
}

/** Names the engine is allowed to emit, for validating its output. */
export function allowedToolNames(): Set<string> {
	return new Set(manifestTools().map((t) => t.name));
}
