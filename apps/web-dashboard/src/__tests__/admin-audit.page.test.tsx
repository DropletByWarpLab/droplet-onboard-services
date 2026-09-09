/**
 * WARP-246 — /admin/audit page: signed activity timeline + chain badge.
 *
 * Contract under test:
 *   1. the page is admin/owner-gated client-side (family sees the same
 *      ShieldOff explainer the other admin pages use);
 *   2. on render it fetches GET /api/activity AND GET /api/activity/verify
 *      ("verifies hash-chain on render") and shows the verified badge;
 *   3. the timeline renders what/sub/kind/timestamp per row;
 *   4. filters (kind, time range, free text) re-query the API with the
 *      matching params;
 *   5. a broken chain renders the danger badge + an alert banner;
 *   6. cursor pagination: "Load more" appends the next page;
 *   7. CSV export generates a client-side download from fetched rows.
 *
 * ShellPage is mocked to a passthrough — its SWR health chip and device
 * hook are exercised by their own tests; here they'd only add noise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";

const authFetchMock = vi.fn();
let mockRole: string = "owner";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", role: mockRole }, isLoading: false }),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, actions, children }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {actions ? <div data-testid="phead-actions">{actions}</div> : null}
      {children}
    </div>
  ),
}));

import AuditPage from "@/app/admin/audit/page";
import type { ActivityItem } from "@/components/audit/types";

function makeItem(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "1",
    at: "2026-06-30T10:00:00.000Z",
    severity: "info",
    sourceIcon: "shield",
    what: "Alice signed in",
    sub: "from 10.0.0.42",
    kind: "auth",
    refs: null,
    signature: "sig-1",
    prevSignatureHash: "",
    ...over,
  };
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/** Route the endpoints the page talks to. `users: null` (default) makes
 *  the directory fetch fail — actor names must degrade to short ids, and
 *  every pre-WARP-1009 test keeps passing without wiring users. */
