// @vitest-environment jsdom
/**
 * WARP-2992 — signing out must not hand the previous person's data to the next.
 *
 * Sign-out is a CLIENT-SIDE navigation (`logout()` then `router.push("/login")`
 * in the Sidebar, the Workspace shell and the change-password screen), so the
 * JS heap outlives the session. Every page reads through `useSWR` with keys
 * that name a resource and never a person (`/api/security/health`, the
 * Security feed's pages), all in SWR's one default cache. So on a shared tab
 * the next person to sign in got the previous person's camera and door-lock
 * rows on their FIRST render, and revalidation only replaced them afterwards.
 *
 * These tests run the real AuthProvider, the real Security hooks, the real
 * default SWR cache and the real toast stack. Only the network is faked: a
 * one-box server whose session is whoever signed in last.
 *
 *   1. A signs out, B signs in on the same React tree: none of B's renders
 *      shows A's feed rows or source health — the feed is a `useSWRInfinite`
 *      key, which SWR's key-filter `mutate(() => true, …)` does not reach.
 *   2. A's session dies under authFetch (the confirmed-dead bounce), not via
 *      the button: the cache is dropped there too.
 *   3. The chat hand-offs in sessionStorage do not cross the sign-out.
 *   4. A's toasts — a notification body, a persistent error — leave with A.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { SWRConfig, unstable_serialize } from "swr";
import { unstable_serialize as serializeInfinite } from "swr/infinite";
import { AuthProvider, useAuth, type AuthUser } from "@/lib/auth";
import { useSecurityFeed, useSecurityHealth, type SecurityFeedFilter } from "@/lib/hooks/useSecurity";
import { ToastProvider, useToast } from "@/components/Toast";
import { NotificationToaster } from "@/components/NotificationToaster";
import { PENDING_COMPOSER_KEY, PENDING_PROMPT_KEY } from "@/lib/types";
import type { SecurityEvent, SecurityEventsPage, SecurityHealthRow } from "@/lib/types";

// ── the fake box ────────────────────────────────────────────────────────────

const USERS: Record<"alice" | "bob", AuthUser> = {
  alice: { id: "u-alice", username: "alice", displayName: "Alice", role: "owner" },
  bob: { id: "u-bob", username: "bob", displayName: "Bob", role: "family" },
};
type Who = keyof typeof USERS;

const ALICE_ROW = "Alice's front door unlocked";
const ALICE_SOURCE = "Alice's cameras reporting";
const BOB_ROW = "Bob's garage motion";
const BOB_SOURCE = "Bob's cameras reporting";

function event(summary: string): SecurityEvent {
  return {
    id: summary,
    source: "frigate",
    kind: "detection",
    severity: "notice",
    camera: "front",
    labels: [],
    cameraZones: [],
    score: null,
    startedAt: "2026-09-24T08:00:00.000Z",
    endedAt: null,
    summary,
    frigateEventId: null,
    zones: [],
  };
}
const FEED: Record<Who, SecurityEventsPage> = {
  alice: { events: [event(ALICE_ROW)], nextCursor: null },
  bob: { events: [event(BOB_ROW)], nextCursor: null },
};
function health(detail: string): { sources: SecurityHealthRow[] } {
  return { sources: [{ id: "camera_ingest", state: "ok", detail, lastSeenAt: null }] };
}
const HEALTH: Record<Who, { sources: SecurityHealthRow[] }> = {
  alice: health(ALICE_SOURCE),
  bob: health(BOB_SOURCE),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Who the box's session cookie belongs to right now. */
let session: Who | null = null;
/** While set, B's reads wait on it — so the test can look at B's renders BEFORE B's data lands. */
let holdBob: Promise<void> | null = null;
/** Every URL the tab asked the box for, in order. */
let asked: string[] = [];

