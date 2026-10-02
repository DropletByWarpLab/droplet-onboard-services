/**
 * WARP-555 — tool domain → friendly label + icon.
 *
 * The orchestrator emits machine domain slugs (`smart-home`, `pm`, …).
 * ADR-002 (home-user persona) says the dashboard speaks plain language,
 * not installer jargon — so a domain renders as "Smart devices", "Projects",
 * not "smart-home" / "pm". Unknown slugs fall back to a title-cased label
 * and a generic icon, so a freshly-added domain never breaks the page;
 * it just renders un-prettied until this map catches up.
 */

import {
  Bell,
  Braces,
  Building2,
  Calendar,
  Camera,
  Cloud,
  Contact,
  FolderOpen,
  HardDrive,
  Heater,
  Mail,
  Brain,
  MessagesSquare,
  Network,
  ListChecks,
  Network as SwitchIcon,
  PlayCircle,
  Receipt,
  Stethoscope,
  Wrench,
  type LucideIcon,
  Repeat,
  Hammer,
} from "lucide-react";

import type { ToolCatalogEntry } from "./types";

interface DomainMeta {
  label: string;
  icon: LucideIcon;
}

/**
 * WARP-2969 — exported so `tool-domains.test.ts` can pin it against
 * tools-core's `TOOL_DOMAINS`. It covered 16 of 21 domains for months and
 * nothing said so: the fallback below is silent by design, so `crm` rendered
 * as a wrench labelled "Crm" and looked like a styling bug rather than a
 * missing entry. The drift test is the only thing that can notice.
 */
export const DOMAIN_META: Record<string, DomainMeta> = {
  network: { label: "Network", icon: Network },
  files: { label: "Files", icon: FolderOpen },
  "smart-home": { label: "Device control", icon: Heater },
  cameras: { label: "Cameras", icon: Camera },
  switch: { label: "Switch", icon: SwitchIcon },
  calendar: { label: "Calendar", icon: Calendar },
  reminders: { label: "Reminders", icon: Bell },
  notifications: { label: "Notifications", icon: Bell },
  email: { label: "Email", icon: Mail },
  memory: { label: "Memory", icon: Brain },
  pm: { label: "Projects", icon: ListChecks },
  business: { label: "Business", icon: Building2 },
  system: { label: "System", icon: HardDrive },
  // WARP-899/WARP-900 — data-utility tools (encode/decode, hash, format conversion);
  // WARP-901 — misc dev utilities (timestamp/UUID/regex). Both live in the data domain.
  data: { label: "Data", icon: Braces },
  // WARP-1685 — Messages send tools (team chat). Slug matches the
  // team_chat ModuleId / tools-core domain.
  team_chat: { label: "Messages", icon: MessagesSquare },
  // WARP-2894 (ADR-056) — the routine tools. Label matches the /routines
  // nav entry so the /tools filter chip and the sidebar say the same word.
  routines: { label: "Routines", icon: Repeat },
  // ── WARP-2969: the five domains this map never covered ──
  // WARP-2180 — durable background runs; "Background runs" is the word the
  // Workshop surface (WARP-2925) uses for them.
  agent_runs: { label: "Background runs", icon: PlayCircle },
  // WARP-2497 — cloud_query_dataset, the one door to a remote dataset.
  cloud: { label: "Cloud data", icon: Cloud },
  // ADR-045 left `crm` and `pm` declared but empty — they are the landing
  // slots for a remote catalog, so they can appear the day one registers.
  crm: { label: "Contacts", icon: Contact },
  erp: { label: "Practice", icon: Stethoscope },
  // WARP-2581 — money_list_open_documents (invoices and bills).
  money: { label: "Invoices", icon: Receipt },
  // WARP-2896 (ADR-056) — the workshop's workspace tools. Label matches the
  // /workshop nav entry for the same reason.
  workspace: { label: "Workshop", icon: Hammer },
};

/** Title-case a slug as a last resort: `smart-home` → `Smart home`. */
function titleCase(slug: string): string {
  const spaced = slug.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function labelForDomain(domain: string): string {
  return DOMAIN_META[domain]?.label ?? titleCase(domain);
}

export function iconForDomain(domain: string): LucideIcon {
  return DOMAIN_META[domain]?.icon ?? Wrench;
}

/* ───────────────────────── WARP-2969: reach ───────────────────────── */

/**
 * `true` ⇔ asking the assistant for this tool would actually reach it.
 *
 * ONE definition, read by the `/chat` slash menu (which filters on it) and by
 * the `/tools` card (which explains it, and drops its chat hand-off). A tool
 * with no `reach` — an orchestrator from before the field shipped — counts as
 * reachable: absence of evidence is not "withheld", and answering otherwise
 * would empty the slash menu on the one box that cannot tell us better.
 */
export function reachableInChat(tool: ToolCatalogEntry): boolean {
  return tool.reach ? tool.reach.chat === "allowed" : true;
}

/**
 * The muted chip `/tools` puts on a tool a chat turn cannot reach, or null.
 *
 * "Dashboard & MCP only", not "Unavailable": the tool works, it is just not
 * reachable by asking. Saying otherwise would send someone looking for a
 * broken box.
 */
export function reachNote(tool: ToolCatalogEntry): string | null {
  return reachableInChat(tool) ? null : "Dashboard & MCP only";
}
