/**
 * WARP-3116 — the dashboard pages the assistant may point this viewer at, or
 * take them to.
 *
 * Sent with every chat turn as `dashboardPages`; the orchestrator forwards it
 * to find_dashboard_page / open_dashboard_page. DERIVED from nav-config with
 * the same predicates the sidebar and the Settings panel render from, so the
 * assistant can only ever offer a page this person could already click to —
 * and never a path nav-config does not know, which is how `/settings/voice`
 * (a page that has never existed) reached a chat answer.
 */
import type { DashboardPage } from "@droplet/shared-types";

import {
  NAV_GROUPS,
  settingsGroups,
  visibleItems,
  type AuthRole,
  type NavCapabilities,
  type NavItem,
} from "@/components/nav-config";

/**
 * The Settings page's hand-written link rows that nav-config does not carry
 * (Voice is the third, and IS in nav-config). Ungated on the Settings page,
 * so ungated here. `assistant-pages.test.ts` pins each href to a Link on
 * that page, so a row that moves takes this entry with it.
 */
export const SETTINGS_PAGE_LINK_ROWS: readonly DashboardPage[] = [
  {
    href: "/settings/updates",
    label: "Software updates",
    section: "Settings",
    description: "Current release, pending updates, and the apply window",
    keywords: ["update", "upgrade", "version", "release"],
  },
  {
    href: "/settings/storage",
    label: "Storage",
    section: "Settings",
    description: "Storage pools, drives, and the system disk",
    keywords: ["disks", "drives", "pools"],
  },
];

function toPage(item: NavItem, section: string): DashboardPage {
  return {
    href: item.href,
    label: item.label,
    section,
    ...(item.settingsBlurb ? { description: item.settingsBlurb } : {}),
    ...(item.keywords?.length ? { keywords: item.keywords } : {}),
  };
}

export function assistantPages(
  role: AuthRole | undefined,
  capabilities: NavCapabilities,
  isModuleOn: (moduleId: string) => boolean,
): DashboardPage[] {
  const pages: DashboardPage[] = [];
  // What the sidebar shows — including a child promoted into its parent's
  // slot when only the parent's module is off (`visibleItems`).
  for (const group of NAV_GROUPS) {
    for (const item of visibleItems(group.items, role, capabilities, isModuleOn)) {
      pages.push(toPage(item, group.label));
      for (const child of item.children ?? []) {
        pages.push(toPage(child, `${group.label} › ${item.label}`));
      }
    }
  }
  // What the Settings panel and page show: the tucked destinations.
  for (const section of settingsGroups(role, capabilities, isModuleOn)) {
    for (const item of section.items) {
      pages.push(toPage(item, `Settings › ${section.label}`));
    }
  }
  pages.push(...SETTINGS_PAGE_LINK_ROWS);

  const seen = new Set<string>();
  return pages.filter((p) => (seen.has(p.href) ? false : (seen.add(p.href), true)));
}
