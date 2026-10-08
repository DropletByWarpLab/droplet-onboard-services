/**
 * stored-content-egress.service.ts — WARP-1983.
 *
 * THE RULE: a chat turn that leaves the LAN carries none of the customer's
 * stored content. Not the text of their documents, not the images they
 * attached, not the filenames.
 *
 * WHY FILENAMES COUNT. On a box installed at a clinic, `list_files` alone is
 * an egress path: "J Smith perio chart 2026-03.pdf" is protected health
 * information before a single byte of the document is read. A gate that
 * withheld document *bodies* but advertised `list_files` and `search_files`
 * would read as protection and not be it. So the unit withheld here is the
 * whole surface, not the content-bearing half of it.
 *
 * WHAT THIS IS NOT. This is not the cloud gate. `cloud-access.service.ts`
 * decides WHETHER a person may run a turn off-box at all, and refuses with a
 * 451 when they may not. This module assumes that decision already said yes,
 * and constrains what the permitted turn is allowed to carry. Both run; they
 * answer different questions.
 *
 * LOCAL TURNS ARE UNTOUCHED. The on-box model keeps the full Drive surface,
 * because its context never leaves the appliance — that is the whole premise
 * of the product. Every branch here is reached only when the resolved
 * provider is non-local.
 *
 * DERIVED, NEVER HAND-MAINTAINED. The withheld names come from
 * `TOOL_CATALOG`'s domain grouping, whose completeness is already pinned by
 * `packages/tools-core/src/__tests__/catalog.test.ts` ("add a tool to
 * registry.ts without slotting its name into a domain and the suite goes
 * red"). A new file tool therefore joins this set the day it is registered,
 * with no edit here and no silent gap. Listing names literally in this file
 * is the one thing that would reintroduce the drift the catalog exists to
 * prevent.
 */
import { TOOL_CATALOG, TOOL_DOMAINS, type ToolDomain } from "@droplet/tools-core";

/**
 * The domains whose tools read the customer's own stored material.
 *
 *  - `files`  — the Drive. The surface this ticket is about.
 *  - `hosted_apps` — app inventory and process logs may carry private names,
 *    URLs and customer content. Keep both read tools on the local model;
 *    granting an app or its tool domain does not authorize cloud disclosure.
 *  - `memory` — the brain. `memory_recall` returns facts EXTRACTED from that
 *    same Drive content (the attachment path writes `BrainMemoryItem` +
 *    `FileContentChunk` rows), so withholding `files` while leaving `memory`
 *    advertised would leave the hole open one indirection further down.
 *  - `business` — WARP-2990 (Romain, 2026-09-22: "withheld, the same as the
 *    memory tool"). `business_profile_get` returns the BusinessProfile the
 *    prompt gate below withholds, and `business_find` reaches CRM/PM records
 *    and the ADR-051 brain findings, so leaving the domain advertised would
 *    hand a cloud model on request exactly what it is not given unasked. The
 *    whole domain goes, writes included: a cloud turn has no business surface.
 *
 *    COMPOSES WITH the per-person feature/domain gate (access-catalog.ts,
 *    WARP-2742/2988: `business` needs CRM or Projects) as an AND. That gate
 *    decides who may reach the domain at all; this one only ever subtracts
 *    from what it already allowed, so a business tool reaches a turn only if
 *    both say yes — on a cloud turn, never.
 *
 *  - `email`, `calendar`, `team_chat`, `cameras`, `cloud`, `money`, `erp`,
 *    `crm`, `pm` — WARP-3570. These carry customer correspondence, schedules,
 *    member-to-member messages, camera events, connected SaaS data, ledger
 *    documents and, for `erp`, the practice-management PHI surface. The
 *    first version of this gate (WARP-1983) left them out as a scope
 *    decision about the Drive; no product decision to keep them on a cloud
 *    turn was ever recorded, and a result they return is sent to the cloud
 *    provider on the next model call, so they are withheld too.
 *  - `connections` — account identities and provider status are customer
 *    metadata. Setup and revocation stay on the appliance under the same
 *    default-deny rule; adding these tools does not permit off-LAN access.
 *
 * DEFAULT-DENY. The set is written the other way round: the domains that MAY
 * be advertised to a cloud model are listed in {@link OFF_LAN_PERMITTED_DOMAINS},
 * and every other domain in `TOOL_DOMAINS` is withheld. A domain added to the
 * catalog later is therefore withheld until a person decides, in the test
 * that pins both sets, that it is safe to send off-box.
 *
 * DECIDED, NOT WITHHELD: `workspace` (WARP-2896, Stefan 2026-09-23). A
 * workshop run's repository is code its owner is writing, not stored
 * customer material, and the run already passed the per-person cloud gate
 * (`decideCloudTurn` at every claim) — so a person cleared for cloud models
 * may build with one, and the repository and command output go to that
 * provider. Withholding the domain would leave a cloud workshop run with no
 * tools at all: a run that can only fail, not a privacy boundary.
 */