function wireApi({
  items = [makeItem()],
  nextCursor = null as string | null,
  verify = { ok: true, rowsChecked: 42, verifiedAt: "2026-06-30T10:05:00.000Z" } as unknown,
  users = null as Array<{ id: string; username: string; displayName: string }> | null,
} = {}) {
  authFetchMock.mockImplementation(async (url: string) => {
    // WARP-2180 — the page now hosts the Background runs panel, which reads
    // /api/agent-runs on mount. Answer it empty so it neither shifts the
    // call count below nor renders anything the assertions could trip on.
    if (url.startsWith("/api/agent-runs")) return okJson({ items: [], nextCursor: null });
    if (url.includes("/api/auth/users")) {
      if (users) return okJson({ users });
      throw new Error("users directory unavailable");
    }
    if (url.startsWith("/api/activity/verify")) return okJson(verify);
    if (url.startsWith("/api/activity")) return okJson({ items, nextCursor });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

beforeEach(() => {
  cleanup();
  authFetchMock.mockReset();
  mockRole = "owner";
});

describe("/admin/audit gating", () => {
  it("shows the admin-required explainer to family members", async () => {
    mockRole = "family";
    wireApi();
    render(<AuditPage />);
    expect(await screen.findByText(/admin access required/i)).toBeInTheDocument();
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});

describe("/admin/audit timeline + badge", () => {
  it("fetches the activity list and the chain verification on render", async () => {
    wireApi({
      items: [
        makeItem({ id: "2", what: "Blocked device", sub: "aa:bb:cc:dd:ee:ff", kind: "network", severity: "warn" }),
        makeItem({ id: "1" }),
      ],
    });
    render(<AuditPage />);

    expect(await screen.findByText("Blocked device")).toBeInTheDocument();
    expect(screen.getByText("Alice signed in")).toBeInTheDocument();
    expect(screen.getByText("aa:bb:cc:dd:ee:ff")).toBeInTheDocument();

    // Hash-chain verified badge, from GET /api/activity/verify.
    expect(await screen.findByText(/chain verified/i)).toBeInTheDocument();
    expect(screen.getByText(/42 entries checked/i)).toBeInTheDocument();

    const urls = authFetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.startsWith("/api/activity/verify"))).toBe(true);
    expect(urls.some((u) => u.startsWith("/api/activity?"))).toBe(true);
  });

  it("renders the broken-chain state as an alert", async () => {
    wireApi({
      verify: { ok: false, rowsChecked: 7, brokenAtId: "8", verifiedAt: "2026-06-30T10:05:00.000Z" },
    });
    render(<AuditPage />);
    expect(await screen.findByText(/chain broken/i)).toBeInTheDocument();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/entry #8/i);
    // rowsChecked INCLUDES the broken row (the route counts before
    // verifying) — the intact prefix the copy reports is one shorter.
    expect(banner).toHaveTextContent(/6 entries checked before it verified intact/i);
    expect(banner).not.toHaveTextContent(/7 entries/i);
  });

  it("re-verifies on demand", async () => {
    wireApi();
    render(<AuditPage />);
    await screen.findByText(/chain verified/i);
    const before = authFetchMock.mock.calls.filter((c) =>
      (c[0] as string).startsWith("/api/activity/verify"),
    ).length;

    fireEvent.click(screen.getByRole("button", { name: /re-verify/i }));
    await waitFor(() => {
      const after = authFetchMock.mock.calls.filter((c) =>
        (c[0] as string).startsWith("/api/activity/verify"),
      ).length;
      expect(after).toBe(before + 1);
    });
  });

  it("shows a friendly empty state when no rows match the filters", async () => {
    wireApi({ items: [] });
    render(<AuditPage />);
    expect(await screen.findByText(/no activity yet/i)).toBeInTheDocument();
  });
});

describe("/admin/audit filters", () => {
  it("re-queries with kind= when a kind is picked", async () => {
    wireApi();
    render(<AuditPage />);
    await screen.findByText("Alice signed in");

    fireEvent.change(screen.getByLabelText(/filter by kind/i), {
      target: { value: "auth" },
    });
    await waitFor(() => {
      const urls = authFetchMock.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes("kind=auth"))).toBe(true);
    });
  });

  it("re-queries with from= when a time range is picked", async () => {
    wireApi();
    render(<AuditPage />);
    await screen.findByText("Alice signed in");

    fireEvent.click(screen.getByRole("button", { name: /24 hours/i }));
    await waitFor(() => {
      const urls = authFetchMock.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes("from="))).toBe(true);
    });
  });

  it("re-queries with q= after typing in the search box (debounced)", async () => {
    wireApi();
    render(<AuditPage />);
    await screen.findByText("Alice signed in");

    fireEvent.change(screen.getByLabelText(/search activity/i), {
      target: { value: "alice" },
    });
    await waitFor(
      () => {
        const urls = authFetchMock.mock.calls.map((c) => c[0] as string);
        expect(urls.some((u) => u.includes("q=alice"))).toBe(true);
      },
      { timeout: 2000 },
    );
  });
});

