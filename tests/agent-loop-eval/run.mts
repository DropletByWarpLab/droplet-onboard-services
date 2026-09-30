// Drive Droplet's REAL agent loop (runAgent) over the eval cases.
//
// Real: agent loop, system prompt builder, tool catalog + schemas + domain
// selection, interceptor (confirmation / deny), approval store, ai-gateway
// client -> ai-gateway -> model. Scripted: tool handler I/O (world.mts).
//
// Usage, with this repo's orchestrator tsx (see README.md; bench-box.sh wraps it):
//   AGENT_EVAL_GATEWAY_URL=http://ai-gateway:8000 AGENT_EVAL_GATEWAY_TOKEN=... \
//   apps/orchestrator/node_modules/.bin/tsx tests/agent-loop-eval/run.mts --model gpt-oss:20b \
//     [--cases cases/droplet_delegation.jsonl] [--repeat 3] [--only seed-001,adv-004] [--out runs/<name>.jsonl]
// ORCH defaults to this checkout's apps/orchestrator, so the harness follows its src.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { defaultWorld, handle, faultResult, PURE_TOOLS, type Fault, type WorldState } from "./world.mts";

const ORCH = process.env.ORCH ?? resolve(import.meta.dirname, "../../apps/orchestrator");
// A box's orchestrator runs from apps/orchestrator and reads its identity block
// from data/droplet-identity.md relative to cwd. From here that path misses and
// the system prompt silently falls back to a stub, so point at the real file.
process.env.DROPLET_IDENTITY_PATH ??= resolve(ORCH, "data/droplet-identity.md");
const PKG = resolve(ORCH, "../../packages/tools-core/dist/index.js");

const { values: opt } = parseArgs({
  options: {
    cases: { type: "string", multiple: true },
    model: { type: "string", default: "gpt-oss:20b" },
    repeat: { type: "string", default: "1" },
    only: { type: "string" },
    out: { type: "string" },
    selection: { type: "string", default: process.env.TOOL_SELECTION_MODE ?? "domains" },
    // Self-test: replace the model with a script {caseId: [{text}|{call:[{name,args}]}]}
    // so the harness + evaluator can be proven against known-good/bad agents.
    fake: { type: "string" },
    // Rewrite write_tools.json from the catalog (evaluate.py's H1 source).
    "write-tools": { type: "boolean" },
  },
});
const FAKE: Record<string, any[]> | null = opt.fake ? JSON.parse(readFileSync(resolve(opt.fake), "utf8")) : null;

