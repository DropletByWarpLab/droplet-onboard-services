// WARP-3899: the shape contract. Model-free. The world scripts the handlers' I/O, so its output is only as faithful as
// the shapes it was written from; this holds every handler that TRANSFORMS its route's body to the shape of the REAL
// tools-core handler. For each (tool, args) pair: render the default world's fixture as the orchestrator route's JSON
// (one adapter per route), run the real handler from packages/tools-core/dist (the same dist run.mts loads) on a
// recording ctx, run world.mts's handle() on the same fixture, and require the same shape: keys sorted, values dropped,
// an array keeps only its first element's shape. A refusal pair compares the whole refusal (its code and message are
// what the model reads); a route-owned write compares its envelope (ok, status, code). Exit 1 on any difference.
//
// The adapters model the route's TYPED row (e.g. routes/email.ts ThreadRow), not every Prisma column. The pass-through
// handlers (get_network_status, list_cameras, email_read, ...) learn nothing here beyond their envelope and are not
// covered; WARP-3899's snapshot follow-up covers them from a box.
import { resolve } from "node:path";
import { ctxFor, defaultWorld, eventJson, handle, normalizeWorld, type WorldState } from "../world.mts";

const ORCH = process.env.ORCH ?? resolve(import.meta.dirname, "../../../apps/orchestrator");
const tc = await import(resolve(ORCH, "../../packages/tools-core/dist/index.js"));
const TOOLS: Map<string, any> = tc.TOOLS instanceof Map ? tc.TOOLS : new Map(Object.entries(tc.TOOLS));

// Keys sorted, values dropped; an array keeps its array-ness and the shape of its first element.
function shapeOf(v: unknown): unknown {
  if (Array.isArray(v)) return ["array", ...(v.length ? [shapeOf(v[0])] : [])];
  if (v === null) return "null";
  if (typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, shapeOf((v as any)[k])]));
  return typeof v;
}
// What a caller of the route (or the model) gets is JSON: an undefined value is no key at all.
const wire = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// Mirror of packages/tools-core/__tests__/helpers/orchestrator-ctx.ts without vitest: a handler that reads its rows
// through ctx.prisma fails loudly unless the pair gives it a stub.
const NO_PRISMA = new Proxy({}, { get(_t, p) { throw new Error(`handler touched ctx.prisma.${String(p)}`); } });

type Route = (method: string, path: string, body?: any) => Response;
function ctxWith(route: Route, prisma: unknown = NO_PRISMA) {
  const orchestrator = {
    get: async (p: string) => route("GET", p),
    post: async (p: string, b?: unknown) => route("POST", p, b),
    patch: async (p: string, b?: unknown) => route("PATCH", p, b),
    delete: async (p: string) => route("DELETE", p),
  };
  return { prisma, http: { orchestrator }, matter: {}, userId: "eval-owner", role: "owner", signal: new AbortController().signal };
}

const TODAY = "2026-10-05";
const who = ctxFor("owner", TODAY);
const mk = (seed?: (w: WorldState) => void): WorldState => {
  const w = normalizeWorld(defaultWorld(TODAY));
  seed?.(w);
  return w;
};

interface Pair {
  tool: string;
  args: Record<string, unknown>;
  // The route's answer, rendered from the fixture world.
  route: (w: WorldState) => Route;
  label?: string;
  seed?: (w: WorldState) => void;
  prisma?: unknown;
  // shape: the data's shape agrees. refusal: the whole refusal agrees. envelope: a route-owned 202's ok, status and code agree.
  kind?: "shape" | "refusal" | "envelope";
}

