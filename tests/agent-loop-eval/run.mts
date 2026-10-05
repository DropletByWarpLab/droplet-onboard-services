// Drive Droplet's REAL agent loop (runAgent) over the eval cases.
//
// Real: agent loop, system prompt builder, tool catalog + schemas + domain
// selection, interceptor (confirmation / deny), approval store, ai-gateway
// client -> ai-gateway -> model. Scripted: tool handler I/O (world.mts).
// A case's `role` (owner | admin | member | guest) picks the person the loop acts
// for: the route's real role narrowing of the tool pool applies to anyone but an
// owner or admin, and the scripted handlers apply the floors the real ones do
// (README, "Roles").
//
// Usage, with this repo's orchestrator tsx (see README.md; bench-box.sh wraps it):
//   AGENT_EVAL_GATEWAY_URL=http://ai-gateway:8000 AGENT_EVAL_GATEWAY_TOKEN=... \
//   apps/orchestrator/node_modules/.bin/tsx tests/agent-loop-eval/run.mts --model gpt-oss:20b \
//     [--cases cases/droplet_delegation.jsonl] [--repeat 3] [--only seed-001,adv-004] [--out runs/<name>.jsonl]
// ORCH defaults to this checkout's apps/orchestrator, so the harness follows its src.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultWorld, handle, faultResult, normalizeWorld, validateWorld, ctxFor, PRECHECKS, PURE_TOOLS, WIRE_ROLE, type Ctx, type Fault, type WorldState } from "./world.mts";
import { expandDates, expandDeep } from "./dates.mts";

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
    // Self-test: replace the model with a script {caseId: [{text}|{call:[{name,args}]}|{throw}]}
    // so the harness + evaluator can be proven against known-good/bad agents.
    // {throw} raises that gateway error text (the retry and abort rules' test).
    fake: { type: "string" },
    // Rewrite write_tools.json from the catalog (evaluate.py's H1 source).
    "write-tools": { type: "boolean" },
  },
});
const FAKE: Record<string, any[]> | null = opt.fake ? JSON.parse(readFileSync(resolve(opt.fake), "utf8")) : null;

// A gateway 429 seen during the current attempt, at stream open or on the
// blocking call. Only a 429 is the bench's pacing (60 requests/min per client);
// the gateway turns every provider exception into a 5xx, so a 5xx is a real
// product failure and is never retried.
let saw429 = false;
function noteGatewayError(e: unknown): never {
  if (/AI Gateway (streaming )?error 429\b/.test(String(e))) saw429 = true;
  throw e;
}
const RETRY_WAIT_MS = Number(process.env.AGENT_EVAL_RETRY_WAIT_MS ?? 60_000);

