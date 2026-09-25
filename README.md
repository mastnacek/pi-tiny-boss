# pi-tiny-boss

**A 121M-parameter model picks your tools before the big one does.**

`needle3` — a 2-bit, 8–29 MB tool-calling model from Cactus Compute — reads your
prompt on the `input` hook, emits a short ordered tool plan, and the frontier
model is handed that plan instead of being left to guess. It runs entirely
offline, costs nothing per call, and is hilariously small.

It cannot write your code. It can tell the big model which three tools to reach
for first.

## Why this is a real idea

A frontier model spends most of its reasoning budget rediscovering the shape of
a problem before it touches anything. A 121M tool-calling model answers exactly
one narrow question — *given this request, which tools, in what order* — in
milliseconds, for free, with no data leaving the machine. The expensive model
starts from a plan instead of from nothing.

The plan is **advisory**. The injected block tells the coding model it may
deviate and say why. A 121M model is wrong often enough that pretending
otherwise would be malpractice.

## Install

```bash
pi install git:github.com/mastnacek/pi-tiny-boss
```

Then, once per machine:

```
/tiny-boss fetch      # downloads ~36 MB into ~/.cache/pi-tiny-boss/needle/
/tiny-boss status     # confirms the cache and shows the last plan
```

Until `fetch` has run, the plugin latches into a degraded state and passes every
prompt through untouched. It never downloads on the prompt path.

## Commands

| Command | Effect |
| --- | --- |
| `/tiny-boss on` | plan every prompt (default) |
| `/tiny-boss off` | pass prompts through untouched |
| `/tiny-boss status` | engine state, asset cache, last plan, last error |
| `/tiny-boss tools` | list the system binaries needle3 may name on this machine |
| `/tiny-boss fetch` | download the needle3 assets (once) |
| `/tiny-boss plan <prompt>` | dry run: show the plan, change nothing |

The model can also call the `tiny_boss` tool mid-turn to ask for a plan after
the hook has already passed — useful when a turn turns out to need different
tools than the opening prompt suggested.

## What gets injected

```
<tiny-boss-plan>
A 121M local model (needle3) planned this before you woke up. It costs nothing
and runs offline, but it is small and it is sometimes wrong.

1. grep {"pattern":"pi.on\\("} — find the lifecycle subscriptions
2. read {"path":"src/slices/hook/index.ts"} — confirm they are drained

Use this plan as a strong hint, not an order. If a step is wrong or the work needs
a different approach, deviate and say why in one sentence.
</tiny-boss-plan>

<your original prompt, verbatim>
```

## Design rules, enforced by tests

1. **Never throw.** A broken tiny model must not break the session. Every failure
   path returns `{ action: "continue" }`.
2. **Never block.** The planning budget is 4 s; past that the prompt goes through
   untouched.
3. **Never retry a latched failure.** Missing assets cost one failed call, not one
   per turn. `/tiny-boss fetch` clears the latch.
4. **Never plan a slash command or a message under 24 characters.** A 121M model
   will answer a two-word prompt confidently, and that answer is noise.
5. **Validate every tool name** against the manifest. A hallucinated tool is
   dropped, not forwarded.
6. **Cap the plan at six steps** and truncate the rationale at 240 characters.
7. **Never shadow a built-in.** Extras merge only into free names.

## It knows about your machine, not just pi's tools

Pi exposes no tool registry to extensions, and its built-ins are deliberately
generic. So the plugin **probes your PATH** at load and adds every binary worth
naming to the manifest — ripgrep, fd, bat, jq, yq, sd, difftastic, git-delta,
hyperfine, zoxide, just, gh, uv, sqlite3 and more. On the machine this was built
on that is 14 detected binaries, giving needle3 a 22-tool manifest.

A binary is not a pi tool, so the plan renderer translates it:

```
1. bash {"command":"rg -n --type ts \"pi.on\\(\" ."} (via rg) — find the listeners
```

needle3 names the *binary* it wants; the model receives a command it can
actually run. A plan the coding model cannot execute would be worse than no
plan, so the translation is not optional.

Add your own with `~/.pi/agent/pi-tiny-boss.tools.json`:

