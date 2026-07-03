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

/** Route the two endpoints the page talks to. */
function wireApi({
  items = [makeItem()],
  nextCursor = null as string | null,
  verify = { ok: true, rowsChecked: 42, verifiedAt: "2026-06-30T10:05:00.000Z" } as unknown,
} = {}) {
  authFetchMock.mockImplementation(async (url: string) => {
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

  it("downloads a client-generated CSV of the fetched rows", async () => {
    wireApi({ items: [makeItem({ what: "exported row" })] });
    const createObjectURL = vi.fn((_blob: Blob) => "blob:droplet-audit");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<AuditPage />);
    await screen.findByText("exported row");

    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
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

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