async function box(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  asked.push(url);
  if (url === "/api/setup/state") {
    return json({ appliance: "ready", setup_step: "done", user_tour_completed: true });
  }
  if (url === "/api/auth/me") return session ? json(USERS[session]) : json({ error: "unauthenticated" }, 401);
  // No refresh cookie once the session is gone — the one refresh answer that is conclusive on its own.
  if (url === "/api/auth/refresh") return json({ code: "NO_REFRESH_TOKEN" }, 401);
  if (url === "/api/auth/logout") {
    session = null;
    return json({ ok: true });
  }
  if (url === "/api/auth/login") {
    const who = JSON.parse(String(init?.body)).username as Who;
    session = who;
    return json({ user: USERS[who] });
  }
  if (url.startsWith("/api/security/events") || url === "/api/security/health") {
    const who = session;
    if (!who) return json({ error: "unauthenticated" }, 401);
    if (who === "bob" && holdBob) await holdBob;
    return json(url === "/api/security/health" ? HEALTH[who] : FEED[who]);
  }
  return json({ error: "not found" }, 404);
}

// ── the tab ─────────────────────────────────────────────────────────────────

/** Stable identity: `useSecurityFeed` keys its pages on it. */
const FEED_FILTER: SecurityFeedFilter = { limit: 50 };

/** The SWR keys this tab reads: the feed's first page, its useSWRInfinite key, the health line. */
const FIRST_PAGE = ["security-events", JSON.stringify(FEED_FILTER), null] as const;
const TAB_KEYS = [
  unstable_serialize(FIRST_PAGE),
  serializeInfinite((i: number) => (i === 0 ? FIRST_PAGE : null)),
  "/api/security/health",
];

/** Every render of the Security page, tagged with who was signed in. */
let renders: { viewer: string; rows: string[]; sources: string[] | null }[] = [];

function SecurityPage({ viewer }: { viewer: string }) {
  const feed = useSecurityFeed(FEED_FILTER);
  const sourceHealth = useSecurityHealth();
  const rows = feed.events.map((e) => e.summary);
  const sources = sourceHealth.sources?.map((s) => s.detail) ?? null;
  renders.push({ viewer, rows, sources });
  return (
    <section aria-label="security">
      <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>
      <p>{sources?.join(", ")}</p>
      <button onClick={() => { feed.refresh(); sourceHealth.refresh(); }}>refresh</button>
    </section>
  );
}

function Tab() {
  const { user, isLoading, login, logout } = useAuth();
  const { toast } = useToast();
  if (isLoading) return <p>loading</p>;
  return (
    <>
      {/* AuthGate's effect on sign-out: the page goes, /login shows. */}
      {user ? <SecurityPage viewer={user.username} /> : <p>signed out</p>}
      <button onClick={() => void logout()}>sign out</button>
      <button onClick={() => void login("bob", "correct horse")}>sign in as bob</button>
      <button onClick={() => toast("Couldn't upload alice-lab-results.pdf", "error")}>fail an upload</button>
    </>
  );
}

function renderTab() {
  return render(
    <AuthProvider>
      <ToastProvider>
        <NotificationToaster />
        <Tab />
      </ToastProvider>
    </AuthProvider>,
  );
}

/** Everything SWR's default cache currently holds as data, as one string. */
function cachedData(): string {
  const { cache } = SWRConfig.defaultValue;
  return JSON.stringify(Array.from(cache.keys(), (key) => cache.get(key)?.data ?? null));
}

// NotificationToaster opens a socket per signed-in user; drive it by hand.
class FakeWebSocket {
  static latest: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.latest = this;
  }
  close() {}
}

const realLocation = window.location;

beforeEach(async () => {
  session = "alice";
  holdBob = null;
  asked = [];
  renders = [];
  localStorage.clear();
  sessionStorage.clear();
  FakeWebSocket.latest = null;
  vi.stubGlobal("fetch", vi.fn(box));
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // The default cache is module state shared by every test in this file (as
  // it is by every page in a tab). Start each test from an empty one — and
  // with no dedupe markers, or a hook here would be handed the previous
  // test's last answer. Nothing is mounted yet, so `mutate(key)` only drops
  // the markers. By NAME, not from `cache.keys()`: a key the fix already
  // deleted keeps its markers, and would not be listed.
  const { cache, mutate } = SWRConfig.defaultValue;
  const keys = [...new Set([...TAB_KEYS, ...cache.keys()])];
  await Promise.all(keys.map((key) => mutate(key)));
  for (const key of keys) cache.delete(key);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: realLocation });
});

