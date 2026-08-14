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
  FolderOpen,
  HardDrive,
  Heater,
  Mail,
  Brain,
  MessagesSquare,
  Network,
  ListChecks,
  Network as SwitchIcon,
  Wrench,
  type LucideIcon,
} from "lucide-react";

interface DomainMeta {
  label: string;
  icon: LucideIcon;
}

const DOMAIN_META: Record<string, DomainMeta> = {
  network: { label: "Network", icon: Network },
  files: { label: "Files", icon: FolderOpen },
  "smart-home": { label: "Smart devices", icon: Heater },
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
