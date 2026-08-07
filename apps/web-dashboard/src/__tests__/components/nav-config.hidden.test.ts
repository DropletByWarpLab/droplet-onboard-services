/**
 * WARP-1807 — unit pins for the `hidden` nav-item flag.
 *
 * Knowledge + Context are tucked out of the primary nav: `visibleItems()`
 * must drop a `hidden: true` item on every surface, while `moduleForPath()`
 * must keep claiming the route — a tucked destination is still part of the
 * nav definition precisely so the WARP-1528 gap-(c) route gate cannot
 * regress. Render-level coverage (no <a href="/knowledge|/context"> on any
 * surface) lives in Sidebar.module-gating.test.tsx; these pins hold the two
 * predicates themselves.
 */
import { describe, it, expect } from "vitest";
import { BookOpen } from "lucide-react";
import {
  moduleForPath,
  visibleItems,
  type NavItem,
} from "@/components/nav-config";

const openCapabilities = { claudeActivity: true, ragEval: true };
const everyModuleOn = () => true;

describe("nav-config hidden flag (WARP-1807)", () => {
  it("visibleItems drops a hidden item even when role, capability and module would all allow it", () => {
    const items: NavItem[] = [
      { href: "/kept", label: "Kept", icon: BookOpen },
      {
        href: "/tucked",
        label: "Tucked",
        icon: BookOpen,
        hidden: true,
        // Deliberately permissive gates: hidden must win on its own, not
        // ride along on some other predicate saying no.
        roles: ["owner"],
        requiresModule: "knowledge",
      },
    ];
    const visible = visibleItems(items, "owner", openCapabilities, everyModuleOn);
    expect(visible.map((i) => i.href)).toEqual(["/kept"]);
  });

  it("visibleItems drops a hidden CHILD too — children run the same predicate", () => {
    const items: NavItem[] = [
      {
        href: "/parent",
        label: "Parent",
        icon: BookOpen,
        children: [
          { href: "/parent/shown", label: "Shown", icon: BookOpen },
          { href: "/parent/tucked", label: "Tucked", icon: BookOpen, hidden: true },
        ],
      },
    ];
    const visible = visibleItems(items, "owner", openCapabilities, everyModuleOn);
    expect(visible[0]?.children?.map((c) => c.href)).toEqual(["/parent/shown"]);
  });

  it("moduleForPath still claims /knowledge for the knowledge module (WARP-1528 gap-c gate must not regress)", () => {
    expect(moduleForPath("/knowledge")?.moduleId).toBe("knowledge");
  });
});
