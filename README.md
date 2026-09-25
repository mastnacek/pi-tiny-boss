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

## Architecture

Vertical slices, one dependency direction:

```
index.ts                 composition root — the only multi-slice importer
├── slices/engine/       needle3 WASM: download, init, one-shot completion
├── slices/planner/      schema validation + prompt rendering (pure)
├── slices/hook/         the `input` listener, planner injected
├── slices/commands/     /tiny-boss, dependencies injected
├── slices/tools/        the tiny_boss tool, dependencies injected
└── shared/              types, state, tool manifest, plan schema
```

The engine is reached only through the `TinyEngine` interface, so the whole test
suite runs against a fake and never touches WASM. 23 tests, no model download.

## Honest limitations

- **The manifest is curated, not discovered.** Pi does not expose the live tool
  registry to extensions, and needle3 degrades badly on long manifests, so eight
  tools is the deliberate ceiling.
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
