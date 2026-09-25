/**
 * Catalogue of system binaries worth naming in a plan.
 *
 * Each entry is a *binary*, not a pi tool. The big model cannot call `rg`
 * directly — it calls `bash` — so every entry carries an `invokedAs` and a
 * ready-made `example` command. The plan renderer turns "use rg" into
 * `bash {"command":"rg ..."}`, which is something the model can actually run.
 *
 * Only binaries with a real quality advantage over the pi built-ins belong
 * here. needle3 sees this list, and a longer list makes a 121M model worse.
 */

export interface CatalogueEntry {
	/** The binary name, as typed in a shell. */
	binary: string;
	/** Alternative spellings to probe, first hit wins. */
	aliases?: string[];
	/** One line: what it is for and why it beats the built-in. */
	description: string;
	/** A concrete invocation the plan can hand to bash verbatim. */
	example: string;
}

/** Probed in order; the first binary present on PATH wins for a given tool slot. */
export const CATALOGUE: CatalogueEntry[] = [
	{
		binary: "rg",
		aliases: ["ripgrep"],
		description:
			"Ripgrep. Recursive regex search that respects .gitignore, skips binaries and is far faster than the built-in grep.",
		example: 'rg -n --type ts "pattern" .',
	},
	{
		binary: "fd",
		aliases: ["fdfind"],
		description:
			"fd. Regex-based file finder that respects .gitignore and is faster than the built-in find.",
		example: 'fd -t ts "name-pattern"',
	},
	{
		binary: "bat",
		aliases: ["batcat"],
		description:
			"bat. cat with syntax highlighting and line numbers. Use instead of cat when reading source for a human.",
		example: "bat --style=numbers --paging=never path/to/file.ts",
	},
	{
		binary: "yq",
		description:
			"yq. Query and rewrite YAML with a jq-like syntax. Use for workflow files, compose files and frontmatter in YAML.",
		example: 'yq -p=y -o=json ".jobs" .github/workflows/ci.yml',
	},
	{
		binary: "jq",
		description:
			"jq. Filter, shape and read JSON. Use for API responses and package manifests rather than grepping raw JSON.",
		example: 'jq ".packages[].source" settings.json',
	},
	{
		binary: "sd",
		description:
			"sd. Simple find-and-replace with an intuitive syntax. Prefer over sed for bulk literal substitution.",
		example: 'sd "old text" "new text" file.ts',
	},
	{
		binary: "difft",
		aliases: ["difftastic", "dt"],
		description:
			"difftastic. Structural diff that understands syntax trees. Use when reviewing a change, not to spot whitespace.",
		example: "difft --color never old new",
	},
	{
		binary: "delta",
		description:
			"git-delta. Syntax-aware git diff pager and syntax highlighter for git show and git diff output.",
		example: "git -c core.pager=delta diff",
	},
	{
		binary: "hyperfine",
		description:
			"hyperfine. Benchmark a command with warmup and repeated runs. Use to prove a change is actually faster.",
		example: 'hyperfine --warmup 3 "npm test"',
	},
	{
		binary: "sg",
		aliases: ["ast-grep"],
		description:
			"ast-grep. Structural code search by AST pattern, immune to renames and formatting. Use when regex cannot pin the construct.",
		example: 'sg -p "pi.on($EVENT, $H)" -t ts',
	},
	{
		binary: "zoxide",
		description:
			"zoxide. Remembers directories you have visited. Use `z foo` to jump to a known path instead of hunting for it.",
		example: "z project-name",
	},
	{
		binary: "just",
		description: "just. Command runner. Use when the repo has a justfile rather than inventing ad-hoc npm chains.",
		example: "just --list",
	},
	{
		binary: "gh",
		description: "GitHub CLI. Use for PRs, issues, CI runs and release notes instead of hand-crafting API calls.",
		example: "gh pr list --state open",
	},
	{
		binary: "uv",
		description:
			"uv. Extremely fast Python package and environment manager. Prefer over pip and virtualenv when touching Python.",
		example: "uv run pytest",
	},
	{
		binary: "sqlite3",
		description: "sqlite3. Query a local SQLite database in place. Use for caches and state files that grew too big to read.",
		example: "sqlite3 path/to.db '.tables'",
	},
];
