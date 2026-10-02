/**
 * WARP-2978 (ADR-059 P3 §8) — /security/incidents/[id] wiring: the route's
 * id reaches the view, and `?n=` (the alert notification the page was opened
 * from — set by the toaster and the service worker) reaches Acknowledge only
 * in the shape the box's strict body accepts. The page is a detail: no nav
 * entry, gated by the /security prefix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  search: "",
  id: "7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f" as unknown,
  seen: [] as Array<{ id: string; notificationId: string | null; backTab?: string }>,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: h.id }),
  useSearchParams: () => new URLSearchParams(h.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ children }: { children: ReactNode }) => <div className="droplet-shell">{children}</div>,
}));
vi.mock("@/components/security/IncidentView", async (orig) => ({
  ...(await orig<typeof import("@/components/security/IncidentView")>()),
  IncidentView: (p: { id: string; notificationId: string | null; backTab: string }) => {
    h.seen.push({ id: p.id, notificationId: p.notificationId, backTab: p.backTab });
    return null;
  },
}));

import IncidentPage from "@/app/security/incidents/[id]/page";
import { moduleForPath, NAV_GROUPS } from "@/components/nav-config";

beforeEach(() => {
  h.search = "";
  h.id = "7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f";
  h.seen = [];
});

describe("/security/incidents/[id]", () => {
  it("passes the route's id, and no notification without ?n=", () => {
    render(<IncidentPage />);
    expect(h.seen.at(-1)).toEqual({ id: "7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f", notificationId: null, backTab: "incidents" });
  });

  it("?from=everything sends the way back to the Everything tab; anything else is Incidents (WARP-3185 3)", () => {
    h.search = "from=everything";
    render(<IncidentPage />);
    expect(h.seen.at(-1)?.backTab).toBe("everything");
    for (const bad of ["incidents", "Everything", "everything2", "javascript:x", ""]) {
      h.search = `from=${encodeURIComponent(bad)}`;
      render(<IncidentPage />);
      expect(h.seen.at(-1)?.backTab, bad).toBe("incidents");
    }
  });

  it("?n=<notification id> reaches Acknowledge", () => {
    h.search = "n=clx9abc_01";
    render(<IncidentPage />);
    expect(h.seen.at(-1)?.notificationId).toBe("clx9abc_01");
  });

  it("an ?n= the box's strict body would refuse is dropped, never sent", () => {
    for (const bad of ["a b", "x".repeat(65), "../../etc", "<script>"]) {
      h.search = `n=${encodeURIComponent(bad)}`;
      render(<IncidentPage />);
      expect(h.seen.at(-1)?.notificationId, bad).toBeNull();
    }
  });

  it("is gated by the Security module, and has no nav entry of its own (it's a detail)", () => {
    expect(moduleForPath("/security/incidents/7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f")?.moduleId).toBe("security");
    const hrefs = NAV_GROUPS.flatMap((g) => g.items.flatMap((i) => [i.href, ...(i.children ?? []).map((c) => c.href)]));
    expect(hrefs.some((x) => x.startsWith("/security/incidents"))).toBe(false);
  });
});