function fakeGateway(script: any[]) {
  let n = 0;
  return {
    chat: async () => {
      const step = script[n++] ?? { text: "Done." };
      const message = step.call
        ? { role: "assistant", content: "", tool_calls: step.call.map((c: any, i: number) => ({ id: `fake-${n}-${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : { role: "assistant", content: step.text };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message, finish_reason: step.call ? "tool_calls" : "stop" }] }) };
    },
  };
}

// Model runs are opt-in, like KEV_EVAL_URL: without AGENT_EVAL_GATEWAY_URL only
// the scripted --fake agent (the selftest) and --write-tools run.
if (!opt.fake && !opt["write-tools"]) {
  if (!process.env.AGENT_EVAL_GATEWAY_URL) {
    console.error("AGENT_EVAL_GATEWAY_URL is not set: model runs are opt-in, skipping.");
    process.exit(0);
  }
  // Read by the orchestrator's config at import, so set before the imports below.
  process.env.AI_GATEWAY_URL = process.env.AGENT_EVAL_GATEWAY_URL;
  process.env.SERVICE_TOKEN_AI_GATEWAY = process.env.AGENT_EVAL_GATEWAY_TOKEN ?? "";
}

const agent = await import(`${ORCH}/src/services/llm-agent.service.ts`);
const { buildBaseSystemPrompt } = await import(`${ORCH}/src/services/system-prompt.service.ts`);
const { createChatApprovalStore } = await import(`${ORCH}/src/services/chat-approval.service.ts`);
const gw = await import(`${ORCH}/src/services/ai-gateway.client.ts`);
const { resolveTurnContextWindow } = await import(`${ORCH}/src/services/context-budget.service.ts`);
const { config } = await import(`${ORCH}/src/config.ts`);
const tc = await import(PKG);
const { toolResultToContent } = await import(`${ORCH}/../../services/mcp-server/src/server.ts`);

const TOOLS: Map<string, any> = tc.TOOLS instanceof Map ? tc.TOOLS : new Map(Object.entries(tc.TOOLS));
const USER = "eval-owner";

// write_tools.json is evaluate.py's list of writes (hard gate H1). A write tool
// added to the catalog but missing there would pass H1 silently, so refuse to
// run against a stale copy.
const WRITE_TOOLS = resolve(import.meta.dirname, "write_tools.json");
const writeMap = Object.fromEntries([...TOOLS.values()].map((t) => [t.name, Boolean(t.requiresWrite)]));
if (opt["write-tools"]) {
  writeFileSync(WRITE_TOOLS, JSON.stringify(writeMap, null, 1) + "\n");
  console.error(`wrote ${WRITE_TOOLS} (${TOOLS.size} tools)`);
  process.exit(0);
}
if (!isDeepStrictEqual(writeMap, JSON.parse(readFileSync(WRITE_TOOLS, "utf8")))) {
  throw new Error("write_tools.json is stale against @droplet/tools-core: run run.mts --write-tools and commit it");
}

// Dated prompts are relative to the run ({{today+3}} -> YYYY-MM-DD): the system
// prompt carries today's date (WARP-3281), so a fixed date drifts past the
// 7-day forecast and a correct refusal fails the case.
function expandDates(text: string): string {
  const out = text.replace(/\{\{today\+(\d+)\}\}/g, (_, d) => new Date(Date.now() + Number(d) * 864e5).toISOString().slice(0, 10));
  if (out.includes("{{")) throw new Error(`unknown placeholder in case turn: ${out}`);
  return out;
}

interface Case {
  id: string; kit_id?: string; category: string;
  turns: { role: "user" | "assistant"; content: string }[];
  world?: Partial<WorldState>;
  faults?: Record<string, Fault[]>;
  approve?: "approve" | "deny" | "ignore";
  // Tool names a box would carry from earlier turns' persisted trace. Seeded
  // turns are text only, so without this selection sees no earlier tools.
  prior_tool_names?: string[];
  expected: Record<string, unknown>;
}

// One call as the harness saw it — the ground truth for "did it happen".
interface Dispatch {
  tool: string; args: Record<string, unknown>;
  outcome: "executed" | "confirmation_required" | "denied" | "confirmation_rejected" | "fault" | "unscripted" | "refused";
  fault?: Fault;
}

function makePort(world: WorldState, faults: Record<string, Fault[]>, log: Dispatch[]) {
  const interceptor = tc.createToolCallInterceptor();
  const pending = Object.fromEntries(Object.entries(faults).map(([k, v]) => [k, [...v]]));
  return {
    isStarted: true,
    async listTools() {
      return [...TOOLS.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    },
    async callTool(name: string, args: Record<string, unknown>, ctx?: { confirmationToken?: string }) {
      const tool = TOOLS.get(name);
      if (!tool) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
      }
      const outcome = tc.interceptOutcomeToToolResult(tool, interceptor.intercept(tool, args, { confirmationToken: ctx?.confirmationToken }));
      if (outcome) {
        const code = (outcome as any).error?.details?.interceptor?.outcome ?? "denied";
        log.push({ tool: name, args, outcome: code });
        return toolResultToContent(outcome);
      }
      const f = pending[name]?.shift();
      if (f === "timeout_after") {
        const r = handle(world, name, args as Record<string, any>);
        log.push({ tool: name, args, outcome: r?.ok ? "executed" : "refused", fault: f });
        const t = faultResult(f);
        return { content: [{ type: "text", text: t.text }], isError: t.isError };
      }
      if (f) {
        log.push({ tool: name, args, outcome: "fault", fault: f });
        const r = faultResult(f);
        return { content: [{ type: "text", text: r.text }], isError: r.isError };
      }
      let result;
      if (PURE_TOOLS.has(name)) {
        result = await tool.handler(args, {});
      } else {
        result = handle(world, name, args as Record<string, any>);
      }
      if (result === undefined) {
        log.push({ tool: name, args, outcome: "unscripted" });
        result = { ok: true, data: { items: [], note: "No data." } };
      } else {
        // A handler refusal (NOT_FOUND, PARENT_REQUIRED) wrote nothing.
        log.push({ tool: name, args, outcome: result.ok ? "executed" : "refused" });
      }
      return toolResultToContent(result);
    },
  };
}

async function runCase(c: Case, repeat: number, window: number) {
  const world: WorldState = { ...defaultWorld(), ...(structuredClone(c.world ?? {}) as object) } as WorldState;
  const dispatches: Dispatch[] = [];
  const mcp = makePort(world, c.faults ?? {}, dispatches);
  const approvals = createChatApprovalStore();
  const steps: any[] = [];
  const confirmations: any[] = [];
  const turns: any[] = [];
  const gwCalls: any[] = [];
  const messages: any[] = [{ role: "system", content: buildBaseSystemPrompt(undefined, "", "") }];
  for (const t of c.turns) messages.push({ role: t.role, content: expandDates(t.content) });

  const t0 = Date.now();
  let final = "";
  let priorToolNames: string[] = c.prior_tool_names ?? [];
  const fake = FAKE ? fakeGateway(FAKE[c.id] ?? []) : null;
  // At most one approval round-trip, the way the dashboard does it.
  for (let round = 0; round < 2; round++) {
    let pendingChallenge: string | undefined;
    const onEvent = (e: any) => {
      if (e.type === "tool_call") steps.push({ type: "tool_call", id: e.id, tool: e.name, args: e.args, round });
      else if (e.type === "tool_result") {
        const s: any = { type: "tool_result", id: e.id, ok: e.ok, status: e.status, round };
        if (e.data !== undefined) s.result = e.data;
        if (e.message) s.message = e.message;
        steps.push(s);
        if (e.confirmation?.challengeId) {
          confirmations.push({ round, ...e.confirmation });
          pendingChallenge = e.confirmation.challengeId;
        }
      } else if (e.type === "done") steps.push({ type: "model_done", stop_reason: e.stop_reason, iterations: e.iterations, error: e.error, round });
    };
    const deps = {
      mcp, approvals,
      aiGateway: fake ?? {
        chat: (r: any, s?: AbortSignal) => gw.chat(r, s, USER),
        chatStream: (r: any, s?: AbortSignal) => (async function* () {
          // WARP-3285 local tap: per-iteration provider verdict (not in product diagnostics on the stream path).
          const g: any = { round, tools: (r.tools ?? []).length, tool_choice: r.tool_choice, msgs: r.messages?.length, content: "", reasoning: "", toolCalls: 0, finish: null, usage: null };
          gwCalls.push(g);
          for await (const ch of gw.chatStream(r, s, USER) as AsyncIterable<any>) {
            const c = ch.choices?.[0]; const d = c?.delta ?? {};
            if (typeof d.content === "string") g.content += d.content;
            const rr = d.reasoning ?? d.reasoning_content ?? d.thinking; if (typeof rr === "string") g.reasoning += rr;
            if (Array.isArray(d.tool_calls)) g.toolCalls += d.tool_calls.filter((t: any) => t.function?.name).length;
            if (c?.finish_reason) g.finish = c.finish_reason;
            if (ch.usage) g.usage = ch.usage;
            yield ch;
          }
          g.contentChars = g.content.length; g.reasoningChars = g.reasoning.length;
          g.content = g.content.slice(0, 600); g.reasoning = g.reasoning.slice(-1500);
        })(),
      },
      onEvent,
    };
    const tt = Date.now();
    const res = await agent.runAgent(deps, {
      model: opt.model!, messages, context_window: window,
      tool_selection_mode: opt.selection as "off" | "domains",
      prior_tool_names: priorToolNames,
      allowed_tools: undefined, toolAccessScope: null,
      toolCallContext: { userId: USER, userRole: "owner" },
      captureReasoning: true,
    });
    const content = typeof res.message?.content === "string" ? res.message.content : JSON.stringify(res.message?.content ?? "");
    final = content;
    turns.push({ round, stop_reason: res.stop_reason, iterations: res.iterations, error: res.error, latency_ms: Date.now() - tt, answer: content, blankDiagnostics: (res as any).blankDiagnostics, pollutedDiagnostics: (res as any).pollutedDiagnostics, reasoningSteps: (res as any).reasoningSteps, reasoning: (res.message as any)?.reasoning });
    priorToolNames = [...new Set([...priorToolNames, ...res.trace.map((x: any) => x.tool)])];
    messages.push({ role: "assistant", content });

    const decision = c.approve ?? "ignore";
    if (!pendingChallenge || decision === "ignore") break;
    if (decision === "approve") {
      approvals.approve(pendingChallenge, USER);
      messages.push({ role: "user", content: "I approved that — go ahead." });
    } else {
      approvals.deny(pendingChallenge, USER);
      messages.push({ role: "user", content: "I denied that. Don't do it." });
    }
  }

  return {
    case_id: c.id, kit_id: c.kit_id, repeat, model: opt.model, selection: opt.selection,
    steps, dispatches, confirmations, turns, gwCalls,
    final_answer: final,
    stop_reason: turns.at(-1)?.stop_reason,
    iterations: turns.reduce((n, t) => n + (t.iterations ?? 0), 0),
    total_latency_ms: Date.now() - t0,
    world_after: { files: Object.keys(world.files), workItems: world.workItems, memory: world.memory, runs: world.runs },
  };
}

const cases: Case[] = (opt.cases ?? ["cases/regression/droplet_core.jsonl", "cases/regression/droplet_adversarial.jsonl"])
  .flatMap((f) => readFileSync(resolve(import.meta.dirname, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)));
const only = opt.only ? new Set(opt.only.split(",")) : null;
const selected = cases.filter((c) => !only || only.has(c.id));
const out = resolve(import.meta.dirname, opt.out ?? `runs/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, "");

const advertised = FAKE ? undefined : await gw.getModelContextWindow(opt.model!).catch(() => undefined);
const window = resolveTurnContextWindow({ advertised, localWindow: config.OLLAMA_CONTEXT_LENGTH }).window;
console.error(`model=${opt.model} window=${window} selection=${opt.selection} cases=${selected.length} repeat=${opt.repeat} -> ${out}`);

for (let r = 1; r <= Number(opt.repeat); r++) {
  for (const c of selected) {
    let rec;
    // The box's ai-gateway allows 60 requests/min per client; a 429 is the
    // bench's pacing, not the agent's result, so wait it out and rerun the case.
    for (let attempt = 0; ; attempt++) {
      try {
        rec = await runCase(c, r, window);
        break;
      } catch (e) {
        if (/\b429\b/.test(String(e)) && attempt < 5) {
          console.error(`[r${r}] ${c.id} gateway 429, waiting 60s (attempt ${attempt + 1})`);
          await new Promise((res) => setTimeout(res, 60_000));
          continue;
        }
        rec = { case_id: c.id, repeat: r, harness_error: String((e as Error)?.stack ?? e), steps: [], dispatches: [], final_answer: "" };
        break;
      }
    }
    appendFileSync(out, JSON.stringify(rec) + "\n");
    const calls = (rec.dispatches ?? []).map((d: Dispatch) => `${d.tool}:${d.outcome}`).join(",") || "-";
    console.error(`[r${r}] ${c.id.padEnd(8)} stop=${(rec as any).stop_reason ?? "HARNESS_ERR"} it=${(rec as any).iterations ?? "-"} ${((rec as any).total_latency_ms / 1000 || 0).toFixed(1)}s ${calls}`);
  }
}
console.error(`wrote ${out}`);
process.exit(0);
