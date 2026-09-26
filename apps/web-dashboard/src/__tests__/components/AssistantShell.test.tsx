/**
 * WARP-3062 — the assistant layout's shell: the switch on top, the side
 * taken from the URL, `/` forwarding to the conversation, and each tab
 * returning to the last place used on its side.
 *
 * The Sidebar is stubbed to a marker (it pulls in a wide provider tree and is
 * pinned by its own suites); what is under test is which side renders it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

const nav = {
  pathname: "/chat",
  search: "",
  replace: vi.fn(),
  push: vi.fn(),
};
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: nav.replace, push: nav.push, back: vi.fn() }),
}));

vi.mock("@/components/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar-shell" />,
}));

import { AssistantShell } from "@/components/assistant/AssistantShell";
import { SIDE_STORAGE_KEYS } from "@/lib/assistant-side";
import { collect, readSheet } from "../helpers/css-cascade";

function at(pathname: string, search = "") {
  nav.pathname = pathname;
  nav.search = search;
}

beforeEach(() => {
  sessionStorage.clear();
  nav.replace.mockClear();
  nav.push.mockClear();
  at("/chat");
});

describe("AssistantShell — the sides", () => {
  it("the Ask side is the page alone under the switch, with no sidebar", () => {
    render(<AssistantShell>chat page</AssistantShell>);
    expect(screen.queryByTestId("sidebar-shell")).toBeNull();
    expect(screen.getByRole("tab", { name: "Ask AI" })).toHaveAttribute("aria-selected", "true");
    const main = document.querySelector("main#main");
    expect(main).toHaveTextContent("chat page");
    expect(main?.className).not.toContain("--sidebar-w");
  });

  it("the business side is today's sidebar and page, under the same switch", () => {
    at("/calendar");
    render(<AssistantShell>calendar page</AssistantShell>);
    expect(screen.getByTestId("sidebar-shell")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    const main = document.querySelector("main#main");
    expect(main).toHaveTextContent("calendar page");
    expect(main?.className).toContain("lg:ml-[var(--sidebar-w)]");
  });

  it("marks the shell with its side so viewport-locked pages can subtract the bar", () => {
    at("/email");
    const { container } = render(<AssistantShell>email</AssistantShell>);
    const shell = container.querySelector(".droplet-assistant");
    expect(shell).toHaveAttribute("data-nav-layout", "assistant");
    expect(shell).toHaveAttribute("data-side", "business");
  });

  it("owns exactly one <main id=main>, whichever side", () => {
    render(<AssistantShell>p</AssistantShell>);
    expect(document.querySelectorAll("main#main")).toHaveLength(1);
  });
});

describe("AssistantShell — the front door", () => {
  it("forwards / to the conversation, keeping the query", () => {
    window.history.replaceState(null, "", "/?c=abc");
    at("/", "c=abc");
    render(<AssistantShell>home board</AssistantShell>);
    expect(nav.replace).toHaveBeenCalledWith("/chat?c=abc");
    window.history.replaceState(null, "", "/");
  });

  it("renders nothing of the page while it forwards — Home must not flash", () => {
    at("/");
    render(<AssistantShell>home board</AssistantShell>);
    expect(screen.queryByText("home board")).toBeNull();
    expect(screen.queryByTestId("sidebar-shell")).toBeNull();
    expect(screen.getByRole("tab", { name: "Ask AI" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("AssistantShell — returning to the last place on each side", () => {
  it("starts from each side's home", () => {
    render(<AssistantShell>p</AssistantShell>);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("href", "/overview");
  });

  it("Ask AI returns to the open conversation; Overview to the last business page", () => {
    at("/chat", "c=abc");
    const { rerender } = render(<AssistantShell>p</AssistantShell>);
    at("/customers/42", "tab=notes");
    rerender(<AssistantShell>p</AssistantShell>);
    expect(screen.getByRole("tab", { name: "Ask AI" })).toHaveAttribute("href", "/chat?c=abc");

    at("/chat", "c=abc");
    rerender(<AssistantShell>p</AssistantShell>);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "href",
      "/customers/42?tab=notes",
    );
  });

  it("remembers per tab across a remount (sessionStorage)", () => {
    at("/customers/42");
    const first = render(<AssistantShell>p</AssistantShell>);
    first.unmount();
    expect(sessionStorage.getItem(SIDE_STORAGE_KEYS.business)).toBe("/customers/42");

    at("/chat");
    render(<AssistantShell>p</AssistantShell>);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("href", "/customers/42");
  });

  it("ignores a stored place that is not a path on its side", () => {
    sessionStorage.setItem(SIDE_STORAGE_KEYS.business, "//evil.test/x");
    sessionStorage.setItem(SIDE_STORAGE_KEYS.ask, "/calendar");
    at("/settings");
    render(<AssistantShell>p</AssistantShell>);
    expect(screen.getByRole("tab", { name: "Ask AI" })).toHaveAttribute("href", "/chat");
  });

  it("does not remember the front door as a place", () => {
    at("/");
    render(<AssistantShell>p</AssistantShell>);
    expect(sessionStorage.getItem(SIDE_STORAGE_KEYS.ask)).toBeNull();
  });
});

/*
 * assistant-shell.css loads on every authenticated route in EVERY nav layout
 * (AuthGate imports AssistantShell) — the WARP-3063 lesson workspace-nav.css
 * learned. So every `.da-*` rule starts at the shell and is anchored to one of
 * its own regions, and the only rules that reach into pages are the listed
 * geometry overrides: the business side must render today's pages unchanged.
 */