// `script` is consumed across a case's attempts, so a retried case resumes it.
function fakeGateway(script: any[]) {
  let n = 0;
  return {
    chat: async () => {
      const step = script.shift() ?? { text: "Done." };
      n++;
      if (step.throw) noteGatewayError(new Error(step.throw));
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
const { buildBaseSystemPrompt, todayLine } = await import(`${ORCH}/src/services/system-prompt.service.ts`);
const { createChatApprovalStore } = await import(`${ORCH}/src/services/chat-approval.service.ts`);
const gw = await import(`${ORCH}/src/services/ai-gateway.client.ts`);
const { resolveTurnContextWindow } = await import(`${ORCH}/src/services/context-budget.service.ts`);
const { localDayInZone } = await import(`${ORCH}/src/services/scene-schedule-tz-backfill.service.ts`);
const { config } = await import(`${ORCH}/src/config.ts`);
const tc = await import(PKG);
const { toolResultToContent } = await import(`${ORCH}/../../services/mcp-server/src/server.ts`);
// The route's own role narrowing (routes/llm.ts narrowAllowedToolsForRole is a thin wrapper over this).
const { narrowToolNamesForPrincipal } = await import(`${ORCH}/src/services/tool-access.service.ts`);

const TOOLS: Map<string, any> = tc.TOOLS instanceof Map ? tc.TOOLS : new Map(Object.entries(tc.TOOLS));
const USER = "eval-owner";

// write_tools.json lists the catalog's writes for evaluate.py (hard gate H1);
// a tool absent from it is a read. A write tool missing there would pass H1
// silently, so refuse to run when the write names differ. Read tools come and
// go without touching it.
const WRITE_TOOLS = resolve(import.meta.dirname, "write_tools.json");
const writeNames = [...TOOLS.values()].filter((t) => t.requiresWrite).map((t) => t.name).sort();
if (opt["write-tools"]) {
  writeFileSync(WRITE_TOOLS, JSON.stringify(Object.fromEntries(writeNames.map((n) => [n, true])), null, 1) + "\n");
  console.error(`wrote ${WRITE_TOOLS} (${writeNames.length} write tools)`);
  process.exit(0);
}
const listed = Object.entries(JSON.parse(readFileSync(WRITE_TOOLS, "utf8"))).filter(([, w]) => w).map(([n]) => n).sort();
if (listed.join() !== writeNames.join()) {
  throw new Error("write_tools.json is stale against @droplet/tools-core's write tools: run run.mts --write-tools and commit it");
}

// Dated text is relative to the run ({{today+3}} -> YYYY-MM-DD; dates.mts has the other tokens): the
// system prompt carries today's date (WARP-3281), so a fixed date drifts past the 7-day forecast and a
// correct refusal fails the case. `today` is the same local day the prompt's date line shows
// (localDayInZone, the box zone). Turns, the world and the faults are expanded here; evaluate.py
// expands `expected` with the `today` recorded in the run.

interface Case {
  id: string; kit_id?: string; category: string;
  turns: { role: "user" | "assistant"; content: string }[];
  // The acting person: owner (default) | admin | member | guest. Their user id is eval-<role>.
  role?: string;
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

function makePort(world: WorldState, faults: Record<string, Fault[]>, log: Dispatch[], who: Ctx) {
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
      // A confirming tool's read-only `precheck` runs BEFORE the interceptor asks, and its refusal reaches the model
      // instead of an approval card for a call that can never succeed (services/mcp-server/src/server.ts, WARP-3349).
      // Only a call the interceptor is about to challenge runs it: no token, the interceptor owns the confirmation, not
      // denied. PRECHECKS scripts each production precheck (the real one needs ctx.http); the catalog's `precheck` says
      // production has one. The refusal wrote nothing, so it is logged `refused` like a handler's.
      const precheck = PRECHECKS[name];
      if (precheck && tool.precheck && !ctx?.confirmationToken && tool.requiresConfirmation
          && tc.confirmationOwnerOf(tool) === "interceptor" && !interceptor.denyTier.evaluate(tool, args)) {
        const early = precheck(world, args as Record<string, any>);
        if (early && !early.ok) {
          log.push({ tool: name, args, outcome: "refused" });
          return toolResultToContent(early);
        }
      }
      const outcome = tc.interceptOutcomeToToolResult(tool, interceptor.intercept(tool, args, { confirmationToken: ctx?.confirmationToken }));
      if (outcome) {
        const code = (outcome as any).error?.details?.interceptor?.outcome ?? "denied";
        log.push({ tool: name, args, outcome: code });
        return toolResultToContent(outcome);
      }
      const f = pending[name]?.shift();
      if (f === "timeout_after") {
        const r = handle(world, name, args as Record<string, any>, who);
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
        result = handle(world, name, args as Record<string, any>, who);
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

async function runCase(c: Case, repeat: number, window: number, script: any[] | null) {
  const now = new Date();
  const today = localDayInZone(now).date;
  // WARP-3545: the acting person. A guest or member runs through the route's real role narrowing
  // (see `allowed` below); what is real and what is simulated is in the README ("Roles").
  const who = ctxFor(c.role, today);
  const wireRole = WIRE_ROLE[who.role];
  // The case's world overlays the default one key by key; a key the default world lacks is a typo.
  const base = defaultWorld(today);
  const overlay = expandDeep(structuredClone(c.world ?? {}), today) as Record<string, unknown>;
  const unknownKeys = Object.keys(overlay).filter((k) => !(k in base));
  if (unknownKeys.length) throw new Error(`case ${c.id}: unknown world key(s) ${unknownKeys.join(", ")} (known: ${Object.keys(base).join(", ")})`);
  const world = normalizeWorld({ ...base, ...overlay } as WorldState);
  validateWorld(world);
  const dispatches: Dispatch[] = [];
  const mcp = makePort(world, expandDeep(c.faults ?? {}, today) as Record<string, Fault[]>, dispatches, who);
  const approvals = createChatApprovalStore();
  const steps: any[] = [];
  const confirmations: any[] = [];
  const turns: any[] = [];
  const gwCalls: any[] = [];
  // Every call the model issued, including the ones the loop refused before dispatch (the trace).
  const calls: any[] = [];
  // Production gives an owner or admin no explicit list (the full chat scope); anyone else gets the
  // whole registry minus every write tool (narrowAllowedToolsForRole). No AccessRole scope: that is
  // null for every person on a box today (resolveToolAccessScope).
  const privileged = who.role === "owner" || who.role === "admin";
  const allowed: string[] | undefined = privileged ? undefined : narrowToolNamesForPrincipal([...TOOLS.keys()], wireRole, null);
  const messages: any[] = [{ role: "system", content: buildBaseSystemPrompt(allowed, "", "", todayLine(now)) }];
  for (const t of c.turns) messages.push({ role: t.role, content: expandDates(t.content, today) });

  const t0 = Date.now();
  let final = "";
  let priorToolNames: string[] = c.prior_tool_names ?? [];
  const fake = script ? fakeGateway(script) : null;
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
        chat: (r: any, s?: AbortSignal) => gw.chat(r, s, USER).catch(noteGatewayError),
        chatStream: (r: any, s?: AbortSignal) => (async function* () {
          // WARP-3285 local tap: per-iteration provider verdict (not in product diagnostics on the stream path).
          const g: any = { round, tools: (r.tools ?? []).length, tool_choice: r.tool_choice, msgs: r.messages?.length, content: "", reasoning: "", toolCalls: 0, finish: null, usage: null };
          gwCalls.push(g);
          try {
            for await (const ch of gw.chatStream(r, s, USER) as AsyncIterable<any>) {
              const c = ch.choices?.[0]; const d = c?.delta ?? {};
              if (typeof d.content === "string") g.content += d.content;
              const rr = d.reasoning ?? d.reasoning_content ?? d.thinking; if (typeof rr === "string") g.reasoning += rr;
              if (Array.isArray(d.tool_calls)) g.toolCalls += d.tool_calls.filter((t: any) => t.function?.name).length;
              if (c?.finish_reason) g.finish = c.finish_reason;
              if (ch.usage) g.usage = ch.usage;
              yield ch;
            }
          } catch (e) {
            noteGatewayError(e);  // the loop then falls back to the blocking call
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
      allowed_tools: allowed, toolAccessScope: null,
      toolCallContext: { userId: who.user, userRole: wireRole },
      // The eval world is a box with every module on. Without an explicit
      // verdict the loop resolves one for USER, which nothing wires here,
      // so it fails closed and withholds every module-owned tool (WARP-2972).
      moduleVerdict: { withheldDomains: new Set<string>() },
      captureReasoning: true,
    });
    const content = typeof res.message?.content === "string" ? res.message.content : JSON.stringify(res.message?.content ?? "");
    final = content;
    turns.push({ round, stop_reason: res.stop_reason, iterations: res.iterations, error: res.error, latency_ms: Date.now() - tt, answer: content, blankDiagnostics: (res as any).blankDiagnostics, pollutedDiagnostics: (res as any).pollutedDiagnostics, actionClaimCheck: (res as any).actionClaimCheck, reasoningSteps: (res as any).reasoningSteps, reasoning: (res.message as any)?.reasoning });
    priorToolNames = [...new Set([...priorToolNames, ...res.trace.map((x: any) => x.tool)])];
    for (const x of res.trace as any[]) calls.push({ id: x.tool_call_id, tool: x.tool, args: x.args, round });
    messages.push({ role: "assistant", content });

    const decision = c.approve ?? "ignore";
    if (!pendingChallenge || decision === "ignore") break;
    if (decision === "approve") {
      approvals.approve(pendingChallenge, who.user);
      messages.push({ role: "user", content: "I approved that — go ahead." });
    } else {
      approvals.deny(pendingChallenge, who.user);
      messages.push({ role: "user", content: "I denied that. Don't do it." });
    }
  }

  return {
    case_id: c.id, kit_id: c.kit_id, repeat, model: opt.model, selection: opt.selection, role: who.role,
    today, turns_asked: messages.slice(1, 1 + c.turns.length).map((m) => m.content),
    steps, dispatches, calls, confirmations, turns, gwCalls,
    final_answer: final,
    stop_reason: turns.at(-1)?.stop_reason,
    iterations: turns.reduce((n, t) => n + (t.iterations ?? 0), 0),
    total_latency_ms: Date.now() - t0,
    world_after: {
      files: Object.keys(world.files), workItems: world.workItems, memory: world.memory, runs: world.runs,
      // Times as written (a fixture's naive local time, or the model's own).
      events: world.events.map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end })),
      reminders: world.reminders, devices: world.devices, sent: world.sent,
    },
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

let gatewayDown = 0;
for (let r = 1; r <= Number(opt.repeat); r++) {
  for (const c of selected) {
    let rec: any;
    const script = FAKE ? [...(FAKE[c.id] ?? [])] : null;
    const retryErrors: string[] = [];
    // Only a 429 is retried: wait out the gateway's 60 requests/min and rerun
    // the case, up to 5 times. Anything else is recorded as it is, so a later
    // success can never hide a real product failure.
    for (;;) {
      saw429 = false;
      try {
        rec = await runCase(c, r, window, script);
        break;
      } catch (e) {
        if (saw429 && retryErrors.length < 5) {
          retryErrors.push(String(e).slice(0, 300));
          console.error(`[r${r}] ${c.id} gateway 429, waiting ${RETRY_WAIT_MS / 1000}s (retry ${retryErrors.length})`);
          await new Promise((res) => setTimeout(res, RETRY_WAIT_MS));
          continue;
        }
        rec = { case_id: c.id, repeat: r, harness_error: String((e as Error)?.stack ?? e), steps: [], dispatches: [], final_answer: "" };
        break;
      }
    }
    rec.attempts = retryErrors.length + 1;
    if (retryErrors.length) rec.retry_errors = retryErrors;
    appendFileSync(out, JSON.stringify(rec) + "\n");
    const calls = (rec.dispatches ?? []).map((d: Dispatch) => `${d.tool}:${d.outcome}`).join(",") || "-";
    console.error(`[r${r}] ${c.id.padEnd(8)} stop=${rec.stop_reason ?? "HARNESS_ERR"} it=${rec.iterations ?? "-"} ${(rec.total_latency_ms / 1000 || 0).toFixed(1)}s ${calls}`);
    // An outage fails every case in seconds; stop instead of writing hundreds of them.
    gatewayDown = /AI Gateway (streaming )?error/.test(rec.harness_error ?? "") ? gatewayDown + 1 : 0;
    if (gatewayDown >= 3) {
      console.error(`ABORTED: 3 consecutive cases failed at the ai-gateway (last: ${rec.harness_error.split("\n")[0].slice(0, 200)}). Check the gateway and the model runtime, then rerun. ${out} holds the records so far.`);
      process.exit(2);
    }
  }
}
console.error(`wrote ${out}`);
process.exit(0);
