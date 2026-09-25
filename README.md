# pi-tiny-boss

**A local System One decision model picks your tools before the big one does.**

Laya — a non-autoregressive decision model from Convai Innovations (Apache 2.0,
421M parameters for the English checkpoint) — reads your prompt on the `input`
hook, scores a short set of typed questions about which *kinds* of work it needs,
and the frontier model is handed the resulting tool plan instead of being left to
guess. It runs entirely offline through ONNX Runtime, costs nothing per call, and
never generates a token.

It cannot write your code and it cannot read your repository. It can tell the big
model which tools to reach for first.

> **The name is now a misnomer.** 0.1.0 ran `needle3`, a 121M model at 2 bits in
> 36 MB. Laya is 421M and its ONNX bundle is about **1.6 GB**. The package name,
> the `/tiny-boss` command and the `tiny_boss` tool kept their names on purpose:
> they are the install identity and the muscle memory attached to it. Renaming
> them would break every install record for a cosmetic gain, so the size is
> stated here instead of hidden behind a new name.
>
> **Measured 2026-09-25: 7/34 = 21% — the same accuracy needle3 scored, and the
> reason it was replaced.** The engine is fast, offline, failure-free and stable,
> and the base checkpoint is at chance on this task. Read
> [Measured quality](#measured-quality) before enabling it, and note the
> recommendation there.

## Why the engine changed

`needle3` was measured, and it did not work. From `npm run eval` on 34 labelled
prompts:

```
ACCURACY   7/34  =  21%
ERRORS    20/34  =  59%   needle_complete: tool call truncated: token budget exhausted
CONFIDENCE  mean 0.77 on all replies vs 0.73 on the wrong ones — not calibrated
```

| Category | Score |
| --- | --- |
| discussion (correct answer: nothing) | 3/12 |
| search | 2/7 |
| read | 2/4 |
| execute | 0/8 |
| edit | 0/3 |

Three findings killed it, and all three are in the git history rather than
forgotten:

1. **The token budget was not the lever.** 1024, 2048 and 4096 produced
   byte-identical replies; truncation was deterministic per prompt. A 2-bit
   generative model could not close a JSON array.
2. **A long session decayed into `none`.** The same prompt returned "no tools" every
   time after ~30 prior calls, whatever it said.
3. **Confidence was worse than useless** — higher on wrong answers than on right
   ones, which is why the old directive deliberately hid the number.

Laya removes all three by construction. It generates nothing, so there is nothing
to truncate. It is stateless per call. And its probabilities come from RLCD
training against strictly proper scoring rules, so they are *meant* to mean
something — with a documented caveat (below) that raw calibration is poor until
temperature-fitted on your own data.

## Why this needed a different design, not a port

You cannot swap the model and keep the schema:

- **Laya cannot emit a tool list.** It scores a fixed set of options per question.
  The question *is* the schema, so the old "ask for a JSON array of tool names"
  shape has no equivalent.
- **Option sets share a fixed budget.** Every question's options must fit inside
  `head_max_len` — 192 tokens on the English checkpoint — and the ONNX port throws
  rather than truncating. A full description per option overflows it.
- **Accuracy falls off past ~20 options.** Laya's own model card reports 0.870 on
  72 Banking77 labels and 0.425 on 77. A typical machine here has 22 tools, so one
  flat "which tool" question is exactly the shape the card warns about.
- **Laya has no way to order its answer.** The old model emitted a sequence.

So the plan is assembled from **two coarse-to-fine passes** in the prompt's
language rather than the model's:

```
pass 1   one forward pass, 1 + N questions
  first       one choice over the six buckets — which need comes first
  need_<cat>  one two-option choice per bucket — is this need present at all

pass 2   one forward pass, only the buckets pass 1 kept
  tool_<cat>  one choice over that bucket's own tools, never more than seven
```

Every option set stays at seven or below, ordering comes from pass 1 instead of
from the model, and the independent yes/no gates replace the `none` tool that
needle3 needed because it could not say "no tool". Pass 1's six gates all share
one forward pass, so a whole plan costs two passes.

The gates are deliberately **two-option `choice` questions with neutral `A` / `B`
keys**, not Laya's `noul` primitive. `noul` renders its options as `false:` /
`true:` and on this checkpoint can follow those labels instead of the state; the
model card's own remedy is exactly the A/B choice form used here.

## Install

```bash
pi install git:github.com/mastnacek/pi-tiny-boss
```

Then, once per machine:

```
/tiny-boss fetch      # downloads ~1.6 GB of ONNX weights into ~/.cache/receptron-laya
/tiny-boss warm       # loads the ONNX session now, so the next prompt does not pay for it
/tiny-boss status     # confirms the cache, the engine and the last plan
```

Until `fetch` has run, the plugin latches into a degraded state and passes every
prompt through untouched. It never downloads on the prompt path — not even a HEAD
request: `assetsReady()` is verified from disk before `Laya.load()` is called with
an explicit `modelDir`, because the library's own `ensureBundle` re-checks each
file against Hugging Face even on a warm cache.

### Choosing a checkpoint

The bundle layout is `@receptron/laya`'s, and this plugin follows it: a repo, a
revision, and an optional subfolder.

```
$cacheDir/$repo-with--dashes/$revision[/$subfolder]/
  laya.onnx  laya.onnx.data  laya_config.json  tokenizer/…
```

| Variable | Set by | Effect |
| --- | --- | --- |
| `LAYA_CACHE` | the library | moves the whole cache root |
| `PI_TINY_BOSS_SUBFOLDER` | this plugin | selects a checkpoint published under a subfolder |
| `PI_TINY_BOSS_MODEL_DIR` / `LAYA_MODEL_DIR` | this plugin | points at a directory outright, ignoring the layout |
| `HF_TOKEN` | the library | for a private repo |

The upstream repo publishes **only** the English checkpoint at its root, so the
default is the root and no subfolder is needed. `PI_TINY_BOSS_SUBFOLDER` exists
because the library takes `subfolder` as a call option and has no variable for it,
and the prompt path has no way to pass options through — without it the plugin
would be structurally unable to reach any checkpoint that is not at a repo root.
Changing it invalidates the fetch record, so the next `/tiny-boss status` reports
`MISSING` and asks for a fetch rather than silently loading the previous
checkpoint.

A bundle you exported yourself needs no subfolder at all — point
`PI_TINY_BOSS_MODEL_DIR` at the directory `export/export_onnx.py` wrote and there
is nothing to fetch:

```bash
PI_TINY_BOSS_SUBFOLDER=multilingual /tiny-boss fetch   # a published variant
PI_TINY_BOSS_MODEL_DIR=./my-export /tiny-boss warm      # your own export
```

## Commands

| Command | Effect |
| --- | --- |
| `/tiny-boss on` | plan every prompt (default) |
| `/tiny-boss off` | pass prompts through untouched |
| `/tiny-boss status` | engine state, cache size, last plan with its per-step probabilities |
| `/tiny-boss tools` | the decision buckets and which tools are in them here |
| `/tiny-boss fetch` | download the ONNX bundle (once, ~1.6 GB) |
| `/tiny-boss warm` | load the ONNX session now instead of on the next prompt |
| `/tiny-boss plan <prompt>` | dry run: show the plan, change nothing |

The model can also call the `tiny_boss` tool mid-turn to ask for a plan after the
hook has already passed — useful when a turn turns out to need different tools than
the opening prompt suggested.

## The decision buckets

Buckets exist because Laya degrades on large option sets. The built-ins and every
catalogue binary are assigned explicitly (`ToolSpec.category`), and a user tool
with no category lands in `search` rather than becoming invisible.

| Bucket | Holds | Asked |
| --- | --- | --- |
| `search` | grep, find, ls, rg, fd, sg, zoxide | *find code or files by pattern* |
| `read` | read, bat | *read a file I can name* |
| `edit` | edit, write, sd | *change or create code* |
| `execute` | bash, just, uv, hyperfine | *run a command, test or build* |
| `vcs` | gh, delta, difft | *git, branches, PRs and diffs* |
| `data` | jq, yq, sqlite3 | *query JSON or YAML* |

Only binaries actually present on your PATH join a bucket. `short` on each spec is
the option text Laya scores — a few words, not the full description, because the
full one overflows the budget.

## What gets injected

Real output from `assembleSteps` + `renderDirective`:

```
<tiny-boss-plan>
Laya, a local System One decision model (2 forward passes, 78 ms,
offline, no API key), scored 3 candidate need(s) and kept these.
The probabilities are raw and not temperature-fitted on your data.

1. bash {"command":"rg -n --type ts \"pattern\" ."} (via rg, p=0.74)
2. read (p=0.91)
3. edit (p=0.88)

Use a tool only if it fits the work. Laya decides which kind of need exists
first; it does not read files and it cannot see the repository. If a step is
wrong, skip it and say why in one sentence.
</tiny-boss-plan>

<your original prompt, verbatim>
```

A detected binary is named by the model (`rg`) but must be run through `bash`, so
the line shows the real invocation and names the binary it came from. A plan the
coding model cannot execute would be worse than no plan.

## Probabilities are shown now, and here is why

The old plugin hid needle3's confidence because it was anti-correlated with being
right. Laya's is not — its `confidence` reaches an AUROC of 0.77 on labelled
decision items, and `rl_agent.act_probability` is the field that carries no signal
(it reads 1.0 for almost everything, and the model card says so). This plugin
therefore reads `confidence` and the per-option probabilities, never
`act_probability`.

Two floors decide whether a bucket survives:

| Constant | Default | Meaning |
| --- | --- | --- |
| `MIN_GATE_PROBABILITY` | 0.5 | P(this need exists) before the bucket is kept |
| `MIN_TOOL_PROBABILITY` | 0.34 | P(this tool over its siblings) before the step is emitted |

**Both are conservative defaults, and the measurement below shows they do not
rescue accuracy.** The English checkpoint ships over-confident — its card reports
mean ECE 0.466 before temperature fitting and 0.081 after, per question type and
option count (`laya`) — so a bucket that merely leans yes is enough, and a
diffuse tool choice inside a bucket is dropped rather than forwarded as a
recommendation. `eval/gates.ts` sweeps 0.5 → 0.9 and prints precision and recall
at each, and `/tiny-boss status` prints the last plan's probabilities, so both
numbers are visible while you tune them.

The card also reports an AUROC of 0.77 for `confidence` on its own labelled
decision items, which is why the number was surfaced rather than hidden (as
needle3's was). **On this plugin's 34 prompts it does not hold**: the gate
probability averaged 0.32 when the gate was right and 0.39 when it was wrong, and
raising the floor trades recall for precision without ever reaching a useful
operating point (table below). The field is still surfaced because it is the one
field with a published signal; it is simply not one you can gate on yet.

## Design rules, enforced by tests

1. **Never throw.** A broken decision model must not break the session. Every
   failure path returns `{ action: "continue" }`.
2. **Never block past the budget.** Both Laya passes share one 4 s budget. The one
   exception is the session load, which happens once per process and is reported
   as `engineLoadMs` in `/tiny-boss status` rather than hidden.
3. **Never retry a latched failure.** Missing assets cost one failed call, not one
   per turn. `/tiny-boss fetch` or `/tiny-boss on` clears the latch.
4. **Never plan a slash command or a message under 24 characters.** A small model
   will answer a two-word prompt confidently, and that answer is noise.
5. **Validate every answer** against the bucket it was asked about. A tool name
   outside its own bucket is dropped, not forwarded.
6. **Cap the plan at six steps** — which the six buckets make structural.
7. **Never shadow a built-in.** Extras merge only into free names.
8. **Every option set stays at seven or fewer.** A test fails if a bucket grows.

## Architecture

Vertical slices, one dependency direction:

```
index.ts                 composition root — the only multi-slice importer
├── slices/engine/       Laya ONNX session, bundle layout, offline cache gate, fetch
├── slices/planner/      two-pass policy, validation, prompt rendering (pure)
├── slices/discovery/    PATH probe -> ToolSpec the decision model may name
├── slices/hook/         the `input` listener, planner injected
├── slices/commands/     /tiny-boss, dependencies injected
├── slices/tools/        the tiny_boss tool, dependencies injected
└── shared/              types, state, manifest, decision schema
```

The engine is reached only through the `TinyEngine` interface — one `ask(state,
questions)` method — so the whole test suite runs against a fake and never
downloads 1.6 GB. `shared/types.ts` declares Laya's question and answer shapes
structurally and `slices/engine/laya.ts` is the single place that casts to the real
ones, which keeps every other slice and every test independent of a native
dependency being loadable. 84 tests, no model download — and the one test that
does import the library skips rather than fails when the native binding is broken,
which is the same property the plugin itself has.

## Measured quality

**Run 2026-09-25 on the machine this was built on. Laya does not work here
either, and the honest recommendation is `/tiny-boss off`.**

The engine side is genuinely better than needle3 in every respect that is not
accuracy: 0/34 errors against 20/34 truncated replies, byte-stable answers across
repeated calls (no session decay), 1.0 s p50 for two passes against 0.2–2.1 s for
one, and probabilities that come from a model trained to report them. The
accuracy is the same 21%.

```
ACCURACY   7/34  =  21%
ERRORS     0/34  =   0%     (needle3: 20/34 truncation)
DISCUSSION 4/12 prompts that need no tools produced no plan
LATENCY    p50 1046ms  p90 1485ms  max 1719ms   (both passes, 4 CPU threads)
```

| Category | Score |
| --- | --- |
| discussion (correct answer: nothing) | 4/12 |
| search | 1/7 |
| read | 1/4 |
| edit | 1/3 |
| execute | 0/8 |

Gate-level, which is where the design lives:

```
  bucket    expected  fired   hit   precision  recall
  search          10      6     3        50%   30%
  read            10      3     1        33%   10%
  edit             4      6     2        33%   50%
  execute          8      9     6        67%   75%
  vcs              0     15     0         0%    -
  data             1      1     0         0%    0%
  overall         33     40    12        30%   36%
            28 false positives, 21 misses
```

`vcs` is the loudest single defect: it fired on 15 of 34 prompts while being
wanted on none, and it is the bucket `first` answers with for garbage input.
Raising `MIN_GATE_PROBABILITY` buys precision by spending recall, and never
reaches an operating point worth shipping:

```
  threshold  precision  recall   tp   fp   fn
       0.50       30%     36%   12   28   21
       0.60       42%     24%    8   11   25
       0.70       50%     12%    4    4   29
       0.80       50%      6%    2    2   31
       0.90        0%      0%    0    1   33
```

### What the measurement ruled out

Three tempting explanations were tested rather than assumed, and all three are
wrong. Each produced exactly the same 7/34:

1. **Batching.** Asking each gate in its own forward pass returns
   byte-identical probabilities to the batched pass, so six questions in one pass
   is not mixing them up. The two-pass design is sound and stays.
2. **Option position.** Swapping which key means yes (the model card's own example
   uses `A` = yes; this plugin ships `B` = yes) changes individual probabilities
   and leaves the score at 21%.
3. **The `choice`-instead-of-`noul` workaround.** `noul` — the primitive the card
   rates highest (0.857) and which this design deliberately avoided because it can
   follow its own `false:` / `true:` labels — scores the same 21%, with gate
   precision 29% / recall 24% and mean P(true) 0.31 on real needs against 0.24 on
   needs that are not real. The avoided primitive was not the problem.

What is left is the explanation the model card already gave: **the base English
checkpoint is near chance at typed decisions zero-shot** — 0.362 accuracy against
a 0.461 majority-class baseline in its own card, versus 0.766 for a checkpoint
fine-tuned on that benchmark's training split. A continuous spread of
probabilities that does not align with truth is what near-chance looks like.

Short garbage still gets a confident answer — 10 of 11 sub-24-character inputs
passed a gate, every one of them resolving to `gh` — so the 24-character gate in
the hook is what protects a session, not the model's judgement. That was true of
needle3 and it is true here.

### The identified next step

The gap is the checkpoint, not the design, but closing it is not a one-line
change: `receptron/laya-onnx` publishes **only** the English checkpoint at its
root — there is no `multilingual` and no `typed-decisions` subfolder, despite the
library's README naming `subfolder: "multilingual"` as an option. Exporting the
fine-tuned [`laya-typed-decisions`](https://huggingface.co/convaiinnovations/laya-typed-decisions)
checkpoint means running `@receptron/laya`'s `export/export_onnx.py` yourself
(Python, torch, onnxscript). Then either point `PI_TINY_BOSS_MODEL_DIR` straight at
the output, or publish it under a subfolder the way the library documents and set
`PI_TINY_BOSS_SUBFOLDER` to match. That is the experiment this harness exists to
evaluate:

```bash
npm run eval          # writes eval/out.json, scores it, writes eval/gates.json
```

Both files are committed, so the numbers above are auditable and a re-run is
comparable rather than a fresh claim.

## Honest limitations

- **About 1.6 GB of weights and 2 GB of RAM.** fp32 ONNX, no quantised bundle
  published. The one-time session load is seconds, not milliseconds.
- **Two passes cost about a second on CPU** (p50 1046 ms, p90 1485 ms over 34
  prompts, 4 threads). The card's 32.8 ms is a T4 GPU figure; expect roughly
  an order of magnitude more on CPU, which still fits the 4 s budget but not
  comfortably.
- **The prompt is truncated at 512 tokens** for the English checkpoint, after the
  question header. Laya sees the opening of a long prompt, not all of it.
- **English by default.** The multilingual checkpoint (`laya-multilingual`, 322M,
  1024 to 8192 context) is reachable through `PI_TINY_BOSS_SUBFOLDER`, but may not
  be *published* — upstream serves only the English bundle, so selecting it means
  exporting it yourself first. The English checkpoint's 512-token state limit and
  its routing assumptions are what the default configuration runs on.
- **No arguments are proposed.** Laya picks tools, not invocations. Everything
  renders as a bare tool name except the catalogue binaries, which carry a
  ready-made example command.
- **One plan per prompt.** The `input` hook sees the opening prompt; it does not
  re-plan when a turn changes shape. That is what the `tiny_boss` tool is for.
- **Buckets are curated, not discovered from pi.** Pi does not expose the live tool
  registry to extensions, so the built-in seven are hand-written and the rest is
  probed from your own PATH.
- **The plugin does not own the weight cache.** `@receptron/laya` owns the layout,
  the download and the freshness check. This plugin *mirrors* the directory rule
  because `import "@receptron/laya"` loads a native ONNX binding and the offline
  gate has to run before anything may load. A mirror is only acceptable if it is
  verifiable, so: the cache root, repo id and file list are cross-checked against
  the library's own exports by `test/layout.test.js` whenever the package is
  loadable, and `/tiny-boss fetch` records the directory **and the file list the
  library actually returned**. The record is preferred over the mirror, so an
  upstream layout change is corrected by the next fetch instead of silently
  pointing the gate at the wrong directory. The one thing the mirror does not
  reproduce is the trailing path separator of the library's return value — same
  directory, and `path.resolve` in `Laya.load` normalises it.
- **Subagent sessions are skipped** by design — a delegation guard keeps child
  sessions from double-planning.

## Credits

- [Laya](https://github.com/NandhaKishorM/laya) — Convai Innovations, Apache 2.0
  weights, non-autoregressive System One decisions.
- [`@receptron/laya`](https://github.com/receptron/laya) — MIT, the Node/ONNX port
  this plugin runs (`0.1.2` at the time of the run above).
- [Cactus Compute](https://cactuscompute.com/needle) — needle3, the engine this
  replaced, with the measured failure that justified the switch.
