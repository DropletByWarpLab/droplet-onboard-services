/**
 * WARP-2976 (ADR-059 §2.6) — the seven department templates, as DATA.
 *
 * A template is three defaults and nothing else: which nav destinations the
 * department shows, which widgets its home starts with, and which one figure
 * the Business overview (`/d`) puts on its tile. The owner edits both lists
 * afterwards; picking a template only seeds them.
 *
 * Three rules this file holds, each pinned by `templates.test.ts`:
 *
 *   1. Every default href is a real `NAV_GROUPS` destination (a top-level item
 *      or one of its children). A template must never seed a link to a route
 *      the dashboard does not have — the department nav would silently drop it
 *      (it renders only the intersection), and the owner would be left
 *      wondering where it went.
 *   2. Every default widget id is in the widget registry
 *      (`components/Departments/department-widgets.tsx`). The registry only
 *      carries widgets with a real source, so a template cannot seed a mock.
 *   3. A template is never inferred from a department's NAME. Nothing here
 *      takes a name; `/d/<slug>` shows a picker when there is no profile.
 *
 * What a template does NOT do: grant anything. Seeding `/cameras` into a
 * Security profile does not let a member see a camera — the nav still runs
 * every existing gate after the profile filter (ADR-059 §2.5).
 */
import type { LucideIcon } from "lucide-react";
import {
  Briefcase,
  Building2,
  Calculator,
  ConciergeBell,
  FolderKanban,
  Hammer,
  Headset,
  Landmark,
  Megaphone,
  Receipt,
  ServerCog,
  ShieldCheck,
  Stethoscope,
  Store,
  Truck,
  Users,
  Warehouse,
  Wrench,
} from "lucide-react";

import type {
  DepartmentHomeWidget,
  DepartmentTemplate,
} from "@/lib/types";

/** The widget ids the registry implements. Kept here (pure data) so the
 *  templates can be typed against it without importing React components; the
 *  registry is typed `Record<DepartmentWidgetId, …>`, so a missing entry is a
 *  compile error there and the test pins the runtime object too. */
export const DEPARTMENT_WIDGET_IDS = [
  "quick-links",
  "members",
  "work",
  "cameras",
  "files",
] as const;
export type DepartmentWidgetId = (typeof DEPARTMENT_WIDGET_IDS)[number];

export function isDepartmentWidgetId(id: string): id is DepartmentWidgetId {
  return (DEPARTMENT_WIDGET_IDS as readonly string[]).includes(id);
}

/**
 * The one figure a template puts on its Business overview tile. Each names an
 * EXISTING source (see `components/Departments/HeadlineFigure.tsx`); `members`
 * is the honest fallback where no source exists yet — never a zero.
 */
export type HeadlineFigureId =
  | "cameras_online"
  | "open_deals"
  | "overdue_invoices"
  | "open_work"
  | "todays_appointments"
  | "services_unhealthy"
  | "members";

export interface DepartmentTemplateDef {
  id: DepartmentTemplate;
  label: string;
  /** One line, shown on the template picker card. Sentence case, no "!". */
  description: string;
  /** Lucide icon name (kebab-case) — the profile's default `icon`. */
  icon: string;
  navHrefs: readonly string[];
  homeWidgets: readonly (DepartmentHomeWidget & { widget: DepartmentWidgetId })[];
  headline: HeadlineFigureId;
}

