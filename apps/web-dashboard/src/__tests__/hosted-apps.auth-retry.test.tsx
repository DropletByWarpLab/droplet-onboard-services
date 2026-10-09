import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

const principal = vi.hoisted(() => ({ id: "owner-1" }));
// Keep the production authFetch refresh/retry path; only the rendered profile
// is replaceable, so a mock request wrapper cannot hide a stale replay.
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<typeof import("@/lib/auth")>()),
  useAuth: () => ({ user: { id: principal.id, role: "owner" }, isLoading: false }),
}));
import { AppGrantDialog } from "@/components/hosted/AppGrantDialog";
import { AppUninstallDialog } from "@/components/hosted/AppUninstallDialog";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => { principal.id = "owner-1"; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Hosted owner mutations during authentication refresh", () => {
  it.each(["grants", "uninstall", "delete-data"])("does not replay %s under a replacement account", async (action) => {
    let finishRefresh!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => { finishRefresh = resolve; });
    const sentBy: string[] = [];
    const fetch = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      // A cancelled retry never reaches the server, including when the initial
      // 401 has already arrived and the shared refresh is still in flight.
      if (init?.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
      if (url === "/api/auth/refresh") return refresh;
      if (init?.method === "PUT" || init?.method === "DELETE") {
        sentBy.push(principal.id);
        return Promise.resolve(json({ roles: [], id: "daily", status: "uninstalled" }, sentBy.length === 1 ? 401 : 200));
      }
      return Promise.resolve(json({ roles: [] }));
    });
    vi.stubGlobal("fetch", fetch);
    const finished = vi.fn(async () => undefined);
    const close = vi.fn();
    const provider = () => new Map();
    const element = () => <SWRConfig value={{ provider, dedupingInterval: 0 }}>
      {action === "grants"
        ? <AppGrantDialog slug="daily" onSaved={finished} onClose={close} triggerRef={{ current: null }} />
        : <AppUninstallDialog slug="daily" dataOnly={action === "delete-data"} onDone={finished} onClose={close} triggerRef={{ current: null }} />}
    </SWRConfig>;
    const view = render(element());
    if (action === "grants") await screen.findByLabelText("Allow members to open this app");
    if (action === "delete-data") fireEvent.change(screen.getByLabelText("Type daily to delete its data"), { target: { value: "daily" } });
    fireEvent.click(screen.getByRole("button", { name: action === "grants" ? "Save access" : action === "uninstall" ? "Confirm uninstall" : "Delete saved data" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === "/api/auth/refresh")).toBe(true));
    principal.id = "owner-2";
    view.rerender(element());
    await act(async () => { finishRefresh(json({ ok: true })); });
    expect(sentBy).toEqual(["owner-1"]);
    expect(finished).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
