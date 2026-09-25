import { readFileSync, writeFileSync } from "node:fs";
import { createNeedleEngine } from "../src/slices/engine/needle.js";
import { detectBinaries, systemTools } from "../src/slices/discovery/index.js";
import { manifestTools } from "../src/shared/manifest.js";
import { parsePlan } from "../src/slices/planner/plan.js";

const { cases, mustBeSilent } = JSON.parse(readFileSync(new URL("./dataset.json", import.meta.url), "utf8")) as {
  cases: Array<[string, string[]]>;
  mustBeSilent: string[];
};
const tools = manifestTools(systemTools(detectBinaries()));
const engine = await createNeedleEngine(tools);

async function planFor(p: string) {
  const t0 = Date.now();
  try {
    const res = await engine.plan(p, tools);
    const steps = parsePlan(res.raw, tools);
    let conf = 0, reasoning = "";
    try {
      const j = JSON.parse(res.raw) as any;
      conf = j.confidence ?? 0;
      reasoning = String(j.reasoning ?? "").slice(0, 55);
    } catch {}
    return { ms: Date.now() - t0, steps, conf, reasoning, err: null as string | null };
  } catch (e) {
    return { ms: Date.now() - t0, steps: [] as any[], conf: 0, reasoning: "", err: (e as Error).message };
  }
}

const out: any[] = [];
for (const [prompt, ideal] of cases) {
  const r = await planFor(prompt);
  const first = r.steps[0]?.tool ?? (r.err ? "ERROR" : "(empty)");
  out.push({ prompt, ideal, first, hit: r.steps.some(s => ideal.includes(s.tool)), n: r.steps.length,
             ms: r.ms, conf: r.conf, reasoning: r.reasoning, err: r.err });
}

const det: Record<string, string[]> = {};
for (const p of ["run the test suite and fix whatever fails", "find where the pi.on subscriptions are declared", "what is the capital of France?"]) {
  const seen: string[] = [];
  for (let i = 0; i < 5; i++) seen.push((await planFor(p)).steps[0]?.tool ?? ((await Promise.resolve(0), "(empty)")));
  det[p] = seen;
}

const silent: any[] = [];
for (const p of mustBeSilent) {
  const r = await planFor(p);
  silent.push({ prompt: p, steps: r.steps.length, first: r.steps[0]?.tool ?? "(empty)", err: r.err });
}

const payload = { tools: tools.length, system: tools.filter(t => t.source === "system").length, out, det, silent };
writeFileSync(new URL("./out.json", import.meta.url), JSON.stringify(payload, null, 1));
console.log("wrote eval/out.json - " + out.length + " cases, " + silent.length + " silent probes");
await engine.close();