/**
 * The domains a cloud model is allowed to see tools for. Everything here is
 * either static computation, box or network health, device control or the
 * workshop. Adding a domain is a product decision about what a cloud model
 * is for; `stored-content-egress.catalog.test.ts` pins this set.
 *
 * Open decisions, recorded on WARP-3570: `network` and `smart-home` return
 * device names and hostnames, `reminders` and `notifications` return text
 * people wrote, `system` includes `get_audit_log`, and `agent_runs` lists
 * run results. They stay permitted here because the finding scoped the
 * minimum fix to the seven domains above.
 */
export const OFF_LAN_PERMITTED_DOMAINS: ReadonlySet<ToolDomain> = new Set<ToolDomain>([
  "network",
  "switch",
  "smart-home",
  "reminders",
  "notifications",
  "system",
  "data",
  "agent_runs",
  "routines",
  "workspace",
]);

/** Every catalog domain that is not permitted off-LAN. */
export const OFF_LAN_WITHHELD_DOMAINS: ReadonlySet<ToolDomain> = new Set<ToolDomain>(
  TOOL_DOMAINS.filter((domain) => !OFF_LAN_PERMITTED_DOMAINS.has(domain)),
);

/**
 * Tool names withheld from an off-LAN turn. Computed once at module load —
 * `TOOL_CATALOG` is a static array built at import time, so there is nothing
 * to invalidate and no per-turn cost on the chat hot path.
 */
export const OFF_LAN_WITHHELD_TOOLS: ReadonlySet<string> = new Set(
  TOOL_CATALOG.filter((entry) => OFF_LAN_WITHHELD_DOMAINS.has(entry.domain)).map(
    (entry) => entry.name,
  ),
);

/** True for a tool that must not be advertised to an off-LAN model. */
export function isWithheldFromOffLan(name: string): boolean {
  return OFF_LAN_WITHHELD_TOOLS.has(name);
}

/**
 * Remove the stored-content tools from an allowed-tools list.
 *
 * The caller MUST materialise `undefined` (the privileged-role "full
 * registry" sentinel) into a real list before calling this — an owner is
 * exactly the role most likely to be running a cloud model, so silently
 * passing their `undefined` through would make this gate a no-op for the one
 * person it most needs to hold for. `narrowAllowedToolsForRole` has the same
 * shape and `stripWriteToolsForInterview` the same obligation.
 */
export function withholdStoredContentTools(allowed: readonly string[]): string[] {
  return allowed.filter((name) => !isWithheldFromOffLan(name));
}

/**
 * What the model is told INSTEAD. Honest degradation (the `erp.service.ts`
 * posture): a model that simply finds no file tools will invent a reason it
 * cannot help, or worse, answer from memory as though it had read something.
 * Naming the constraint lets it tell the truth and point at the remedy.
 */
export const OFF_LAN_WITHHELD_NOTICE =
  "You are running on a cloud model, off this appliance. The user's stored " +
  "files, their contents, their filenames, and any attachments are NOT " +
  "available to you on this turn, and no file, memory or business-record " +
  "tools are offered, and neither are email, calendar, team chat, camera, " +
  "cloud-account, accounting or practice-management tools. " +
  "Stored content was also left out of these instructions: the facts the " +
  "user asked you to remember, the business profile, what the Droplet has " +
  "learned about the business, and any pinned items. This is a deliberate " +
  "privacy boundary, not a malfunction or a permissions error. If the user " +
  "asks about their documents or anything you would " +
  "normally remember, say plainly that it stays on the Droplet and is not " +
  "sent to cloud models, " +
  "and that switching to the on-box model in the model picker gives you " +
  "full access to it.";

