/**
 * WARP-555 — tool domain → friendly label + icon.
 *
 * The orchestrator emits machine domain slugs (`smart-home`, `pm`, …).
 * ADR-002 (home-user persona) says the dashboard speaks plain language,
 * not installer jargon — so a domain renders as "Smart home", "Projects",
 * not "smart-home" / "pm". Unknown slugs fall back to a title-cased label
 * and a generic icon, so a freshly-added domain never breaks the page;
 * it just renders un-prettied until this map catches up.
 */

import {
  Bell,
  Calendar,
  Camera,
  FolderOpen,
  HardDrive,
  Heater,
  Mail,
  Brain,
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
  "smart-home": { label: "Smart home", icon: Heater },
  cameras: { label: "Cameras", icon: Camera },
  switch: { label: "Switch", icon: SwitchIcon },
  calendar: { label: "Calendar", icon: Calendar },
  reminders: { label: "Reminders", icon: Bell },
  notifications: { label: "Notifications", icon: Bell },
  email: { label: "Email", icon: Mail },
  memory: { label: "Memory", icon: Brain },
  pm: { label: "Projects", icon: ListChecks },
  system: { label: "System", icon: HardDrive },
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
