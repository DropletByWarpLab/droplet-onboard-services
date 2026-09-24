/**
 * WARP-3043 — the Workshop keeps its Mac chrome when its overrides go.
 *
 * WARP-2974 gave the Workshop the Mac app's chrome (DropletAgent spec §5) by
 * overriding chat-indigo.css under `.droplet-shell.workshop-app` (workshop.css).
 * WARP-3043 moves that chrome into chat-indigo.css itself, so /chat has it too,
 * and deletes the overrides. The risk is the Workshop drifting silently: a
 * value moved with a typo, a rule that now loses on specificity, a phone rule
 * that suddenly wins. This pins what the Workshop RESOLVES to — the authored
 * cascade of every sheet the route loads, run against the DOM WorkshopSpace
 * actually renders — so the move is proved by the same numbers before and
 * after.
 *
 * `STAGE` is the Workshop as it resolved on origin/stage before the move.
 * `INTENDED_DELTAS` is every value that is SUPPOSED to change, stated one by
 * one; anything else that moves is a regression. Only the base layer resolves
 * here (the helper excludes @media), so the phone/landscape changes are stated
 * in the PR instead.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  collectSheets,
  readSheet,
  resolve,
  rank,
  type Decl,
} from "./helpers/css-cascade";

const authFetchMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", role: "owner" }, isLoading: false }),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("workspace=ws-a"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/workshop",
}));

import { WorkshopSpace } from "@/components/workshop/WorkshopSpace";

/** Every sheet /workshop loads, in import order (see css-cascade.ts). */
const WORKSHOP_SHEETS = [
  "app/globals.css",
  "components/shell/indigo-tokens.css",
  "components/shell/droplet-shell.css",
  "components/chat/chat-indigo.css",
  "components/workshop/workshop.css",
];

const WS = {
  id: "ws-a",
  name: "Word counter",
  template: "python-tool",
  status: "active",
  proposedTag: null,
  proposedAt: null,
  createdAt: "2026-09-20T09:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  userId: "u1",
  lastRun: null,
};

