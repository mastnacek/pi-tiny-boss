/**
 * Catalogue of system binaries worth naming in a plan.
 *
 * Each entry is a *binary*, not a pi tool. The big model cannot call `rg`
 * directly — it calls `bash` — so every entry carries an `invokedAs` and a
 * ready-made `example` command. The plan renderer turns "use rg" into
 * `bash {"command":"rg ..."}`, which is something the model can actually run.
 *
 * `category` is not decoration: it is the bucket the tool competes in, and it is
 * what keeps every Laya option set at seven or fewer. `short` is the option text
 * Laya scores — a full `description` per option overflows `head_max_len`.
 *
 * Only binaries with a real quality advantage over the pi built-ins belong here.
 */

import type { ToolCategory } from "../../shared/types.js";

export interface CatalogueEntry {
	/** The binary name, as typed in a shell. */
	binary: string;
	/** Alternative spellings to probe, first hit wins. */
	aliases?: string[];
	/** One line: what it is for and why it beats the built-in. */
	description: string;
	/** Four to six words for the decision prompt's option text. */
	short: string;
	/** The bucket this binary competes in. */
	category: ToolCategory;
	/** A concrete invocation the plan can hand to bash verbatim. */
	example: string;
}

/** Probed in order; the first binary present on PATH wins for a given tool slot. */
export const CATALOGUE: CatalogueEntry[] = [
	{
		binary: "rg",
		aliases: ["ripgrep"],
		short: "regex content search, gitignore-aware and fast",
		category: "search",
		description:
			"Ripgrep. Recursive regex search that respects .gitignore, skips binaries and is far faster than the built-in grep.",
		example: 'rg -n --type ts "pattern" .',
	},
	{
		binary: "fd",
		aliases: ["fdfind"],
		short: "find files by name pattern, gitignore-aware",
		category: "search",
		description:
			"fd. Regex-based file finder that respects .gitignore and is faster than the built-in find.",
		example: 'fd -t ts "name-pattern"',
	},
	{
		binary: "sg",
		aliases: ["ast-grep"],
		short: "structural AST pattern search",
		category: "search",
		description:
			"ast-grep. Structural code search by AST pattern, immune to renames and formatting. Use when regex cannot pin the construct.",
		example: 'sg -p "pi.on($EVENT, $H)" -t ts',
	},
	{
		binary: "zoxide",
		short: "jump to a directory already visited",
		category: "search",
		description:
			"zoxide. Remembers directories you have visited. Use `z foo` to jump to a known path instead of hunting for it.",
		example: "z project-name",
	},
	{
		binary: "bat",
		aliases: ["batcat"],
		short: "print a file with syntax and line numbers",
		category: "read",
		description:
			"bat. cat with syntax highlighting and line numbers. Use instead of cat when reading source for a human.",
		example: "bat --style=numbers --paging=never path/to/file.ts",
	},
	{
		binary: "sd",
		short: "bulk find and replace of literal text",
		category: "edit",
		description:
			"sd. Simple find-and-replace with an intuitive syntax. Prefer over sed for bulk literal substitution.",
		example: 'sd "old text" "new text" file.ts',
	},
	{
		binary: "hyperfine",
		short: "benchmark a command with warmup",
		category: "execute",
		description:
			"hyperfine. Benchmark a command with warmup and repeated runs. Use to prove a change is actually faster.",
		example: 'hyperfine --warmup 3 "npm test"',
	},
	{
		binary: "just",
		short: "run a recipe from the justfile",
		category: "execute",
		description: "just. Command runner. Use when the repo has a justfile rather than inventing ad-hoc npm chains.",
		example: "just --list",
	},
	{
		binary: "uv",
		short: "fast Python environment and packages",
		category: "execute",
		description:
			"uv. Extremely fast Python package and environment manager. Prefer over pip and virtualenv when touching Python.",
		example: "uv run pytest",
	},
	{
		binary: "difft",
		aliases: ["difftastic", "dt"],
		short: "structural diff that understands syntax",
		category: "vcs",
		description:
			"difftastic. Structural diff that understands syntax trees. Use when reviewing a change, not to spot whitespace.",
		example: "difft --color never old new",
	},
	{
		binary: "delta",
		short: "syntax-highlighted git diff pager",
		category: "vcs",
		description:
			"git-delta. Syntax-aware git diff pager and syntax highlighter for git show and git diff output.",
		example: "git -c core.pager=delta diff",
	},
	{
		binary: "gh",
		short: "GitHub pull requests, issues and CI",
		category: "vcs",
		description: "GitHub CLI. Use for PRs, issues, CI runs and release notes instead of hand-crafting API calls.",
		example: "gh pr list --state open",
	},
	{
		binary: "jq",
		short: "filter and shape JSON",
		category: "data",
		description:
			"jq. Filter, shape and read JSON. Use for API responses and package manifests rather than grepping raw JSON.",
		example: 'jq ".packages[].source" settings.json',
	},
	{
		binary: "yq",
		short: "query and rewrite YAML",
		category: "data",
		description:
			"yq. Query and rewrite YAML with a jq-like syntax. Use for workflow files, compose files and frontmatter in YAML.",
		example: 'yq -p=y -o=json ".jobs" .github/workflows/ci.yml',
	},
	{
		binary: "sqlite3",
		short: "query a local SQLite database in place",
		category: "data",
		description: "sqlite3. Query a local SQLite database in place. Use for caches and state files that grew too big to read.",
		example: "sqlite3 path/to.db '.tables'",
	},
];