```json
{
  "tools": [
    { "name": "mytool", "description": "What it is for and when to reach for it." }
  ]
}
```

A malformed file yields an empty list — bad config never breaks the hook.
Built-in tools always win a name clash, so a config cannot shadow the real
`read`.

## Measured quality — read this before enabling it

Reproduce with `npm run eval` (34 labelled prompts, 5 repeats, 11 short-input
probes) and `npm run eval:fresh` (fresh engine per prompt, budget sweep).

**The plumbing is verified against the real model.** ~230–2100 ms per call, and
the ABI is correct. What the evaluation shows is that the model is not useful.

```
ACCURACY   7/34  =  21%
ERRORS    20/34  =  59%   needle_complete: tool call truncated: token budget exhausted
CONFIDENCE  mean 0.77 on all replies vs 0.73 on the wrong ones — not calibrated
```

| Category | Score |
| --- | --- |
| discussion (correct answer: `none`) | 3/12 |
| search | 2/7 |
| read | 2/4 |
| execute | 0/8 |
| edit | 0/3 |

Three findings that no single demo would have shown:

**1. The token budget is not the lever.** 1024, 2048 and 4096 give byte-identical
replies, and truncation is deterministic per prompt — the same prompt truncates
in every fresh engine, at every budget. An earlier claim in this README that a
larger budget fixed truncation was wrong, and the eval harness is what caught it.

**2. A long session decays into `none`.** Calling the same prompt five times in a
row after ~30 prior calls returns `none` every time, whatever the prompt. So the
engine is stateful and slowly degenerates, which also means single-prompt demos
are optimistic relative to a real session.

**3. Confidence is worse than useless.** The model reports `0.97` for "what is the
capital of France?" and `0.98` for `!!!!` while producing nothing, and its mean
confidence is *higher* on wrong answers than on all replies. A confident wrong
prior is more dangerous than a vague one, so the plan text deliberately does not
surface the number.

**Recommended use: `/tiny-boss off`.** The 24-character gate in the hook is what
actually protects a session — 11/11 short or garbage inputs still produced a plan,
every one of them `none`, so the character count, not the model's judgement, is
doing the work.

What needle3 demonstrably *is* good at is what `pi-architecture-watcher` already
uses it for: one label from a small fixed set. Open-ended selection among 22
options, with ordering, is past what 121M parameters at 2-bit can do. If you want
a tiny local model in your workflow, that shape — fixed label set, one decision —
is the shape that works.

## Architecture

Vertical slices, one dependency direction:

```
index.ts                 composition root — the only multi-slice importer
├── slices/engine/       needle3 WASM: download, init, one-shot completion
├── slices/planner/      schema validation + prompt rendering (pure)
├── slices/discovery/    PATH probe -> ToolSpec the tiny model may name
├── slices/hook/         the `input` listener, planner injected
├── slices/commands/     /tiny-boss, dependencies injected
├── slices/tools/        the tiny_boss tool, dependencies injected
└── shared/              types, state, tool manifest, plan schema
```

The engine is reached only through the `TinyEngine` interface, so the whole test
suite runs against a fake and never touches WASM. 23 tests, no model download.

## Honest limitations

- **The manifest is curated, not discovered from pi.** Pi does not expose the live tool
  registry to extensions, so the built-in eight are hand-written and the rest is
  discovered from your own PATH. needle3 degrades badly on long manifests, so
  the catalogue is deliberately short.
- **A binary is named, not called.** Every detected tool renders as a `bash`
  command. That is honest but it means the model gets a *suggested* invocation,
  not an executed one.
- **One plan per prompt.** The `input` hook sees the opening prompt; it does not
  re-plan when a turn changes shape. That is what the `tiny_boss` tool is for.
- **Subagent sessions are skipped** by design — a delegation guard keeps child
  sessions from double-planning.
- **Quality is genuinely poor.** Treat the plan as a cheap prior, and measure.
  The whole point of the experiment is to find out whether the prior is worth
  anything; run it against real tasks before trusting it.

## Credits

- [Cactus Compute](https://cactuscompute.com/needle) — needle3
- The WASM asset URLs and the `_needle_init` / `_needle_complete` C ABI follow the
  integration already proven in `pi-architecture-watcher`.
