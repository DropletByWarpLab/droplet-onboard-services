/**
 * WARP-3062 — the assistant layout's two sides are derived from the URL, and
 * a remembered place is only honoured if it is a same-origin path on the side
 * it was stored for.
 */
import { describe, it, expect } from "vitest";

import {
  ASK_HREF,
  SIDE_HOME,
  returnHrefFor,
  sideForPath,
} from "@/lib/assistant-side";
import {
  ASSISTANT_OVERVIEW_HREF,
  NAV_GROUPS,
  moduleForPath,
  withOverviewAt,
} from "@/components/nav-config";

describe("sideForPath", () => {
  it("puts the front door and every /chat route on the Ask side", () => {
    expect(sideForPath("/")).toBe("ask");
    expect(sideForPath("/chat")).toBe("ask");
    expect(sideForPath("/chat/anything")).toBe("ask");
  });

  it("puts everything else on the business side, Overview included", () => {
    expect(sideForPath(ASSISTANT_OVERVIEW_HREF)).toBe("business");
    expect(sideForPath("/calendar")).toBe("business");
    expect(sideForPath("/settings/appearance")).toBe("business");
  });

  it("matches /chat by segment, not by prefix", () => {
    expect(sideForPath("/chatter")).toBe("business");
  });
});

describe("returnHrefFor", () => {
  it("falls back to each side's home when nothing is stored", () => {
    expect(returnHrefFor("ask", null)).toBe(ASK_HREF);
    expect(returnHrefFor("business", null)).toBe(ASSISTANT_OVERVIEW_HREF);
    expect(SIDE_HOME).toEqual({ ask: "/chat", business: "/overview" });
  });

  it("returns to the open conversation and the last business page", () => {
    expect(returnHrefFor("ask", "/chat?c=abc")).toBe("/chat?c=abc");
    expect(returnHrefFor("business", "/customers/42?tab=notes")).toBe(
      "/customers/42?tab=notes",
    );
  });

  it("never follows a place stored for the other side", () => {
    expect(returnHrefFor("ask", "/calendar")).toBe(ASK_HREF);
    expect(returnHrefFor("business", "/chat?c=abc")).toBe(ASSISTANT_OVERVIEW_HREF);
  });

  it("does not treat the front door as a place to return to", () => {
    expect(returnHrefFor("ask", "/")).toBe(ASK_HREF);
    expect(returnHrefFor("ask", "/?c=abc")).toBe(ASK_HREF);
  });

  it("refuses anything that could leave the app", () => {
    for (const bad of ["https://evil.test/chat", "//evil.test/chat", "/\\evil.test", "javascript:alert(1)", "chat"]) {
      expect(returnHrefFor("ask", bad)).toBe(ASK_HREF);
      expect(returnHrefFor("business", bad)).toBe(ASSISTANT_OVERVIEW_HREF);
    }
  });
});

describe("withOverviewAt", () => {
  it("re-points the Overview entry and nothing else", () => {
    const moved = withOverviewAt(NAV_GROUPS, ASSISTANT_OVERVIEW_HREF);
    const before = NAV_GROUPS.flatMap((g) => g.items);
    const after = moved.flatMap((g) => g.items);
    expect(after).toHaveLength(before.length);
    after.forEach((item, i) => {
      if (before[i].href === "/") {
        expect(item.href).toBe(ASSISTANT_OVERVIEW_HREF);
        expect(item.label).toBe("Overview");
        expect(item.icon).toBe(before[i].icon);
      } else {
        expect(item).toBe(before[i]);
      }
    });
    expect(after.some((i) => i.href === "/")).toBe(false);
  });

  it("hands the same groups back when nothing moves", () => {
    expect(withOverviewAt(NAV_GROUPS, "/")).toBe(NAV_GROUPS);
  });
});

describe("moduleForPath", () => {
  it("treats /overview as always on, like /", () => {
    expect(moduleForPath(ASSISTANT_OVERVIEW_HREF)).toBeNull();
  });
});
