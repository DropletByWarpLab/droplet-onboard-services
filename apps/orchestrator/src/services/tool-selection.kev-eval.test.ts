/**
 * WARP-3069 — the accuracy half of the Kev go/no-go (epic WARP-3067, ADR-006 in
 * droplet-local-LLM). OPT-IN: skipped unless KEV_EVAL_URL points at a running
 * `decision-model` (droplet-local-LLM, profile `decision`). It is an
 * evaluation, not a gate; it reports and asserts only that it ran.
 *
 *   KEV_EVAL_URL=http://127.0.0.1:8009 KEV_EVAL_KEY=... npx vitest run \
 *     src/services/tool-selection.kev-eval.test.ts
 *
 * THE QUESTION: does Kev miss fewer tool domains than the keyword rules in
 * tool-selection.service.ts, and at what cost in extra domains? A missed
 * domain costs a whole agent iteration (the service header prices it); an
 * extra domain costs a few hundred schema tokens. So the headline metric is
 * the MISS RATE: turns where at least one needed domain was not advertised.
 *
 * THE CORPUS is held out on purpose: `__fixtures__/tool-selection-heldout.jsonl`
 * was written by an agent that was shown the domain -> tool map only, never
 * DOMAIN_RULES, so the keyword rules are not scored on sentences tuned to
 * them. (The regression corpus in tool-selection.regression.test.ts is the
 * opposite — each turn there was added BECAUSE the rules now catch it — which
 * is why it is not the scoreboard here.) Labels are synthetic; real turns from
 * a box's agent-run history remain the stronger test.
 *
 * SHAPES, because Kev's cost is per QUESTION (each question is its own row on
 * a Qwen3.5 base — ADR-006 "Early measurements"):
 *   nouls     one yes/no per domain (22 rows) — most expressive, most expensive
 *   choice    one `choice` over the domains + "none" (1 row); admit every
 *             domain whose probability clears the threshold
 * each either UNIONED with the keyword matches on every turn, or used only as
 * a FALLBACK on turns where the keywords matched nothing (Kev called rarely).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDomain } from "@droplet/tools-core";
import { describe, expect, it } from "vitest";
import { selectAdvertisedTools, toolNamesForDomain } from "./tool-selection.service.js";

const URL_ = process.env.KEV_EVAL_URL ?? "";
const KEY = process.env.KEV_EVAL_KEY ?? "";
const RUN = URL_.length > 0;

/**
 * The domain wording Kev reads. This IS the prompt a WARP-3073 consumer would
 * ship, so it is written for an office worker's request, not for the LLM.
 * Keys must cover every ToolDomain in tools-core's catalog.
 */
const DOMAIN_TEXT: Record<ToolDomain, string> = {
  network: "the office internet, Wi-Fi, connected devices, firewall, VPN or bandwidth",
  files: "the business's documents, folders and files: finding, reading, sharing, organising or cleaning them up",
  "smart-home": "lights, heating, thermostats, locks, plugs or scenes in the building",
  cameras: "security cameras, recordings, motion events or who came and went",
  switch: "the network switch, its ports or PoE",
  calendar: "meetings, appointments, events or someone's availability",
  reminders: "reminders, to-dos or timers",
  notifications: "sending or reading the box's notifications",
  email: "reading, searching, drafting or sending email",
  memory: "remembering, recalling or forgetting a fact or preference about the user",
  pm: "projects, tasks, tickets or issue trackers",
  money: "invoices, bills and financial documents from the connected ledger",
  crm: "customers, clients, contacts, leads or deals in the CRM",
  erp: "the practice-management or ERP system: patients, appointments, orders, inventory records",
  cloud: "connected SaaS accounts such as Stripe, HubSpot, Mailchimp or Shopify, and their data",
  business: "the business profile, departments, policies or company facts",
  team_chat: "team chat such as Slack or Teams",
  agent_runs: "long-running background tasks the assistant works on while the user is away",
  routines: "automations or routines that run on a schedule",
  workspace: "the shared company Workspace, its members, guests and access",
  system: "the Droplet box itself: health, storage, updates, backups, logs",
  data: "analysing tables, spreadsheets or numbers",
};
const DOMAINS = Object.keys(DOMAIN_TEXT) as ToolDomain[];
const THRESHOLDS = [0.1, 0.2, 0.3, 0.5];

interface Turn { id: string; text: string; domains: ToolDomain[] }

function keywordDomains(text: string): Set<string> {
  const { matchedDomains } = selectAdvertisedTools({
    mode: "domains", userMessage: text, pool: [], conversationToolNames: [],
  });
  return new Set(matchedDomains);
}

