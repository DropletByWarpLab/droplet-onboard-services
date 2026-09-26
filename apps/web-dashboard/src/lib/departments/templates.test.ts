/**
 * WARP-2976 (ADR-059 §2.6) — pins on the seven templates.
 *
 * A template seeds a profile, so a bad default ships to every department
 * that picks it. These hold the three rules `templates.ts` states:
 *   · every default href is a real NAV_GROUPS destination (top-level or a
 *     child — indexed the way `workspace-nav-config.ts` indexes them);
 *   · every default widget is in the widget registry, which only carries
 *     widgets with a real source;
 *   · every default icon is in the dashboard's icon allow-list.
 */
import { describe, expect, it } from "vitest";

import { NAV_GROUPS } from "@/components/nav-config";
import { DEPARTMENT_WIDGETS } from "@/components/Departments/department-widgets";
import type { DepartmentTemplate } from "@/lib/types";

import {
  DEPARTMENT_ICONS,
  DEPARTMENT_TEMPLATES,
  DEPARTMENT_WIDGET_IDS,
  departmentIcon,
  DEFAULT_DEPARTMENT_ICON,
  templateDefaults,
  templateFor,
} from "./templates";

/** href → true, over top-level items and their children. */
const NAV_INDEX: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const g of NAV_GROUPS)
    for (const item of g.items) {
      s.add(item.href);
      for (const child of item.children ?? []) s.add(child.href);
    }
  return s;
})();

const ALL: DepartmentTemplate[] = [
  "security",
  "sales",
  "finance",
  "operations",
  "front_desk",
  "it",
  "custom",
];

describe("department templates", () => {
  it("are exactly the seven ADR-059 templates, each once", () => {
    expect(DEPARTMENT_TEMPLATES.map((t) => t.id)).toEqual(ALL);
  });

  it.each(DEPARTMENT_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s — every default href exists in NAV_GROUPS",
    (_id, t) => {
      for (const href of t.navHrefs) {
        expect(NAV_INDEX.has(href), `${href} is not a NAV_GROUPS destination`).toBe(true);
      }
      expect(new Set(t.navHrefs).size).toBe(t.navHrefs.length);
    },
  );

  it.each(DEPARTMENT_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s — every default widget is in the registry, once",
    (_id, t) => {
      for (const w of t.homeWidgets) {
        expect(DEPARTMENT_WIDGETS[w.widget], `${w.widget} is not a registered widget`).toBeDefined();
        expect(["s", "m", "l"]).toContain(w.size);
      }
      const ids = t.homeWidgets.map((w) => w.widget);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it("every default icon is in the allow-list", () => {
    for (const t of DEPARTMENT_TEMPLATES) {
      expect(DEPARTMENT_ICONS[t.icon], `${t.id} icon ${t.icon}`).toBeDefined();
    }
  });

  it("the widget id list and the registry agree both ways", () => {
    expect(Object.keys(DEPARTMENT_WIDGETS).sort()).toEqual([...DEPARTMENT_WIDGET_IDS].sort());
  });

  it("pins the ADR-059 default destinations", () => {
    const nav = Object.fromEntries(DEPARTMENT_TEMPLATES.map((t) => [t.id, t.navHrefs]));
    expect(nav).toEqual({
      security: ["/security", "/cameras", "/events", "/network", "/devices", "/integrations"],
      sales: ["/customers", "/projects", "/email", "/calendar"],
      finance: ["/money", "/customers", "/files", "/reports"],
      operations: ["/projects", "/calendar", "/files", "/routines"],
      front_desk: ["/calendar", "/email", "/messages", "/customers"],
      it: ["/network", "/devices", "/integrations", "/users", "/health"],
      custom: [],
    });
  });

  it("names a headline figure for every template; custom's is the member count", () => {
    for (const t of DEPARTMENT_TEMPLATES) expect(t.headline).toBeTruthy();
    expect(templateFor("custom")?.headline).toBe("members");
    expect(templateFor("security")?.headline).toBe("cameras_online");
  });

  it("templateDefaults copies the lists, so an edit cannot mutate the template", () => {
    const t = templateFor("security")!;
    const d = templateDefaults(t);
    d.navHrefs.push("/chat");
    d.homeWidgets[0].size = "l";
    expect(t.navHrefs).not.toContain("/chat");
    expect(t.homeWidgets[0].size).toBe("m");
    expect(d.template).toBe("security");
    expect(d.icon).toBe(t.icon);
  });

  it("templateFor answers null for no template — it never guesses", () => {
    expect(templateFor(null)).toBeNull();
    expect(templateFor(undefined)).toBeNull();
  });

  it("an unknown icon name renders the fallback glyph", () => {
    expect(departmentIcon("not-an-icon")).toBe(DEFAULT_DEPARTMENT_ICON);
    expect(departmentIcon(null)).toBe(DEFAULT_DEPARTMENT_ICON);
  });
});