export const DEPARTMENT_TEMPLATES: readonly DepartmentTemplateDef[] = [
  {
    id: "security",
    label: "Security",
    description: "The Security feed, cameras and their events, the network and the devices on it.",
    icon: "shield-check",
    // WARP-2977 — /security (the command center: the feed, the site mode, and
    // its Areas and Opening hours children) leads, as it does in the sidebar.
    navHrefs: ["/security", "/cameras", "/events", "/network", "/devices", "/integrations"],
    homeWidgets: [
      { widget: "cameras", size: "m" },
      { widget: "quick-links", size: "m" },
      { widget: "members", size: "s" },
      { widget: "files", size: "s" },
    ],
    // ADR-059 §2.4 wants detections in the last 24 h. P2a's SecurityEvent
    // store now holds them, but no headline figure reads it yet; until one
    // does, the tile shows the camera fleet: how many cameras are online.
    headline: "cameras_online",
  },
  {
    id: "sales",
    label: "Sales",
    description: "Customers, deals, and the email and calendar that move them.",
    icon: "briefcase",
    navHrefs: ["/customers", "/projects", "/email", "/calendar"],
    homeWidgets: [
      { widget: "quick-links", size: "m" },
      { widget: "work", size: "m" },
      { widget: "members", size: "s" },
      { widget: "files", size: "s" },
    ],
    headline: "open_deals",
  },
  {
    id: "finance",
    label: "Finance",
    description: "What the business is owed and owes, with the files behind it.",
    icon: "receipt",
    navHrefs: ["/money", "/customers", "/files", "/reports"],
    homeWidgets: [
      { widget: "quick-links", size: "m" },
      { widget: "files", size: "m" },
      { widget: "members", size: "s" },
    ],
    headline: "overdue_invoices",
  },
  {
    id: "operations",
    label: "Operations",
    description: "The work in flight, the schedule, and the routines that run it.",
    icon: "folder-kanban",
    navHrefs: ["/projects", "/calendar", "/files", "/routines"],
    homeWidgets: [
      { widget: "work", size: "l" },
      { widget: "quick-links", size: "m" },
      { widget: "members", size: "s" },
      { widget: "files", size: "s" },
    ],
    headline: "open_work",
  },
  {
    id: "front_desk",
    label: "Front desk",
    description: "Today's calendar, the inbox, messages and the customer list.",
    icon: "concierge-bell",
    navHrefs: ["/calendar", "/email", "/messages", "/customers"],
    homeWidgets: [
      { widget: "quick-links", size: "m" },
      { widget: "members", size: "s" },
      { widget: "files", size: "s" },
    ],
    headline: "todays_appointments",
  },
  {
    id: "it",
    label: "IT",
    description: "The network, devices, connections, people and the box's health.",
    icon: "server-cog",
    navHrefs: ["/network", "/devices", "/integrations", "/users", "/health"],
    homeWidgets: [
      { widget: "quick-links", size: "m" },
      { widget: "members", size: "s" },
      { widget: "files", size: "s" },
    ],
    headline: "services_unhealthy",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Start empty and pick the pages and widgets yourself.",
    icon: "building-2",
    navHrefs: [],
    homeWidgets: [
      { widget: "members", size: "m" },
      { widget: "files", size: "m" },
    ],
    headline: "members",
  },
];

const BY_ID = new Map(DEPARTMENT_TEMPLATES.map((t) => [t.id, t]));

export function templateFor(id: DepartmentTemplate | undefined | null): DepartmentTemplateDef | null {
  return (id && BY_ID.get(id)) || null;
}

/**
 * The icons a department may carry. The server validates the icon's SHAPE
 * only; this map is the dashboard's allow-list, and an unknown name renders
 * the generic building glyph rather than nothing.
 */
export const DEPARTMENT_ICONS: Readonly<Record<string, LucideIcon>> = {
  "shield-check": ShieldCheck,
  briefcase: Briefcase,
  receipt: Receipt,
  "folder-kanban": FolderKanban,
  "concierge-bell": ConciergeBell,
  "server-cog": ServerCog,
  "building-2": Building2,
  users: Users,
  calculator: Calculator,
  headset: Headset,
  megaphone: Megaphone,
  store: Store,
  truck: Truck,
  warehouse: Warehouse,
  wrench: Wrench,
  hammer: Hammer,
  stethoscope: Stethoscope,
  landmark: Landmark,
};

export const DEFAULT_DEPARTMENT_ICON: LucideIcon = Building2;

export function departmentIcon(name: string | null | undefined): LucideIcon {
  return (name && DEPARTMENT_ICONS[name]) || DEFAULT_DEPARTMENT_ICON;
}

/** The PUT body a template seeds — its defaults, copied (never shared arrays). */
export function templateDefaults(t: DepartmentTemplateDef) {
  return {
    template: t.id,
    icon: t.icon,
    navHrefs: [...t.navHrefs],
    homeWidgets: t.homeWidgets.map((w) => ({ widget: w.widget, size: w.size })),
  };
}
