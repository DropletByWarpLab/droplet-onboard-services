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
 *   1. A signs out with a poll of A's page on the wire, its answers land
 *      after the sign-out, and B signs in on the same React tree: none of B's
 *      renders, and nothing left in the cache, shows A's feed rows or source
 *      health. The feed is a `useSWRInfinite` key: SWR's key-filter
 *      `mutate(() => true, …)` does not reach it, and its page answers are
 *      written past the per-key markers a plain `useSWR` answer is checked
 *      against — only SWR's `unload()` discards them. Sign-out then asks the
 *      box for nothing, even for a read still mounted when the cache empties.
 *   2. A's session dies under authFetch (the confirmed-dead bounce), not via
 *      the button: the cache is dropped there too, and nothing is refetched.
 *   3. The chat hand-offs in sessionStorage do not cross the sign-out — nor a
 *      sign-out in ANOTHER tab, which this tab only learns of from a 401 —
 *      while an anonymous 401 (the /setup wizard) keeps the cache.
 *   4. A's toasts — a notification body, a persistent error — leave with A.
 *   5. Signing in as B over a profile this tab cached for someone else (A's
 *      session ended where this tab's sign-out never ran) empties the cache
 *      before B renders; A signing in again, or a first sign-in over no
 *      cached profile (the wizard's account step), keeps it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { SWRConfig, mutate, unload } from "swr";
import { AuthProvider, authFetch, useAuth, type AuthUser } from "@/lib/auth";
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
/** lib/auth.tsx's cached-profile key (not exported); localStorage, so shared by every tab. */
const USER_KEY = "droplet-auth-user";

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
    observed: "live",
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
/** While set, A's reads wait on it — answered for A, landing whenever the test lets them. */
let holdAlice: Promise<void> | null = null;
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
    const hold = who === "bob" ? holdBob : holdAlice;
    if (hold) await hold;
    return json(url === "/api/security/health" ? HEALTH[who] : FEED[who]);
  }
  return json({ error: "not found" }, 404);
}

// ── the tab ─────────────────────────────────────────────────────────────────

/** Stable identity: `useSecurityFeed` keys its pages on it. */
const FEED_FILTER: SecurityFeedFilter = { limit: 50 };

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

/** A read mounted outside the signed-in gate. Nothing in the dashboard is today: AuthGate unmounts every page on sign-out. */
function HealthLine() {
  const { sources } = useSecurityHealth();
  return <p aria-label="left mounted">{sources?.map((s) => s.detail).join(", ")}</p>;
}

function Tab({ leftMounted = false }: { leftMounted?: boolean }) {
  const { user, isLoading, login, logout, setUserFromPasskey } = useAuth();
  const { toast } = useToast();
  if (isLoading) return <p>loading</p>;
  return (
    <>
      {/* AuthGate's effect on sign-out: the page goes, /login shows. */}
      {user ? <SecurityPage viewer={user.username} /> : <p>signed out</p>}
      {leftMounted && <HealthLine />}
      <button onClick={() => void logout()}>sign out</button>
      <button onClick={() => void login("alice", "correct horse")}>sign A back in</button>
      <button onClick={() => void login("bob", "correct horse")}>sign in as bob</button>
      <button
        onClick={() => {
          session = "bob"; // the passkey ceremony set B's cookie
          setUserFromPasskey(USERS.bob);
        }}
      >
        passkey as bob
      </button>
      <button onClick={() => toast("Couldn't upload alice-lab-results.pdf", "error")}>fail an upload</button>
    </>
  );
}

