/**
 * 2026-07-21 agent-budgets spec §3 — relevance-based tool selection.
 *
 * The owner-role chat loop advertises every in-scope tool schema on every
 * turn (~11k tokens of the 16k window — see chat-tool-scope.ts / WARP-1424),
 * which both starves history/memory of context and measurably degrades tool
 * CHOICE on small local models (the WARP-1334 skips-retrieval class). This
 * service narrows the advertisement per-turn.
 *
 * Deterministic by design: keyword rules → ToolDomain groups. No embedding
 * call, no second LLM call — the single-box has no latency budget for
 * either. Wrong guesses self-heal in the agent loop (a filtered-but-allowed
 * call expands its domain next iteration; see llm-agent.service.ts).
 *
 * INVARIANT: the result is always a subset of `pool`. RBAC narrowing
 * (narrowAllowedToolsForRole / WRITE_TOOLS) has already been applied to the
 * pool before this runs; this layer must never widen it.
 *
 * The taxonomy is tools-core's TOOL_CATALOG (registry-derived, completeness
 * CI-enforced by catalog.test.ts) — never a parallel list that can drift.
 */
import { TOOL_CATALOG, type ToolDomain } from "@droplet/tools-core";

export type ToolSelectionMode = "off" | "domains";

/** Reverse index over the CI-complete catalog: tool name → its domain. */
const DOMAIN_BY_NAME: ReadonlyMap<string, ToolDomain> = new Map(
  TOOL_CATALOG.map((e) => [e.name, e.domain]),
);

/**
 * Always advertised (when present in the pool): retrieval + memory-read.
 * These are the tools nearly every knowledge turn needs, and the eval's
 * worst failure class is the model NOT reaching for them.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_content",
  "read_file",
  // WARP-2057 — must be core for the same reason `read_file` is, and
  // more urgently: `read_file` REJECTS PDFs and scans outright. Leaving
  // its only PDF-capable sibling behind a domain match is the worst of
  // both worlds — every turn advertises the reader that cannot open the
  // file, and the one that can is absent unless the user happened to
  // type a files-domain word.
  "read_document_text",
  "list_files",
  "memory_recall",
]);

/**
 * Keyword/intent rules → domains. Case-insensitive test against the latest
 * user message. Deliberately generous: a false-positive domain costs a few
 * hundred schema tokens; a false NEGATIVE costs an iteration (self-heal).
 * pm / erp / switch have no rules — they're excluded from default chat
 * scope (chat-tool-scope.ts) and reachable via explicit allowed_tools.
 *
 * WARP-1921 — vocabulary widened from the original WARP-1207 cut, which was
 * written from the TOOL NAMES rather than from how people talk. The tell:
 *
 *     "show me people at the front door yesterday"
 *
 * matched NOTHING — not `cameras?`, not `clips?`, not `doorbell` — so the
 * turn advertised the core four tools and no camera tools at all. That is
 * the single most likely camera sentence a household will type. The rules
 * below add the NOUNS people actually use (what they are looking for, and
 * the places they look) alongside the system's own words.
 *
 * TESTING DISCIPLINE: `tool-selection.service.test.ts` drives these from
 * whole sentences a household member would plausibly type. Asserting with
 * the vocabulary already inside the pattern is a tautology — it is exactly
 * what let the `people` gap ship green.
 */