describe("/admin/audit pagination + export", () => {
  it("appends the next page via the cursor on Load more", async () => {
    let call = 0;
    authFetchMock.mockImplementation(async (url: string) => {
    // WARP-2180 — the page now hosts the Background runs panel, which reads
    // /api/agent-runs on mount. Answer it empty so it neither shifts the
    // call count below nor renders anything the assertions could trip on.
    if (url.startsWith("/api/agent-runs")) return okJson({ items: [], nextCursor: null });
      if (url.includes("/api/auth/users")) throw new Error("users directory unavailable");
      if (url.startsWith("/api/activity/verify")) {
        return okJson({ ok: true, rowsChecked: 2, verifiedAt: "2026-06-30T10:05:00.000Z" });
      }
      call += 1;
      if (call === 1) {
        return okJson({ items: [makeItem({ id: "9", what: "newest event" })], nextCursor: "9" });
      }
      expect(url).toContain("cursor=9");
      return okJson({ items: [makeItem({ id: "8", what: "older event" })], nextCursor: null });
    });

    render(<AuditPage />);
    await screen.findByText("newest event");

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    expect(await screen.findByText("older event")).toBeInTheDocument();
    // Newest page stays — appended, not replaced.
    expect(screen.getByText("newest event")).toBeInTheDocument();
    // Cursor exhausted — the control goes away.
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });

  it("downloads a client-generated CSV of the loaded view", async () => {
    wireApi({ items: [makeItem({ what: "exported row" })] });
    const createObjectURL = vi.fn((_blob: Blob) => "blob:droplet-audit");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    let downloadName = "";
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download;
      });

    render(<AuditPage />);
    await screen.findByText("exported row");

    // Honest partial-export labelling: "Export view", not "Export all".
    fireEvent.click(screen.getByRole("button", { name: /export view/i }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0];
    // jsdom's Blob has no .text(); FileReader is the portable read path.
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(text).toContain("id,at,kind,severity,what,sub");
    expect(text).toContain("exported row");
    expect(clickSpy).toHaveBeenCalled();
    // Filename carries the row count so a partial export is self-describing.
    expect(downloadName).toMatch(/^droplet-audit-\d{4}-\d{2}-\d{2}-1rows\.csv$/);

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("drops a stale load-more that resolves after the filters changed", async () => {
    // Sequence: page 1 loads (cursor 9) → Load more starts but hangs →
    // user picks kind=auth (new first page) → the old load-more finally
    // resolves. Its rows belong to the previous filter state and must
    // neither append nor clobber the fresh nextCursor.
    let resolveStale: (() => void) | null = null;
    authFetchMock.mockImplementation(async (url: string) => {
    // WARP-2180 — the page now hosts the Background runs panel, which reads
    // /api/agent-runs on mount. Answer it empty so it neither shifts the
    // call count below nor renders anything the assertions could trip on.
    if (url.startsWith("/api/agent-runs")) return okJson({ items: [], nextCursor: null });
      if (url.includes("/api/auth/users")) throw new Error("users directory unavailable");
      if (url.startsWith("/api/activity/verify")) {
        return okJson({ ok: true, rowsChecked: 2, verifiedAt: "2026-06-30T10:05:00.000Z" });
      }
      if (url.includes("cursor=9")) {
        return new Promise((resolve) => {
          resolveStale = () =>
            resolve(okJson({ items: [makeItem({ id: "8", what: "stale row" })], nextCursor: "8" }));
        });
      }
      if (url.includes("kind=auth")) {
        return okJson({ items: [makeItem({ id: "20", what: "filtered row", kind: "auth" })], nextCursor: null });
      }
      return okJson({ items: [makeItem({ id: "9", what: "newest event" })], nextCursor: "9" });
    });

    render(<AuditPage />);
    await screen.findByText("newest event");

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(resolveStale).not.toBeNull());

    fireEvent.change(screen.getByLabelText(/filter by kind/i), {
      target: { value: "auth" },
    });
    await screen.findByText("filtered row");

    resolveStale!();
    // Give the stale promise a macrotask to (not) land.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("stale row")).toBeNull();
    // nextCursor was not clobbered back to "8": the filtered page ended
    // the list, so no Load more control renders.
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });

  it("ignores Load more during a filter refetch (stale-cursor request window)", async () => {
    // The response-side generation guard can't catch this one: while the
    // NEW filter's first page is still in flight, nextCursor still holds
    // the OLD filter's cursor. A Load more fired in that window would go
    // out with new-filter params + old cursor under the current
    // generation and append a gapped page. loadMore must bail while
    // `loading` is true (and the button is disabled).
    let resolveFiltered: (() => void) | null = null;
    authFetchMock.mockImplementation(async (url: string) => {
    // WARP-2180 — the page now hosts the Background runs panel, which reads
    // /api/agent-runs on mount. Answer it empty so it neither shifts the
    // call count below nor renders anything the assertions could trip on.
    if (url.startsWith("/api/agent-runs")) return okJson({ items: [], nextCursor: null });
      if (url.includes("/api/auth/users")) throw new Error("users directory unavailable");
      if (url.startsWith("/api/activity/verify")) {
        return okJson({ ok: true, rowsChecked: 1, verifiedAt: "2026-06-30T10:05:00.000Z" });
      }
      if (url.includes("kind=auth")) {
        return new Promise((resolve) => {
          resolveFiltered = () =>
            resolve(okJson({ items: [makeItem({ id: "20", what: "filtered row", kind: "auth" })], nextCursor: null }));
        });
      }
      return okJson({ items: [makeItem({ id: "9", what: "newest event" })], nextCursor: "9" });
    });

    render(<AuditPage />);
    await screen.findByText("newest event");

    fireEvent.change(screen.getByLabelText(/filter by kind/i), {
      target: { value: "auth" },
    });
    await waitFor(() => expect(resolveFiltered).not.toBeNull());

    // The window: filtered first page still pending, old cursor in state.
    const loadMoreBtn = screen.getByRole("button", { name: /load more/i });
    expect(loadMoreBtn).toBeDisabled();
    fireEvent.click(loadMoreBtn);
    await new Promise((r) => setTimeout(r, 0));
    const urls = authFetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("cursor="))).toBe(false);

    resolveFiltered!();
    expect(await screen.findByText("filtered row")).toBeInTheDocument();
  });
});

