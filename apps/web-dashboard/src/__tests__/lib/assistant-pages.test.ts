import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardPagesSchema } from "@droplet/shared-types";

import { SETTINGS_PAGE_LINK_ROWS, assistantPages } from "@/lib/assistant-pages";

/**
 * WARP-3116 — the page list the assistant resolves against. Everything here
 * is a check that the assistant can only offer what the sidebar would, and
 * only ever a page that exists.
 */

const APP_DIR = join(__dirname, "..", "..", "app");
const ALL_CAPS = { claudeActivity: true, ragEval: true, medicalConnector: true };
const allOn = () => true;
const hrefs = (pages: { href: string }[]) => pages.map((p) => p.href);

describe("assistantPages", () => {
  it("offers only routes that exist — no dead links, no /settings/voice", () => {
    const pages = assistantPages("owner", ALL_CAPS, allOn);
    for (const { href } of pages) {
      const file = join(APP_DIR, href === "/" ? "" : href, "page.tsx");
      expect(existsSync(file), `${href} → ${file}`).toBe(true);
    }
    expect(hrefs(pages)).not.toContain("/settings/voice");
    expect(hrefs(pages)).toContain("/voice");
  });

  it("passes the wire schema the orchestrator validates against", () => {
    const parsed = dashboardPagesSchema.safeParse(assistantPages("owner", ALL_CAPS, allOn));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("includes tucked destinations under their Settings section", () => {
    const users = assistantPages("owner", ALL_CAPS, allOn).find((p) => p.href === "/users");
    expect(users).toMatchObject({ label: "Users", section: "Settings › Account" });
    expect(users?.keywords).toContain("people");
  });

  it("applies the role gates the sidebar applies", () => {
    const guest = hrefs(assistantPages("guest", ALL_CAPS, allOn));
    expect(guest).not.toContain("/workshop");
    expect(guest).not.toContain("/admin/audit");
    expect(guest).toContain("/chat");
  });

  it("drops a module that is off, and promotes a child that has its own", () => {
    // Network off, Voice on: Voice keeps its row (visibleItems promotion).
    const pages = assistantPages("owner", ALL_CAPS, (m) => m !== "network");
    expect(hrefs(pages)).not.toContain("/network");
    expect(hrefs(pages)).not.toContain("/remote-access");
    expect(hrefs(pages)).toContain("/voice");
  });

  it("applies capability gates", () => {
    const none = { claudeActivity: false, ragEval: false, medicalConnector: false };
    const pages = hrefs(assistantPages("owner", none, allOn));
    expect(pages).not.toContain("/practice");
    expect(pages).not.toContain("/admin/rag-eval");
  });

  it("lists each href once", () => {
    const list = hrefs(assistantPages("owner", ALL_CAPS, allOn));
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("SETTINGS_PAGE_LINK_ROWS", () => {
  it("mirrors link rows that are really on the Settings page", () => {
    const source = readFileSync(join(APP_DIR, "settings", "page.tsx"), "utf8");
    for (const { href } of SETTINGS_PAGE_LINK_ROWS) {
      expect(source, href).toContain(`href="${href}"`);
    }
  });
});