function okJson(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

/** The Workshop as it resolved on origin/stage (c72b1c763), before the move. */
const STAGE: Record<string, string> = {
  "conv-rail border-right": "0",
  "conv-rail background": "var(--glass-2)",
  "conv-head border-bottom": "0",
  "chat-head background": "transparent",
  "chat-head border-bottom": "0",
  "conv-item border-left": "0",
  "composer border": "0",
  "composer border-radius": "26px",
  "composer padding": "8px",
  "composer background": "var(--surface)",
  "composer flex-direction": "row",
  "composer flex-wrap": "wrap",
  "textarea min-height": "36px",
  "textarea flex": "1 1 240px",
  "send width": "36px",
  "send height": "36px",
  "send border-radius": "999px",
  "empty-heading font-size": "26px",
  "empty-scroll margin-top": "auto",
  "empty-scroll flex": "0 0 auto",
  "btn background": "transparent",
  "head-workspace border": "1px solid var(--border)",
};

/**
 * Every value that is meant to change, and to what. Each one is a decision,
 * listed so review sees it; a value missing from here that moves is a bug.
 */
const INTENDED_DELTAS: Record<string, string> = {};

/** What a property is when nothing authored sets it (after Tailwind's preflight). */
function initialValue(prop: string): string {
  if (prop.startsWith("border") && !prop.includes("radius")) return "0";
  if (prop === "background") return "transparent";
  return "";
}

/** `8px 8px 8px 8px` → `8px`; a zero-width border in any spelling → `0`. */
function normalize(prop: string, value: string): string {
  const v = value.trim().replace(/\s+/g, " ");
  if (prop.startsWith("border") && !prop.includes("radius")) {
    if (/^(0|none)(\s|$)/.test(v) || /^0(px)?\s/.test(v)) return "0";
  }
  const parts = v.split(" ");
  if (parts.length > 1 && parts.every((p) => p === parts[0])) return parts[0];
  return v;
}

/**
 * The longhand a shorthand also sets, so `border: 0` and `border-right: 1px`
 * are ranked against each other the way a browser ranks them.
 */
function propFamily(prop: string): string[] {
  const side = /^border-(top|right|bottom|left)$/.exec(prop);
  if (side) return ["border", "border-width", prop, `${prop}-width`];
  if (prop === "border") return ["border", "border-width"];
  if (prop === "background") return ["background", "background-color"];
  if (prop === "flex") return ["flex"];
  return [prop];
}

function resolved(el: Element, decls: Decl[], prop: string): string {
  let best: Decl | undefined;
  for (const p of propFamily(prop)) {
    const r = resolve(el, decls, p);
    expect(
      r.contested.map((d) => `${d.sheet} \`${d.selector}\` (${d.value})`),
      `${prop}: a cross-sheet tie leaves the Workshop to CSS chunk order`,
    ).toEqual([]);
    if (!r.winner) continue;
    if (!best || rank(r.winner) > rank(best) || (rank(r.winner) === rank(best) && r.winner.order > best.order)) {
      best = r.winner;
    }
  }
  return normalize(prop, best ? best.value : initialValue(prop));
}

describe("Workshop chrome parity across the WARP-3043 move", () => {
  let decls: Decl[];
  beforeAll(() => {
    decls = collectSheets(WORKSHOP_SHEETS.map((rel) => ({ css: readSheet(rel), name: rel })));
  });
  afterEach(() => cleanup());

  it("every intended delta is a real change to a pinned value", () => {
    for (const [key, to] of Object.entries(INTENDED_DELTAS)) {
      expect(STAGE, `delta "${key}" names no pinned value`).toHaveProperty([key]);
      expect(to, `delta "${key}" is a no-op`).not.toBe(STAGE[key]);
    }
  });

  it("resolves the Workshop's chrome to the stage values plus the stated deltas", async () => {
    authFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/agent-runs/schedules")) return okJson({ schedules: [] });
      if (url.startsWith("/api/agent-runs")) return okJson({ items: [], nextCursor: null });
      if (url === "/api/workspace") return okJson({ workspaces: [WS] });
      return okJson({ error: "not found" }, 404);
    });
    const { container } = render(<WorkshopSpace />);
    const headWorkspace = await screen.findByTestId("head-workspace");

    const root = container.firstElementChild!;
    const q = (sel: string) => {
      const el = container.querySelector(sel);
      expect(el, `${sel} not rendered`).not.toBeNull();
      return el!;
    };
    // A secondary `.btn` as the Workshop's panes render it: a direct probe in
    // the real root, so the ancestor chain is the Workshop's own.
    const btn = document.createElement("button");
    btn.className = "btn";
    root.appendChild(btn);

    const targets: Record<string, Element> = {
      "conv-rail": q(".conv-rail"),
      "conv-head": q(".conv-rail .conv-head"),
      "chat-head": q(".chat-head"),
      "conv-item": q(".conv-rail .conv-item"),
      composer: q(".chat-composer-inner"),
      textarea: q(".chat-composer-inner textarea"),
      send: q(".chat-composer-inner .chat-send"),
      "empty-heading": q(".chat-main.is-empty .chat-empty .h"),
      "empty-scroll": q(".chat-main.is-empty .chat-scroll"),
      btn,
      "head-workspace": headWorkspace,
    };

    const actual: Record<string, string> = {};
    for (const key of Object.keys(STAGE)) {
      const [target, prop] = key.split(" ");
      actual[key] = resolved(targets[target], decls, prop);
    }
    const expected = Object.fromEntries(
      Object.keys(STAGE).map((k) => [k, INTENDED_DELTAS[k] ?? STAGE[k]]),
    );
    expect(actual).toEqual(expected);
  });
});