const DOMAIN_RULES: ReadonlyArray<{ pattern: RegExp; domains: ToolDomain[] }> = [
  // `rename`/`relabel` claims files AND cameras (below): "rename Blue Eye
  // to Kitchen" names the target only by its label, so the verb is the
  // ONLY signal. A false-positive domain is cheap (see the rule comment).
  { pattern: /\b(files?|documents?|docs?|pdf|photos?|images?|pictures?|notes?|folders?|receipts?|invoices?|csv|spreadsheets?|uploads?|attachments?|downloads?|scans?|presentations?|slides?|renam(e[sd]?|ing)|re-?label(s|l?ed|l?ing)?)\b/i, domains: ["files"] },
  { pattern: /\b(lights?|lamps?|scenes?|thermostat|plugs?|sockets?|outlets?|switch(es)?|heating|cooling|air-?con(ditioning)?|fans?|temperature|dim|brightness|blinds?|curtains?|locks?|unlock|routines?|turn (on|off))\b/i, domains: ["smart-home"] },
  { pattern: /\b(wi-?fi|network|internet|router|dhcp|firewall|ssid|block(ed|s)?|unblock|bandwidth|devices?|online|offline|connected|guest|ethernet|vpn|slow)\b/i, domains: ["network"] },
  // The places a household points cameras, and the things it looks for —
  // NOT just the word "camera". See the WARP-1921 note above. Rename verbs
  // included (WARP-1893): "rename Blue Eye to Kitchen" identifies the
  // camera by display name alone, so without the verb the turn would never
  // advertise rename_camera.
  { pattern: /\b(cameras?|clips?|recordings?|footage|motion|doorbell|snapshots?|surveillance|nvr|frigate|live view|people|person|someone|somebody|anybody|anyone|intruders?|visitors?|packages?|parcels?|deliver(y|ies)|driveway|porch|doorstep|front door|back door|garage|yard|gate|who (was|were|came|is|has been)|renam(e[sd]?|ing)|re-?label(s|l?ed|l?ing)?)\b/i, domains: ["cameras"] },
  { pattern: /\b(calendar|meetings?|appointments?|events?|schedule|agenda|busy|free time|what'?s on)\b/i, domains: ["calendar"] },
  { pattern: /\b(remind(er)?s?|tasks?|to-?dos?|don'?t forget|shopping list)\b/i, domains: ["reminders"] },
  { pattern: /\b(notifications?|notify|alerts?)\b/i, domains: ["notifications"] },
  // WARP-2058 — the `pm` domain had NO rule, so under the shipping
  // `domains` default not one `pm_*` tool was ever advertised: the whole
  // project tracker was unreachable from chat regardless of RBAC. Kept
  // distinct from the `reminders` rule above, which owns bare
  // "tasks"/"to-dos" — a household to-do is not a tracker work item, and
  // both domains matching a sentence that mentions each is the intended
  // generous behaviour, not a collision.
  { pattern: /\b(projects?|backlogs?|sprints?|milestones?|work items?|tickets?|issues?|kanban|epics?|tracker|scope of work|statement of work)\b/i, domains: ["pm"] },
  { pattern: /\b(e-?mails?|inbox|newsletters?|unread|spam|replied?|sent)\b/i, domains: ["email"] },
  { pattern: /\b(remember|memory|forget|know about me)\b/i, domains: ["memory"] },
  { pattern: /\b(business|company|opening hours|customers?)\b/i, domains: ["business"] },
  { pattern: /\b(time|date|today|tomorrow|yesterday|weather|calculate|convert|translate|timestamp)\b/i, domains: ["data"] },
  // `memory usage`, never bare `memory` — that word belongs to the memory
  // domain above ("what do you remember about me"), and claiming it here
  // would drag the system tools into every recall question.
  { pattern: /\b(storage|disks?|drives?|updates?|system|health|audit|cpu|ram|gpu|memory usage|backups?|uptime|logs?|disk space|how much (room|space))\b/i, domains: ["system"] },
];

export function domainOfTool(name: string): ToolDomain | undefined {
  return DOMAIN_BY_NAME.get(name);
}

export function toolNamesForDomain(domain: ToolDomain): string[] {
  return TOOL_CATALOG.filter((e) => e.domain === domain).map((e) => e.name);
}

/**
 * Compute the per-turn advertised subset: core set ∪ rule-matched domains ∪
 * domains of tools already called in this conversation (continuity). Pure —
 * no I/O, no clock, safe to call per turn.
 */
export function selectAdvertisedTools(opts: {
  mode: ToolSelectionMode;
  userMessage: string;
  pool: string[];
  conversationToolNames: string[];
}): { advertised: string[]; matchedDomains: ToolDomain[] } {
  if (opts.mode === "off") {
    return { advertised: opts.pool, matchedDomains: [] };
  }
  const domains = new Set<ToolDomain>();
  for (const rule of DOMAIN_RULES) {
    if (rule.pattern.test(opts.userMessage)) {
      for (const d of rule.domains) domains.add(d);
    }
  }
  for (const name of opts.conversationToolNames) {
    const d = DOMAIN_BY_NAME.get(name);
    if (d) domains.add(d);
  }
  const advertised = opts.pool.filter((name) => {
    if (CORE_TOOL_NAMES.has(name)) return true;
    const d = DOMAIN_BY_NAME.get(name);
    return d !== undefined && domains.has(d);
  });
  return { advertised, matchedDomains: [...domains] };
}
