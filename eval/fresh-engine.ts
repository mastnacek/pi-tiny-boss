import { createNeedleEngine } from "../src/slices/engine/needle.js";
import { detectBinaries, systemTools } from "../src/slices/discovery/index.js";
import { manifestTools } from "../src/shared/manifest.js";
import { parsePlan } from "../src/slices/planner/plan.js";
import { readFileSync } from "node:fs";

const { cases } = JSON.parse(readFileSync(new URL("./dataset.json", import.meta.url), "utf8")) as { cases: Array<[string, string[]]> };
const tools = manifestTools(systemTools(detectBinaries()));

// The prompts that truncated in the shared-session run.
const probes = cases.filter(c => [
  "run the test suite and fix whatever fails",
  "fix the failing test in gate.test.js",
  "commit and push the change to GitHub",
  "what is the capital of France?",
  "kfsyfh",
  "search for every TODO in the project and list the files",
]);

console.log("FRESH ENGINE PER PROMPT — is truncation caused by accumulated session state?\n");
const rows: any[] = [];
for (const [prompt] of probes) {
  for (const budget of [1024, 2048, 4096]) {
    const engine = await createNeedleEngine(tools);
    const t0 = Date.now();
    let first = "(empty)", err: string | null = null, conf = 0;
    try {
      const res = await engine.plan(prompt, tools);
      first = parsePlan(res.raw, tools)[0]?.tool ?? "(empty)";
      try { conf = (JSON.parse(res.raw) as any).confidence ?? 0; } catch {}
    } catch (e) { err = (e as Error).message.replace("needle_complete: ", ""); }
    rows.push({ prompt, budget, first, err, conf, ms: Date.now() - t0 });
    console.log(
      String(budget).padStart(5) + "  " + prompt.slice(0, 42).padEnd(43) +
      (err ? "ERR: " + err : first.padEnd(10)) + "  " + String(Date.now() - t0).padStart(5) + "ms  conf=" + conf.toFixed(2),
    );
    await engine.close();
  }
  console.log("");
}
const errs = rows.filter(r => r.err);
console.log("errors: " + errs.length + "/" + rows.length);
if (errs.length) console.log("distinct: " + [...new Set(errs.map(e => e.err))].join(" | "));