describe("assistant-shell.css styles only the shell's own chrome", () => {
  const SHEET = collect(readSheet("components/assistant/assistant-shell.css"), "assistant-shell.css");
  const SELECTORS = [...new Set(SHEET.map((d) => d.selector.replace(/\s+/g, " ")))];
  const DA_CLASS = /\.da-[\w-]+/;
  const REGION = /^(?:\.dark )?\.droplet-assistant > \.da-(?:bar|main)(?![\w-])/;

  it("anchors every .da-* selector to the bar or the page column", () => {
    const da = SELECTORS.filter((s) => DA_CLASS.test(s));
    expect(da.length).toBeGreaterThan(10);
    expect(da.filter((s) => !REGION.test(s))).toEqual([]);
  });

  it("reaches into pages only for the sticky page top and the viewport-locked surfaces", () => {
    const reaches = SELECTORS.filter((s) => !DA_CLASS.test(s) && s !== ".droplet-assistant");
    expect(reaches.sort()).toEqual(
      [
        ".droplet-assistant .droplet-shell .page-top",
        '.droplet-assistant[data-side="ask"] .droplet-shell.chat-app',
        '.droplet-assistant[data-side="business"] .droplet-shell.chat-app',
        '.droplet-assistant[data-side="business"] .droplet-shell.email-app',
        ".droplet-assistant .droplet-home",
      ].sort(),
    );
  });

  it("inks the unselected side in --nav-link, which clears AA on the track (not --text-muted)", () => {
    const tabInk = SHEET.filter(
      (d) => d.selector.endsWith(".da-tab") && d.prop === "color" && d.conditions.length === 0,
    );
    expect(tabInk.map((d) => d.value)).toEqual(["var(--nav-link)"]);
  });

  it("in forced colours marks the selected side on the thumb, never with an outline that would mask focus", () => {
    const forced = SHEET.filter((d) => d.conditions.some((c) => c.includes("forced-colors")));
    expect(forced.some((d) => d.selector.endsWith(".da-thumb") && d.prop === "border")).toBe(true);
    expect(forced.filter((d) => /\.da-tab/.test(d.selector) && d.prop.startsWith("outline"))).toEqual([]);
  });

  it("names no colour of its own — the bar reads the indigo ramp", () => {
    const colours = SHEET.filter(
      (d) => /color|background|border|outline|fill/.test(d.prop) && /#[0-9a-f]{3,8}\b/i.test(d.value),
    );
    expect(colours).toEqual([]);
  });
});