function renderTab(props: { leftMounted?: boolean } = {}) {
  return render(
    <AuthProvider>
      <ToastProvider>
        <NotificationToaster />
        <Tab {...props} />
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

beforeEach(() => {
  session = "alice";
  holdBob = null;
  holdAlice = null;
  asked = [];
  renders = [];
  localStorage.clear();
  sessionStorage.clear();
  FakeWebSocket.latest = null;
  vi.stubGlobal("fetch", vi.fn(box));
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // The default cache is module state shared by every test in this file (as
  // it is by every page in a tab): start each test from an empty one, with no
  // dedupe markers left for a hook here to be handed the last test's answer.
  unload({ revalidate: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: realLocation });
});

describe("WARP-2992 — the next person to sign in never sees the last one's data", () => {
  it("B never renders A's Security rows or source health — not even an answer A's page asked for that lands after A signed out", async () => {
    renderTab();
    expect(await screen.findByText(ALICE_ROW)).toBeInTheDocument();
    expect(await screen.findByText(ALICE_SOURCE)).toBeInTheDocument();

    // A's page polls the feed and the health line every 15 s. Catch a poll on
    // the wire — both reads held — as A signs out.
    let releaseAlice!: () => void;
    holdAlice = new Promise<void>((r) => (releaseAlice = r));
    const polled = asked.length;
    fireEvent.click(screen.getByText("refresh"));
    await waitFor(() => {
      const onTheWire = asked.slice(polled);
      expect(onTheWire.some((url) => url.startsWith("/api/security/events"))).toBe(true);
      expect(onTheWire).toContain("/api/security/health");
    });

    fireEvent.click(screen.getByText("sign out"));
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    // Signed out, nothing of A's is left in the tab to paint...
    expect(cachedData()).not.toContain("Alice");
    // ...and emptying the cache refetched nothing: A's page was gone before
    // the clear ran, so no read went out on the dead cookie.
    expect(asked.slice(asked.lastIndexOf("/api/auth/logout") + 1)).toEqual([]);

    // The box answers A's held poll now, after the sign-out: A's rows, A's
    // sources. Nothing of them may be written back into the tab.
    await act(async () => {
      releaseAlice();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(cachedData()).not.toContain("Alice");

    // B signs in on the same tab. Hold B's reads so every render B gets
    // before B's own answers arrive is on the record.
    let releaseBob!: () => void;
    holdBob = new Promise<void>((r) => (releaseBob = r));
    fireEvent.click(screen.getByText("sign in as bob"));
    await screen.findByRole("region", { name: "security" });

    const beforeBobsData = renders.filter((r) => r.viewer === "bob");
    expect(beforeBobsData.length).toBeGreaterThan(0);
    expect(beforeBobsData[0]).toEqual({ viewer: "bob", rows: [], sources: null });
    expect(JSON.stringify(beforeBobsData)).not.toContain("Alice");

    await act(async () => releaseBob());
    expect(await screen.findByText(BOB_ROW)).toBeInTheDocument();
    expect(await screen.findByText(BOB_SOURCE)).toBeInTheDocument();
    expect(JSON.stringify(renders.filter((r) => r.viewer === "bob"))).not.toContain("Alice");
    expect(cachedData()).not.toContain("Alice");
  });

  it("sign-out asks the box for nothing after the logout POST — not even for a read still mounted when the cache empties", async () => {
    // A read that refetched on the dead cookie would 401 its way through
    // authFetch's bounce to /login?next=<A's page>, and whoever signed in
    // next would be sent on to A's page.
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...realLocation, pathname: "/security", search: "", assign },
    });
    renderTab({ leftMounted: true });
    expect(await screen.findByText(ALICE_ROW)).toBeInTheDocument();
    expect(screen.getByLabelText("left mounted").textContent).toBe(ALICE_SOURCE);

    fireEvent.click(screen.getByText("sign out"));
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(asked.slice(asked.lastIndexOf("/api/auth/logout") + 1)).toEqual([]);
    expect(assign).not.toHaveBeenCalled();
    // Emptied all the same: the mounted read shows nothing of A's.
    expect(screen.getByLabelText("left mounted").textContent).toBe("");
    expect(cachedData()).not.toContain("Alice");
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
    const polled = asked.length;
    fireEvent.click(screen.getByText("refresh"));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login?next=%2Fsecurity"));
    expect(cachedData()).not.toContain("Alice");
    await waitFor(() => expect(screen.queryByText(ALICE_ROW)).not.toBeInTheDocument());
    expect(screen.queryByText(ALICE_SOURCE)).not.toBeInTheDocument();

    // Emptying the cache refetched nothing. A's page is still up until the
    // bounce lands, and a read now could only be one more 401 on the way.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const reads = asked.slice(polled).filter((url) => url.startsWith("/api/security"));
    expect(reads.map((url) => url.split("?")[0]).sort()).toEqual(["/api/security/events", "/api/security/health"]);
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

  it("A signed out in another tab: this tab's hand-offs go when its next read finds the session dead", async () => {
    renderTab();
    expect(await screen.findByText(ALICE_ROW)).toBeInTheDocument();
    sessionStorage.setItem(PENDING_PROMPT_KEY, "summarise my lab results");
    sessionStorage.setItem(PENDING_COMPOSER_KEY, JSON.stringify({ kind: "pin", label: "Jane Doe" }));

    // The other tab's sign-out: the box ends A's session, and the profile
    // cached in the localStorage every tab shares goes with it. This tab's
    // sessionStorage is its own, and still holds A's hand-offs.
    session = null;
    localStorage.removeItem(USER_KEY);
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...realLocation, pathname: "/security", search: "", assign },
    });
    fireEvent.click(screen.getByText("refresh"));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login?next=%2Fsecurity"));
    expect(sessionStorage.getItem(PENDING_PROMPT_KEY)).toBeNull();
    expect(sessionStorage.getItem(PENDING_COMPOSER_KEY)).toBeNull();
  });

  it("an anonymous 401 on /setup keeps the cache: no one was signed in to forget", async () => {
    session = null;
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...realLocation, pathname: "/setup", search: "", assign },
    });
    // What the first-run wizard has read so far.
    await mutate("/api/setup/network", { uplink: "wizard's uplink answer" }, { revalidate: false });

    const res = await authFetch("/api/security/health");

    expect(res.status).toBe(401);
    // It reached the confirmed-dead verdict (the refresh had no cookie)...
    expect(asked).toContain("/api/auth/refresh");
    // ...and the wizard's cache is intact; /setup routes itself, no bounce.
    expect(cachedData()).toContain("wizard's uplink answer");
    expect(assign).not.toHaveBeenCalled();
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

  it.each([
    ["with a password, over A's cached profile", "sign in as bob", () => {}],
    ["with a password, over a cached profile that cannot be read", "sign in as bob", () => localStorage.setItem(USER_KEY, "{not json")],
    ["with a passkey, over A's cached profile", "passkey as bob", () => {}],
  ])("B signing in %s empties the cache before B renders", async (_how, button, cachedProfile) => {
    renderTab();
    expect(await screen.findByText(ALICE_ROW)).toBeInTheDocument();
    expect(await screen.findByText(ALICE_SOURCE)).toBeInTheDocument();

    // A's session ended where this tab's sign-out never ran, so the cache
    // still holds what was read as A when B signs in over A's profile.
    cachedProfile();
    let releaseBob!: () => void;
    holdBob = new Promise<void>((r) => (releaseBob = r));
    fireEvent.click(screen.getByText(button));
    await waitFor(() => expect(renders.some((r) => r.viewer === "bob")).toBe(true));
    expect(JSON.stringify(renders.filter((r) => r.viewer === "bob"))).not.toContain("Alice");
    expect(cachedData()).not.toContain("Alice");

    await act(async () => releaseBob());
    expect(await screen.findByText(BOB_ROW)).toBeInTheDocument();
    expect(await screen.findByText(BOB_SOURCE)).toBeInTheDocument();
    expect(JSON.stringify(renders.filter((r) => r.viewer === "bob"))).not.toContain("Alice");
  });

  it("A signing in again over A's own profile keeps A's cache", async () => {
    renderTab();
    expect(await screen.findByText(ALICE_ROW)).toBeInTheDocument();

    // Any read the re-sign-in set off would sit on the wire from here on.
    holdAlice = new Promise<void>(() => {});
    const before = asked.length;
    fireEvent.click(screen.getByText("sign A back in"));
    // login() is done once its lifecycle re-probe has gone out and settled.
    await waitFor(() => expect(asked.slice(before)).toContain("/api/setup/state"));
    await act(async () => {});

    expect(cachedData()).toContain(ALICE_ROW);
    expect(screen.getByText(ALICE_ROW)).toBeInTheDocument();
  });

  it("the first sign-in on a tab with no cached profile — the wizard's account step — keeps the wizard's cache", async () => {
    session = null;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...realLocation, pathname: "/setup", search: "", assign: vi.fn() },
    });
    renderTab();
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    await act(() => mutate("/api/setup/network", { uplink: "wizard's uplink answer" }, { revalidate: false }));

    // The account step creates the owner and signs them in through the
    // passkey path's setter, over no cached profile at all.
    fireEvent.click(screen.getByText("passkey as bob"));
    expect(await screen.findByText(BOB_ROW)).toBeInTheDocument();
    expect(cachedData()).toContain("wizard's uplink answer");
  });
});