const TONER = { id: "run-7", title: "Supplier toner price check", goal: "Compare current toner prices from our suppliers.", status: "running", iteration: 6, maxIter: 30 };
const FAILED = { id: "run-3", title: "Toner check", goal: "Compare toner prices.", status: "failed", iteration: 4, maxIter: 30, summary: "Partial: Acme charges $42.", error: "Upstream timeout" };
// A run as GET /api/agent-runs sends it (list-agent-runs.ts RunItem).
const runItem = (r: WorldState["runs"][number]) => ({
  id: r.id, title: r.title, goal: r.goal, status: r.status, createdAt: r.createdAt ?? "2026-10-04T09:00:00.000Z", endedAt: r.endedAt ?? null,
  iteration: r.iteration, maxIter: r.maxIter, error: r.error ?? null, result: r.summary ?? null, summary: r.summary ?? null, pending: null,
});
const runsRoute = (w: WorldState): Route => (_m, p) => {
  const one = /^\/api\/agent-runs\/([^/?]+)\?/.exec(p);
  if (!one) return json(200, { items: w.runs.map(runItem) });
  const r = w.runs.find((x) => x.id === decodeURIComponent(one[1]));
  return r ? json(200, runItem(r)) : json(404, { error: "not_found" });
};
// A routine as GET /api/tools sends it (routine-list.ts SpecRow).
const specRow = (r: WorldState["routines"][number]) => ({
  id: `spec-${r.slug}`, slug: r.slug, name: r.name, category: r.category ?? null, description: r.description ?? null, version: 1, status: r.status,
  visibility: r.visibility, writes: r.writes, reversible: r.reversible, updatedAt: "2026-09-28T09:00:00.000Z", stepCount: r.steps.length,
  runCount: r.runs ?? 0, schedules: [],
});
// The thread row the email routes send (routes/email.ts ThreadRow).
const THREAD = {
  id: "th-landlord", accountId: "acct-main", threadKey: "th-landlord", subject: "Lease renewal paperwork", lastSender: "Lakeshore Property Management <pm@lakeshore-properties.example>",
  snippet: "Please sign and return the renewal by the 15th.", messageCount: 1, triageStatus: "inbox", draftedByDroplet: false, lastMessageAt: "2026-09-30T14:30:00.000Z",
};
const FACT = { id: "fact-1", category: "Business", fact: "Beta is our code name.", addedBy: "eval-owner", addedAt: new Date("2026-09-01T09:00:00Z"), audience: "family", active: true };
const memPrisma = {
  memoryFact: {
    create: async ({ data }: any) => ({ id: "fact-9", ...data, addedAt: new Date("2026-10-05T12:00:00Z") }),
    findMany: async () => [FACT],
    findUnique: async ({ where }: any) => (where.id === FACT.id ? FACT : null),
    update: async () => ({}),
  },
};
const seedFact = (w: WorldState) => { w.memory = [{ id: FACT.id, category: FACT.category, fact: FACT.fact }]; };
const draftRoutine: WorldState["routines"][number] = { slug: "evening-recap", name: "Evening recap", status: "draft", writes: false, reversible: true, steps: [{ kind: "summarize" }] };
const MAC = "DA:A1:19:7F:3C:5E";
const route202: Route = () => json(202, { reason: "This needs the dashboard.", confirmationToken: "tok" });

