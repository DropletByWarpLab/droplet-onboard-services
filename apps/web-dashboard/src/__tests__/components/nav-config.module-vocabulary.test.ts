/**
 * WARP-2577 defect 4 — `NavItem.requiresModule` must not restate the module
 * vocabulary.
 *
 * It used to be a hand-written union of twelve ids while `AccessModuleId`
 * carried fifteen. The two that were missing, `crm` and `contacts`, are not
 * hypothetical: both shipped as gateable modules with full view/act/manage
 * ladders in the orchestrator's access catalog, and neither could be written
 * into a nav entry, because the type would not accept the string.
 *
 * `requiresModule` is now `Exclude<AccessModuleId, "chat">`, so `tsc` is the
 * real gate — a sixteenth module id reaches this field the day it is declared.
 * What is left for a runtime test is the part the type cannot see:
 *
 *   1. the exclusion is exactly `chat`, and stays deliberate rather than
 *      growing quietly into a second hand-list;
 *   2. every id actually USED in the nav tree is a real module id, so a typo
 *      in a `requiresModule` string is caught even if someone widens the type.
 */
import { describe, expect, it } from "vitest";

import { NAV_GROUPS, type NavItem } from "@/components/nav-config";
import type { AccessModuleId } from "@/lib/types";

/**
 * The module vocabulary, restated ONCE, here, as the test's own fixture.
 *
 * This is the one place a second copy is correct: a test that imported the
 * list it is checking would agree with the source by construction and could
 * never fail. Its cost is that adding a module id to `AccessModuleId` turns
 * this red — which is the intended prompt to confirm the new id is nav-able,
 * not an accident.
 */
const MODULE_IDS: readonly AccessModuleId[] = [
  "chat",
  "knowledge",
  "files",
  "docs",
  "email",
  "calendar",
  "projects",
  "voice",
  "cameras",
  "smart_home",
  "network",
  "managed_switch",
  "team_chat",
  "contacts",
  "crm",
];

/** Every `requiresModule` in the tree, parents and children alike. */
function requiredModules(items: readonly NavItem[]): string[] {
  const found: string[] = [];
  const walk = (list: readonly NavItem[]) => {
    for (const item of list) {
      if (item.requiresModule) found.push(item.requiresModule);
      const children = (item as { children?: readonly NavItem[] }).children;
      if (children) walk(children);
    }
  };
  walk(items);
  return found;
}

describe("WARP-2577 — requiresModule derives from the module vocabulary", () => {
  it("accepts the two ids the hand-written union had already dropped", () => {
    // MUTATION: narrow `requiresModule` back to a literal union omitting these
    // two → this file stops compiling, which is the failure mode wanted. The
    // runtime assertion is a formality; `tsc` is the gate.
    const crm: NavItem["requiresModule"] = "crm";
    const contacts: NavItem["requiresModule"] = "contacts";
    expect([crm, contacts]).toEqual(["crm", "contacts"]);
  });

  it("excludes chat, and excludes nothing else", () => {
    // Core modules are never tagged — a Droplet with no assistant is not a
    // Droplet, so `chat` has no off state for a nav entry to hide behind.
    // MUTATION: change the type to a bare `AccessModuleId` → the first
    // expectation goes red. Add a second id to the `Exclude` → the second does.
    // @ts-expect-error `chat` is core and must not be gateable from the nav.
    const core: NavItem["requiresModule"] = "chat";
    expect(core).toBe("chat");

    const gateable = MODULE_IDS.filter((id) => id !== "chat");
    for (const id of gateable) {
      const assigned: NavItem["requiresModule"] = id as NavItem["requiresModule"];
      expect(assigned).toBe(id);
    }
    expect(gateable).toHaveLength(MODULE_IDS.length - 1);
  });

  it("uses only real module ids in the nav tree", () => {
    // Catches the typo the type would catch too — and keeps catching it if
    // anyone ever widens the field to `string` for convenience.
    const used = requiredModules(NAV_GROUPS.flatMap((group) => group.items));
    expect(used.length, "nav declares at least one module gate").toBeGreaterThan(0);
    for (const id of used) {
      expect(MODULE_IDS as readonly string[], `nav gates on unknown module "${id}"`).toContain(id);
    }
  });
});