describe("WARP-2992 — the next person to sign in never sees the last one's data", () => {
  it("B's first render after A signs out shows none of A's cached Security rows or source health", async () => {
    renderTab();
    expect(await screen.findByText(ALICE_ROW)).toBeInTheDocument();
    expect(await screen.findByText(ALICE_SOURCE)).toBeInTheDocument();

    fireEvent.click(screen.getByText("sign out"));
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    // Signed out, nothing of A's is left in the tab to paint...
    expect(cachedData()).not.toContain("Alice");
    // ...and emptying the cache refetched nothing: A's page was gone before
    // the clear ran, so no read went out on the dead cookie.
    expect(asked.slice(asked.lastIndexOf("/api/auth/logout") + 1)).toEqual([]);

    // B signs in on the same tab. Hold B's reads so every render B gets
    // before B's own answers arrive is on the record.
    let release!: () => void;
    holdBob = new Promise<void>((r) => (release = r));
    fireEvent.click(screen.getByText("sign in as bob"));
    await screen.findByRole("region", { name: "security" });

    const beforeBobsData = renders.filter((r) => r.viewer === "bob");
    expect(beforeBobsData.length).toBeGreaterThan(0);
    expect(beforeBobsData[0]).toEqual({ viewer: "bob", rows: [], sources: null });
    expect(JSON.stringify(beforeBobsData)).not.toContain("Alice");

    await act(async () => release());
    expect(await screen.findByText(BOB_ROW)).toBeInTheDocument();
    expect(await screen.findByText(BOB_SOURCE)).toBeInTheDocument();
    expect(JSON.stringify(renders.filter((r) => r.viewer === "bob"))).not.toContain("Alice");
  });

  it("a session that dies under authFetch drops the cache before the bounce to /login", async () => {
    renderTab();
    expect(await screen.findByText(ALICE_ROW)).toBeInTheDocument();

    // The box ends A's session (expiry, revoked elsewhere). A's page is still
    // up; its next read 401s, the refresh has no cookie, authFetch bounces.
    session = null;
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...realLocation, pathname: "/security", search: "", assign },
    });
    fireEvent.click(screen.getByText("refresh"));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login?next=%2Fsecurity"));
    expect(cachedData()).not.toContain("Alice");
    await waitFor(() => expect(screen.queryByText(ALICE_ROW)).not.toBeInTheDocument());
    expect(screen.queryByText(ALICE_SOURCE)).not.toBeInTheDocument();
  });

  it("A's chat hand-offs do not survive A signing out", async () => {
    renderTab();
    expect(await screen.findByText(ALICE_ROW)).toBeInTheDocument();
    // The hero prompt auto-SENDS on the next fresh /chat; the composer seed is
    // deliberately left in place when /chat was deep-linked.
    sessionStorage.setItem(PENDING_PROMPT_KEY, "summarise my lab results");
    sessionStorage.setItem(PENDING_COMPOSER_KEY, JSON.stringify({ kind: "pin", label: "Jane Doe" }));

    fireEvent.click(screen.getByText("sign out"));
    expect(await screen.findByText("signed out")).toBeInTheDocument();

    expect(sessionStorage.getItem(PENDING_PROMPT_KEY)).toBeNull();
    expect(sessionStorage.getItem(PENDING_COMPOSER_KEY)).toBeNull();
  });

  it("A's toasts — a notification and a persistent error — leave with A", async () => {
    renderTab();
    expect(await screen.findByText(ALICE_ROW)).toBeInTheDocument();
    await waitFor(() => expect(FakeWebSocket.latest).not.toBeNull());
    act(() => {
      FakeWebSocket.latest!.onmessage?.({
        data: JSON.stringify({
          topic: "droplet/notifications/alice",
          payload: { kind: "reminder", title: "Reminder", body: "Alice: oncology follow-up at 3pm" },
        }),
      });
    });
    fireEvent.click(screen.getByText("fail an upload"));
    expect(screen.getByText("Reminder — Alice: oncology follow-up at 3pm")).toBeInTheDocument();
    expect(screen.getByText("Couldn't upload alice-lab-results.pdf")).toBeInTheDocument();

    fireEvent.click(screen.getByText("sign out"));
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Reminder — Alice: oncology follow-up at 3pm")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Couldn't upload alice-lab-results.pdf")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("sign in as bob"));
    expect(await screen.findByText(BOB_ROW)).toBeInTheDocument();
    expect(screen.queryByText(/alice/i)).not.toBeInTheDocument();
  });
});
