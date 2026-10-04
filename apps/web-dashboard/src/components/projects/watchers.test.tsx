// WatchControl (WARP-3519): the Watch toggle and the watchers' faces.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ToastProvider } from "@/components/Toast";
import { WatchControl } from "./watchers";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import type { PmWatcher } from "./types";

const h = vi.hoisted(() => ({
  calls: [] as { url: string; method: string }[],
  handler: null as null | ((url: string, init?: RequestInit) => Promise<unknown>),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    h.calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    return h.handler!(url, init);
  }),
}));

const ok = (body: unknown = {}) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
const fail = (status = 500) =>
  Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error: "boom" }) } as Response);

const NAMES: Record<string, string> = { u1: "Ada Lovelace", u2: "Bea Bell", u3: "Cy Young" };
const person = (id: string) => makePerson(id, NAMES[id] ?? `User ${id}`);

const watcher = (userId: string, reason: PmWatcher["reason"] = "MANUAL"): PmWatcher => ({
  userId,
  reason,
  createdAt: "2026-10-04T00:00:00.000Z",
});

let watchers: PmWatcher[] = [];

function serve() {
  h.handler = (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      watchers = [...watchers, watcher("u1")];
    } else if (method === "DELETE") {
      watchers = watchers.filter((w) => w.userId !== "u1");
    }
    return ok({ watchers });
  };
}

function renderControl(opts: { viewerId?: string; role?: string; assignees?: string[] } = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ToastProvider>
        <PeopleContext.Provider value={person}>
          <WatchControl
            itemId="w1"
            viewerId={opts.viewerId ?? "u1"}
            role={opts.role ?? "family"}
            assignees={opts.assignees ?? []}
          />
        </PeopleContext.Provider>
      </ToastProvider>
    </SWRConfig>,
  );
}

const reads = () => h.calls.filter((c) => c.method === "GET").length;
const writes = () => h.calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  h.calls.length = 0;
  watchers = [];
  serve();
});

describe("WatchControl", () => {
  it("offers Watch to somebody who is not watching, and flips it as soon as it is pressed", async () => {
    renderControl();
    const button = await screen.findByRole("button", { name: "Watch" });
    expect(button).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(button);

    // Optimistic: the label has already changed, before the POST has returned.
    expect(await screen.findByRole("button", { name: "Watching" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(writes()).toEqual([{ url: "/api/pm/work-items/w1/watchers", method: "POST" }]));
  });

  it("re-reads the list after the write, so the faces catch up", async () => {
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Watch" }));
    const before = reads();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(await screen.findByRole("group", { name: "Watchers: Ada Lovelace" })).toBeInTheDocument();
  });

  it("stops watching with a DELETE", async () => {
    watchers = [watcher("u1")];
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Watching" }));
    await waitFor(() => expect(writes()).toEqual([{ url: "/api/pm/work-items/w1/watchers", method: "DELETE" }]));
    expect(await screen.findByRole("button", { name: "Watch" })).toBeInTheDocument();
  });

  it("puts the toggle back, and says so, when the server refuses", async () => {
    h.handler = (_url, init) => ((init?.method ?? "GET") === "GET" ? ok({ watchers: [] }) : fail(500));
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Watch" }));

    expect(await screen.findByText("Couldn't update watching — try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Watch" })).toHaveAttribute("aria-pressed", "false");
  });

  it("cannot be pressed twice while a write is in flight", async () => {
    let finish: (v: unknown) => void = () => undefined;
    h.handler = (_url, init) =>
      (init?.method ?? "GET") === "GET" ? ok({ watchers: [] }) : new Promise((r) => (finish = r));
    renderControl();
    const button = await screen.findByRole("button", { name: "Watch" });
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "Watching" }));
    expect(writes()).toHaveLength(1);
    finish({ ok: true, status: 200, json: () => Promise.resolve({ watchers: [] }) });
    await waitFor(() => expect(screen.getByRole("button", { name: "Watch" })).toBeInTheDocument());
  });

  it("shows an assignee as watching, pressed and disabled, with the reason — they cannot opt out", async () => {
    watchers = [watcher("u1", "ASSIGNEE")];
    renderControl({ assignees: ["u1"] });
    const button = await screen.findByRole("button", { name: "Watching" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAttribute("title", "You're assigned to this item, so you always get updates.");
    fireEvent.click(button);
    expect(writes()).toHaveLength(0);
  });

  it("names the watchers on the group of faces", async () => {
    watchers = [watcher("u2"), watcher("u3")];
    renderControl();
    expect(await screen.findByRole("group", { name: "Watchers: Bea Bell, Cy Young" })).toBeInTheDocument();
  });

  it("shows a read-only role the faces and no toggle", async () => {
    watchers = [watcher("u2")];
    renderControl({ role: "guest" });
    expect(await screen.findByRole("group", { name: "Watchers: Bea Bell" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Watch/ })).toBeNull();
  });

  it("renders nothing at all for a read-only role when nobody is watching", async () => {
    const { container } = renderControl({ role: "guest" });
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    expect(container.querySelector(".pm-watch")).toBeNull();
  });
});