const PAIRS: Pair[] = [
  // calendar: the route's EventJson rows, the tool's toolEvent mapping.
  { tool: "list_events", args: { from: "2026-10-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }, route: (w) => () => json(200, { events: w.events.map(eventJson) }) },
  { tool: "search_calendar_events", args: { query: "standup" }, route: (w) => () => json(200, { events: w.events.map(eventJson) }) },
  { tool: "create_event", args: { title: "Vendor review", starts_at: "2026-10-09T14:00:00Z", ends_at: "2026-10-09T15:00:00Z" }, route: () => (_m, _p, b) => json(201, { event: { id: "evt-9", title: b.title, startsAt: b.startsAt } }) },
  { tool: "update_event", args: { id: "evt-1", title: "Standup (moved)" }, route: () => () => json(200, { event: { id: "evt-1" } }) },
  { tool: "delete_event", args: { id: "evt-1" }, route: () => () => json(200, {}) },
  // reminders
  { tool: "list_reminders", args: {}, route: (w) => () => json(200, { reminders: w.reminders.map((r) => ({ id: r.id, title: r.title, body: r.body ?? null, dueAt: r.due, status: r.done ? "completed" : "pending" })) }) },
  { tool: "create_reminder", args: { title: "Pay rent", due_at: "2026-10-10T09:00:00Z" }, route: () => (_m, _p, b) => json(201, { reminder: { id: "rem-9", dueAt: b.dueAt } }) },
  { tool: "complete_reminder", args: { id: "rem-1" }, route: () => () => json(200, {}) },
  // email
  { tool: "email_accounts", args: {}, route: (w) => () => json(200, { accounts: w.accounts.map((x) => ({ ...x, canSend: true })) }) },
  { tool: "email_search", label: "email_search (no query)", args: { accountId: "acct-main" }, route: () => () => json(200, { filter: "inbox", threads: [THREAD], nextCursor: null }) },
  { tool: "email_search", label: "email_search (query)", args: { accountId: "acct-main", query: "lease" }, route: () => () => json(200, { filter: "inbox", threads: [THREAD], nextCursor: null }) },
  { tool: "email_draft_reply", args: { accountId: "acct-main", threadId: "th-quote", toAddrs: ["marta@brightline-office.example"], subject: "Re: Toner quote for Q4", body: "Thanks." }, route: () => () => json(201, { id: "draft-9", status: "draft" }) },
  {
    tool: "email_send", args: { draftId: "drf-1" },
    seed: (w) => { w.drafts = [{ id: "drf-1", threadId: "th-quote", toAddrs: ["marta@brightline-office.example"], ccAddrs: [], subject: "Re: Toner quote for Q4", body: "Thanks.", status: "draft" }]; },
    route: () => () => json(200, { id: "drf-1", status: "queued", message: "Queued for SMTP send by the email-indexer service." }),
  },
  { tool: "search_contacts", args: { query: "marta" }, route: () => () => json(200, { accountCount: 1, contacts: [{ address: "marta@brightline-office.example", name: "Marta Lindqvist", lastSeenAt: "2026-09-28T16:10:00.000Z", messageCount: 1 }] }) },
  // background runs
  { tool: "list_agent_runs", label: "list_agent_runs (list)", args: {}, seed: (w) => { w.runs = [FAILED]; }, route: runsRoute },
  { tool: "list_agent_runs", label: "list_agent_runs (run_id)", args: { run_id: "run-3" }, seed: (w) => { w.runs = [FAILED]; }, route: runsRoute },
  { tool: "start_agent_run", args: { goal: "Compare toner prices from our suppliers.", title: "Toner prices" }, route: () => () => json(201, { id: "run-9", status: "queued", queuePosition: 1 }) },
  { tool: "cancel_agent_run", args: { run_id: "run-7" }, seed: (w) => { w.runs = [TONER]; }, route: () => () => json(200, {}) },
  // routines
  { tool: "routine_list", args: {}, route: (w) => () => json(200, { specs: w.routines.map(specRow) }) },
  { tool: "routine_draft", args: { slug: "evening-recap", name: "Evening recap", steps: [{ kind: "summarize" }] }, route: () => () => json(201, { slug: "evening-recap", status: "draft", writes: false, steps: [{ kind: "summarize" }] }) },
  { tool: "routine_run", args: { slug: "morning-bookings-digest" }, route: () => () => json(200, { runId: "rr-1", slug: "morning-bookings-digest", status: "ok", trace: [] }) },
  // memory: the handlers read their rows through ctx.prisma, so the pair stubs the four methods they call.
  { tool: "memory_extract_fact", args: { category: "Business", fact: "Atlas is our new supplier portal project.", confirmed: true }, prisma: memPrisma, route: () => () => json(500, {}) },
  { tool: "memory_recall", args: { query: "beta" }, seed: seedFact, prisma: memPrisma, route: () => () => json(500, {}) },
  { tool: "memory_forget", args: { id: "fact-1", confirmed: true }, seed: seedFact, prisma: memPrisma, route: () => () => json(500, {}) },
  // refusals: the code AND message are what the model reads. An unknown mailbox is a 404 on every email route.
  { kind: "refusal", tool: "email_search", args: { accountId: "acct-wrong" }, route: () => () => json(404, { error: "Account not found" }) },
  { kind: "refusal", tool: "email_read", args: { accountId: "acct-wrong", threadId: "th-quote" }, route: () => () => json(404, { error: "Thread not found" }) },
  { kind: "refusal", tool: "email_summarize_thread", args: { accountId: "acct-wrong", threadId: "th-quote" }, route: () => () => json(404, { error: "Thread not found" }) },
  { kind: "refusal", tool: "email_draft_reply", args: { accountId: "acct-wrong", toAddrs: [], subject: "x", body: "y" }, route: () => () => json(404, { error: "Account not found" }) },
  { kind: "refusal", tool: "list_agent_runs", args: { run_id: "run-x" }, route: () => () => json(404, { error: "not_found" }) },
  { kind: "refusal", tool: "cancel_agent_run", args: { run_id: "run-x" }, route: () => () => json(404, { error: "not_found" }) },
  { kind: "refusal", tool: "cancel_agent_run", label: "cancel_agent_run (finished)", args: { run_id: "run-3" }, seed: (w) => { w.runs = [FAILED]; }, route: () => () => json(409, { status: "failed" }) },
  { kind: "refusal", tool: "routine_run", label: "routine_run (unknown)", args: { slug: "nope" }, route: () => () => json(404, { error: "not_found" }) },
  { kind: "refusal", tool: "routine_run", label: "routine_run (draft)", args: { slug: "evening-recap" }, seed: (w) => { w.routines.push(draftRoutine); }, route: () => () => json(400, { error: "not_live", status: "draft" }) },
  { kind: "refusal", tool: "routine_draft", label: "routine_draft (taken)", args: { slug: "morning-bookings-digest", name: "Again", steps: [{ kind: "summarize" }] }, route: () => () => json(409, { error: "slug_taken" }) },
  { kind: "refusal", tool: "memory_forget", label: "memory_forget (unknown)", args: { id: "fact-x", confirmed: true }, prisma: memPrisma, route: () => () => json(500, {}) },
  // route-owned writes: the route answers 202, the handler relays it, nothing is written.
  { kind: "envelope", tool: "block_network_device", args: { mac: MAC }, route: () => route202 },
  { kind: "envelope", tool: "unblock_network_device", args: { mac: MAC }, route: () => route202 },
  { kind: "envelope", tool: "share_clip", args: { nc_path: "/Clips/front/20261001-140000Z.mp4" }, route: () => route202 },
];

const bad: string[] = [];
for (const p of PAIRS) {
  const label = p.label ?? p.tool;
  try {
    const real = await TOOLS.get(p.tool).handler(p.args, ctxWith(p.route(mk(p.seed)), p.prisma));
    const sim = handle(mk(p.seed), p.tool, p.args, who);
    if (!sim) { bad.push(`XX  shapes ${label}: world.mts does not script ${p.tool}`); continue; }
    if (p.kind === "refusal") {
      const [r, s] = [wire(real), wire(sim)];
      if (JSON.stringify(r) !== JSON.stringify(s)) bad.push(`XX  shapes ${label}: real ${JSON.stringify(r)} != world ${JSON.stringify(s)}`);
    } else if (p.kind === "envelope") {
      const [r, s] = [real, sim].map((x: any) => JSON.stringify([x.ok, x.status, x.error?.code, typeof x.error?.message]));
      if (r !== s) bad.push(`XX  shapes ${label}: real ${r} != world ${s}`);
    } else if (!real.ok || !sim.ok) {
      bad.push(`XX  shapes ${label}: real ${real.ok ? "ok" : `${real.error?.code} ${real.error?.message}`}, world ${sim.ok ? "ok" : `${sim.error.code} ${sim.error.message}`}`);
    } else {
      const [r, s] = [real.data, sim.data].map((d) => JSON.stringify(shapeOf(wire(d))));
      if (r !== s) bad.push(`XX  shapes ${label}:\n      real  ${r}\n      world ${s}`);
    }
  } catch (e) {
    bad.push(`XX  shapes ${label}: ${(e as Error)?.message ?? e}`);
  }
}
if (bad.length) {
  console.log(bad.join("\n"));
  process.exit(1);
}
console.log(`ok  shapes: ${new Set(PAIRS.map((p) => p.tool)).size} tools (${PAIRS.length} calls) agree with tools-core`);