async function systemOne(state: string, questions: object): Promise<{ answers: Record<string, any>; latency_ms: number }> {
  const res = await fetch(`${URL_.replace(/\/$/, "")}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ state, model: "kev-latest", questions }),
  });
  if (!res.ok) throw new Error(`decision-model ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ answers: Record<string, any>; latency_ms: number }>;
}

async function kevNouls(text: string) {
  const qs = Object.fromEntries(DOMAINS.map((d) => [d, {
    type: "noul", instructions: `To handle this request, does the assistant need tools for ${DOMAIN_TEXT[d]}?`,
  }]));
  const r = await systemOne(text, qs);
  return { p: Object.fromEntries(DOMAINS.map((d) => [d, r.answers[d].noul as number])), ms: r.latency_ms };
}

async function kevChoice(text: string) {
  const criteria = { ...DOMAIN_TEXT, none: "none of these: small talk or a general question needing no tools" };
  const r = await systemOne(text, { domain: {
    type: "choice", instructions: "Which area's tools does the assistant need to handle this request?", criteria,
  } });
  return { p: r.answers.domain.probabilities as Record<string, number>, ms: r.latency_ms };
}

interface Tally { missed: number; needing: number; extra: number; turns: number; kevCalls: number }
const empty = (): Tally => ({ missed: 0, needing: 0, extra: 0, turns: 0, kevCalls: 0 });

function score(t: Tally, admitted: Set<string>, needed: string[], calledKev: boolean) {
  t.turns++;
  if (calledKev) t.kevCalls++;
  if (needed.length) {
    t.needing++;
    if (needed.some((d) => !admitted.has(d))) t.missed++;
  }
  t.extra += [...admitted].filter((d) => !needed.includes(d)).length;
}

describe.skipIf(!RUN)("Kev tool-domain selection vs keyword rules (WARP-3069, opt-in)", () => {
  it("reports miss rate and extra domains per shape", async () => {
    const turns: Turn[] = readFileSync(join(__dirname, "__fixtures__", "tool-selection-heldout.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const t of turns) for (const d of t.domains) expect(DOMAINS, `${t.id} label`).toContain(d);
    // A domain with no local tools (pm/crm today: filled only by remote MCP
    // servers at runtime) cannot be "missed" — advertising it adds nothing.
    // Scoring it would charge both methods for a gap neither can close.
    const toolless = new Set(DOMAINS.filter((d) => toolNamesForDomain(d).length === 0));
    for (const t of turns) t.domains = t.domains.filter((d) => !toolless.has(d));

    const rows = new Map<string, Tally>();
    const tally = (k: string) => rows.get(k) ?? rows.set(k, empty()).get(k)!;
    const ms = { nouls: [] as number[], choice: [] as number[] };

    for (const t of turns) {
      const kw = keywordDomains(t.text);
      const [n, c] = [await kevNouls(t.text), await kevChoice(t.text)];
      ms.nouls.push(n.ms); ms.choice.push(c.ms);
      score(tally("keywords only"), kw, t.domains, false);
      for (const th of THRESHOLDS) {
        const nSet = new Set(DOMAINS.filter((d) => n.p[d] >= th));
        const cSet = new Set(DOMAINS.filter((d) => (c.p[d] ?? 0) >= th));
        score(tally(`nouls  ∪ keywords  @${th}`), new Set([...kw, ...nSet]), t.domains, true);
        score(tally(`choice ∪ keywords  @${th}`), new Set([...kw, ...cSet]), t.domains, true);
        score(tally(`nouls  fallback    @${th}`), kw.size ? kw : nSet, t.domains, kw.size === 0);
        score(tally(`choice fallback    @${th}`), kw.size ? kw : cSet, t.domains, kw.size === 0);
      }
    }

    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const lines = [
      `Kev tool-domain eval — ${turns.length} held-out turns, ${URL_}`,
      `not scored (no local tools in the catalog): ${[...toolless].join(", ") || "none"}`,
      `model time p50: nouls ${med(ms.nouls).toFixed(0)} ms, choice ${med(ms.choice).toFixed(0)} ms (hardware-dependent; latency verdict is the bench box's)`,
      "",
      "| shape | miss rate | extra domains / turn | Kev called on |",
      "|---|---|---|---|",
      ...[...rows].map(([k, t]) =>
        `| ${k} | ${(100 * t.missed / t.needing).toFixed(1)}% (${t.missed}/${t.needing}) | ${(t.extra / t.turns).toFixed(2)} | ${(100 * t.kevCalls / t.turns).toFixed(0)}% |`),
    ];
    console.log(lines.join("\n"));
    if (process.env.KEV_EVAL_OUT) writeFileSync(process.env.KEV_EVAL_OUT, lines.join("\n") + "\n");
    expect(rows.get("keywords only")!.turns).toBe(turns.length);
  }, 30 * 60_000);
});