/**
 * Appended when the user attached something to a turn that then resolved
 * off-LAN. Distinct from the notice above because the failure is visible to
 * the user — they can see the attachment in their own message — so silence
 * would read as the model ignoring them.
 */
export const OFF_LAN_ATTACHMENT_NOTICE =
  "The user attached one or more files to this message. Their contents and " +
  "images were withheld because this turn is running on a cloud model. Tell " +
  "the user their attachment stayed on the Droplet, and that switching to " +
  "the on-box model lets you read it.";

/**
 * WARP-2746 — the PROMPT axis of the same rule.
 *
 * The tool gate above stops a cloud model from ASKING for stored content. It
 * did nothing about stored content the route hands over unasked: the memory
 * facts, the business profile, the brain block and the context pins were
 * spliced into every turn's system prompt whatever its destination. So a
 * cloud turn had `memory_recall` withheld and then received the same facts
 * in its instructions. The tool was withheld; the data was not.
 *
 * Every block the route injects is named here and is either withheld or,
 * by omission, deliberately kept:
 *
 *  - `memory` / `brain` — FOLLOW THE `memory` TOOL DOMAIN, derived below
 *    rather than restated, so the two axes cannot disagree again. `MemoryFact`
 *    is workspace-wide (no userId column), and the brain block is built from
 *    rows the corpus pass derived from Drive content (ADR-051).
 *  - `business` — the BusinessProfile block. FOLLOWS THE `business` TOOL
 *    DOMAIN (WARP-2990). Every field identifies the company; Romain ruled
 *    2026-09-22 that none of it goes to a cloud model.
 *  - `context_pins` — pinned file paths and resolved customer/deal names.
 *    Filenames are stored content (see the module header), so a pin is the
 *    `list_files` hole in prompt form.
 *
 * KEPT: identity, tool guidance and the interview conductor (static product
 * text), and the persona block (tone plus the owner's style instructions).
 */
export type OffLanPromptBlock = "memory" | "brain" | "business" | "context_pins";

const MEMORY_DOMAIN_WITHHELD = OFF_LAN_WITHHELD_DOMAINS.has("memory");

export const OFF_LAN_WITHHELD_PROMPT_BLOCKS: ReadonlySet<OffLanPromptBlock> =
  new Set<OffLanPromptBlock>([
    ...(MEMORY_DOMAIN_WITHHELD ? (["memory", "brain"] as const) : []),
    // WARP-2990 — now that the `business` TOOL domain is withheld too, the
    // profile block follows it rather than standing on its own default.
    ...(OFF_LAN_WITHHELD_DOMAINS.has("business") ? (["business"] as const) : []),
    "context_pins",
  ]);

/**
 * THE choke point for prompt content on an off-LAN turn. Pass every block the
 * caller is about to inject; get them back with each withheld one blanked,
 * plus the list of what was withheld, in the input's key order. That list is
 * what the route records on the turn's audit row: only NON-EMPTY blocks count,
 * so an audit line never claims a block was withheld when there was nothing to
 * withhold.
 *
 * A local turn is returned untouched.
 */
export function withholdPromptBlocksForOffLan<
  T extends Partial<Record<OffLanPromptBlock, string>>,
>(blocks: T, offLan: boolean): { blocks: T; withheld: OffLanPromptBlock[] } {
  if (!offLan) return { blocks, withheld: [] };
  const out = { ...blocks };
  const withheld: OffLanPromptBlock[] = [];
  for (const key of Object.keys(blocks) as OffLanPromptBlock[]) {
    if (!OFF_LAN_WITHHELD_PROMPT_BLOCKS.has(key)) continue;
    if (blocks[key]) withheld.push(key);
    (out as Record<OffLanPromptBlock, string>)[key] = "";
  }
  return { blocks: out, withheld };
}