describe("/admin/audit actor attribution (WARP-1009)", () => {
  it("renders the actor on every row, resolving user ids to directory names", async () => {
    wireApi({
      items: [
        makeItem({ id: "1", what: "File shared", actorType: "user", actorId: "u-42" }),
        makeItem({ id: "2", what: "Camera armed", actorType: "ai", actorId: null }),
        makeItem({ id: "3", what: "Nightly purge", actorType: "system", actorId: null }),
      ],
      users: [{ id: "u-42", username: "bob", displayName: "Bob Martin" }],
    });
    render(<AuditPage />);

    expect(await screen.findByText(/by Bob Martin/i)).toBeInTheDocument();
    expect(screen.getByText(/by Droplet AI/i)).toBeInTheDocument();
    expect(screen.getByText(/by the system/i)).toBeInTheDocument();
  });

  it("degrades a user actor to its short id when the directory is unavailable", async () => {
    // wireApi default: /api/auth/users rejects — names are progressive
    // enhancement and must never blank the actor.
    wireApi({
      items: [
        makeItem({ id: "1", what: "File shared", actorType: "user", actorId: "3f2a9c11-dead-beef-0000-000000000000" }),
      ],
    });
    render(<AuditPage />);
    expect(await screen.findByText(/by user 3f2a9c11/i)).toBeInTheDocument();
  });

  it("shows an explicit unattributed state on pre-upgrade v1 rows, not a blank", async () => {
    wireApi({
      items: [makeItem({ id: "1", what: "Old event", actorType: null, actorId: null })],
    });
    render(<AuditPage />);
    expect(await screen.findByText(/unattributed/i)).toBeInTheDocument();
  });

  it("re-queries with actorType= when an actor type is picked", async () => {
    wireApi();
    render(<AuditPage />);
    await screen.findByText("Alice signed in");

    fireEvent.change(screen.getByLabelText(/filter by actor/i), {
      target: { value: "ai" },
    });
    await waitFor(() => {
      const urls = authFetchMock.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes("actorType=ai"))).toBe(true);
    });
  });

  it("downloads the sealed NDJSON bundle via POST /api/activity/export with the active filters", async () => {
    const bundleBlob = new Blob(['{"manifest":true}\n'], { type: "application/x-ndjson" });
    authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    // WARP-2180 — the page now hosts the Background runs panel, which reads
    // /api/agent-runs on mount. Answer it empty so it neither shifts the
    // call count below nor renders anything the assertions could trip on.
    if (url.startsWith("/api/agent-runs")) return okJson({ items: [], nextCursor: null });
      if (url.includes("/api/auth/users")) throw new Error("users directory unavailable");
      if (url.startsWith("/api/activity/verify")) {
        return okJson({ ok: true, rowsChecked: 1, verifiedAt: "2026-06-30T10:05:00.000Z" });
      }
      if (url.startsWith("/api/activity/export")) {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        // The sealed export carries the SAME filters the view shows.
        expect(body.kind).toBe("auth");
        return { ok: true, status: 200, blob: async () => bundleBlob };
      }
      if (url.startsWith("/api/activity")) {
        return okJson({ items: [makeItem()], nextCursor: null });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const createObjectURL = vi.fn((_blob: Blob) => "blob:droplet-bundle");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    let downloadName = "";
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download;
      });

    render(<AuditPage />);
    await screen.findByText("Alice signed in");
    fireEvent.change(screen.getByLabelText(/filter by kind/i), {
      target: { value: "auth" },
    });
    await screen.findByText("Alice signed in");

    fireEvent.click(screen.getByRole("button", { name: /export sealed bundle/i }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(bundleBlob));
    expect(downloadName).toBe("droplet-activity-bundle.jsonl");

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
