/**
 * WARP-2804 — the service worker acknowledges a push notification when the
 * person taps it.
 *
 * `public/sw.js` is plain JS served as-is (no bundler), so it is loaded here
 * as source and run against a fake ServiceWorkerGlobalScope: the `push`
 * handler must carry the box's `notificationId` into the notification's data,
 * and `notificationclick` must POST `{"via":"opened"}` to that row's ack route
 * with the session cookie — without ever holding up the focus/navigation,
 * which browsers only allow for a short time after the click.
 *
 * Review F1 — that POST is usually made long after the push arrived, when the
 * 15-minute `droplet_session` cookie has expired: it answers 401 and the
 * worker must NOT refresh (the refresh cookie is scoped to /api/auth, and a
 * worker refresh would race the page's refresh-token rotation). So a failed
 * ack is HANDED OFF to the dashboard page, which acks through authFetch:
 * posted straight to the window the click focused or opened, and kept pending
 * (up to 60 s) until a signed-in dashboard page says it is listening — a page
 * that was just opened or navigated has not mounted its listener yet.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readPackageFile } from "./helpers/test-paths";

const SOURCE = readPackageFile("public/sw.js");

type Listener = (event: unknown) => void;

interface FakeClient {
  url: string;
  postMessage: ReturnType<typeof vi.fn>;
  focus?: ReturnType<typeof vi.fn>;
  navigate?: ReturnType<typeof vi.fn>;
}

function fakeClient(url = "https://box.local/calendar"): FakeClient {
  return { url, postMessage: vi.fn() };
}

function loadSw(
  opts: {
    fetch?: (url: string, init: RequestInit) => Promise<unknown>;
    windows?: unknown[];
    opened?: FakeClient | null;
  } = {},
) {
  const listeners: Record<string, Listener> = {};
  const clients = {
    matchAll: vi.fn(async () => opts.windows ?? []),
    openWindow: vi.fn(async (_url: string) => (opts.opened === undefined ? null : opts.opened)),
    claim: vi.fn(async () => undefined),
  };
  const registration = { showNotification: vi.fn(async (_title: string, _options: Record<string, unknown>) => undefined) };
  const self = {
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    skipWaiting: vi.fn(),
    clients,
    registration,
    location: { origin: "https://box.local" },
  };
  const fetchSpy = vi.fn(opts.fetch ?? (async () => ({ ok: true, status: 200 })));
  // The worker's globals, supplied explicitly: `self` and `fetch`.
  new Function("self", "fetch", SOURCE)(self, fetchSpy);
  return { listeners, clients, registration, fetchSpy };
}

function push(sw: ReturnType<typeof loadSw>, payload: unknown) {
  const waited: Promise<unknown>[] = [];
  sw.listeners.push!({
    data: { json: () => payload, text: () => JSON.stringify(payload) },
    waitUntil: (p: Promise<unknown>) => waited.push(p),
  });
  return Promise.all(waited);
}

function click(sw: ReturnType<typeof loadSw>, data: Record<string, unknown>) {
  const waited: Promise<unknown>[] = [];
  const close = vi.fn();
  sw.listeners.notificationclick!({ notification: { data, close }, waitUntil: (p: Promise<unknown>) => waited.push(p) });
  let settled = false;
  const done = Promise.all(waited).then((v) => {
    settled = true;
    return v;
  });
  return { done, close, settled: () => settled };
}

/** A dashboard page telling the worker it is listening. */
function pageReady(sw: ReturnType<typeof loadSw>, source: unknown, data: unknown = { type: "dashboard-ready" }) {
  sw.listeners.message!({ data, source, origin: "https://box.local" });
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const HANDOFF = { type: "ack-notification", id: "clx1" };
const EXPIRED = async () => ({ ok: false, status: 401 });

afterEach(() => {
  vi.useRealTimers();
});

describe("sw.js push → the notification carries the box's notificationId", () => {
  it("into the notification data, beside the validated url", async () => {
    const sw = loadSw();
    await push(sw, { title: "Standup", body: "10am", url: "/calendar", notificationId: "clx1", data: { a: 1 } });
    const options = sw.registration.showNotification.mock.calls[0]![1];
    expect(options.data).toEqual({ a: 1, url: "/calendar", notificationId: "clx1" });
  });

  it("a `data.notificationId` can never stand in for the box's own (it is written last)", async () => {
    const sw = loadSw();
    await push(sw, { title: "x", url: "/calendar", data: { notificationId: "someone-elses" } });
    const options = sw.registration.showNotification.mock.calls[0]![1];
    expect((options.data as Record<string, unknown>).notificationId).toBeUndefined();
  });
});

describe("sw.js notificationclick → acknowledges it as opened", () => {
  it("POSTs {\"via\":\"opened\"} to the row's ack route with the session cookie, and opens the link", async () => {
    const opened = fakeClient();
    const sw = loadSw({ opened });
    const { done, close } = click(sw, { url: "/calendar", notificationId: "clx1" });
    await done;
    expect(close).toHaveBeenCalled();
    expect(sw.fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = sw.fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/notifications/clx1/ack");
    expect(init).toEqual({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: '{"via":"opened"}',
    });
    expect(sw.clients.openWindow).toHaveBeenCalledWith("/calendar");
    // Acked directly: nothing is handed to the page.
    expect(opened.postMessage).not.toHaveBeenCalled();
  });

  it("without a notificationId (an older box, the camera fan-out), nothing is acked", async () => {
    const opened = fakeClient();
    const sw = loadSw({ opened });
    await click(sw, { url: "/cameras/front" }).done;
    expect(sw.fetchSpy).not.toHaveBeenCalled();
    expect(sw.clients.openWindow).toHaveBeenCalledWith("/cameras/front");
    expect(opened.postMessage).not.toHaveBeenCalled();
  });

  it.each(["../admin", "a/b", "", "x".repeat(65), 42])("an id that is not a row id (%j) is not sent", async (id) => {
    const opened = fakeClient();
    const sw = loadSw({ opened });
    await click(sw, { url: "/calendar", notificationId: id }).done;
    expect(sw.fetchSpy).not.toHaveBeenCalled();
    expect(opened.postMessage).not.toHaveBeenCalled();
  });

  it("the navigation never waits for the ack (browsers allow openWindow only briefly after the click)", async () => {
    let release: () => void = () => {};
    const sw = loadSw({ fetch: () => new Promise((r) => (release = () => r({ ok: true }))) });
    const c = click(sw, { url: "/calendar", notificationId: "clx1" });
    await tick();
    expect(sw.clients.openWindow).toHaveBeenCalledWith("/calendar");
    // …and the worker is kept alive until the ack settles.
    await tick();
    expect(c.settled()).toBe(false);
    release();
    await c.done;
    expect(c.settled()).toBe(true);
  });

  it("an existing dashboard tab is focused and navigated, as before", async () => {
    const tab = { ...fakeClient("https://box.local/home"), focus: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) };
    const sw = loadSw({ windows: [tab] });
    await click(sw, { url: "/calendar", notificationId: "clx1" }).done;
    expect(tab.focus).toHaveBeenCalled();
    expect(tab.navigate).toHaveBeenCalledWith("/calendar");
    expect(sw.clients.openWindow).not.toHaveBeenCalled();
    expect(sw.fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("sw.js → an ack the worker could not make is handed to the page (review F1)", () => {
  it("MUTATION: a 401 (the 15-min session cookie expired) posts the ack to the window the click opened", async () => {
    const opened = fakeClient();
    const sw = loadSw({ fetch: EXPIRED, opened });
    const c = click(sw, { url: "/calendar", notificationId: "clx1" });
    await tick();
    await tick();
    expect(opened.postMessage).toHaveBeenCalledWith(HANDOFF);
    // Kept pending until a signed-in page says it is listening (it may not be yet).
    expect(c.settled()).toBe(false);
    pageReady(sw, opened);
    await c.done;
    expect(opened.postMessage).toHaveBeenCalledTimes(2);
  });

  it("a network failure (fetch throws) is handed off the same way", async () => {
    const opened = fakeClient();
    const sw = loadSw({ fetch: async () => Promise.reject(new TypeError("offline")), opened });
    const c = click(sw, { url: "/calendar", notificationId: "clx1" });
    await tick();
    await tick();
    expect(opened.postMessage).toHaveBeenCalledWith(HANDOFF);
    pageReady(sw, opened);
    await expect(c.done).resolves.toBeDefined();
  });

  it("the focused tab's navigated client receives it (the WindowClient navigate() returned)", async () => {
    const navigated = fakeClient();
    const tab = {
      ...fakeClient("https://box.local/home"),
      focus: vi.fn(async () => undefined),
      navigate: vi.fn(async () => navigated),
    };
    const sw = loadSw({ fetch: EXPIRED, windows: [tab] });
    const c = click(sw, { url: "/calendar", notificationId: "clx1" });
    await tick();
    await tick();
    expect(navigated.postMessage).toHaveBeenCalledWith(HANDOFF);
    expect(tab.postMessage).not.toHaveBeenCalledWith(HANDOFF);
    pageReady(sw, navigated);
    await c.done;
  });

  it("openWindow returned null: the ack waits for the first dashboard page that says it is listening", async () => {
    const sw = loadSw({ fetch: EXPIRED, opened: null });
    const c = click(sw, { url: "/calendar", notificationId: "clx1" });
    await tick();
    await tick();
    expect(c.settled()).toBe(false);
    const later = fakeClient();
    pageReady(sw, later);
    await c.done;
    expect(later.postMessage).toHaveBeenCalledWith(HANDOFF);
    // Handed over once: a second page is told nothing.
    const another = fakeClient();
    pageReady(sw, another);
    expect(another.postMessage).not.toHaveBeenCalled();
  });

  it("a hand-off nobody takes is dropped after 60 s (the row stays unread and findable)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sw = loadSw({ fetch: EXPIRED, opened: null });
    const c = click(sw, { url: "/calendar", notificationId: "clx1" });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(c.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    await c.done;
    const late = fakeClient();
    pageReady(sw, late);
    expect(late.postMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["no data", null],
    ["a string", "dashboard-ready"],
    ["another type", { type: "hello" }],
  ])("the worker ignores a message that is not a dashboard's ready (%s)", async (_label, data) => {
    const sw = loadSw({ fetch: EXPIRED, opened: null });
    const c = click(sw, { url: "/calendar", notificationId: "clx1" });
    await tick();
    await tick();
    const stranger = fakeClient();
    pageReady(sw, stranger, data);
    expect(stranger.postMessage).not.toHaveBeenCalled();
    expect(c.settled()).toBe(false);
  });

  it("a ready message without a window source is ignored", async () => {
    const sw = loadSw({ fetch: EXPIRED, opened: null });
    const c = click(sw, { url: "/calendar", notificationId: "clx1" });
    await tick();
    await tick();
    pageReady(sw, null);
    expect(c.settled()).toBe(false);
  });

  it("the worker never refreshes the session itself", async () => {
    const sw = loadSw({ fetch: EXPIRED, opened: fakeClient() });
    click(sw, { url: "/calendar", notificationId: "clx1" });
    await tick();
    await tick();
    expect(sw.fetchSpy.mock.calls.map((c) => c[0])).toEqual(["/api/notifications/clx1/ack"]);
  });
});

describe("sw.js — Security alerts (WARP-2978, D36, D37)", () => {
  const INCIDENT = "/security/incidents/7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f";

  it("an alert stays in the tray until it is handled (requireInteraction)", async () => {
    const sw = loadSw();
    await push(sw, { title: "Person in Stock room after hours", url: INCIDENT, notificationId: "clx9", priority: "alert", tag: "security-incident-1" });
    const options = sw.registration.showNotification.mock.calls[0]![1];
    expect(options.requireInteraction).toBe(true);
    expect(options.tag).toBe("security-incident-1");
  });

  it("anything else does not (the old comment claimed otherwise; the flag was always false)", async () => {
    const sw = loadSw();
    await push(sw, { title: "Standup", url: "/calendar", notificationId: "clx1" });
    expect(sw.registration.showNotification.mock.calls[0]![1].requireInteraction).toBe(false);
  });

  it("a `data.priority` can't make a notification sticky (only the box's own priority counts)", async () => {
    const sw = loadSw();
    await push(sw, { title: "x", url: "/calendar", data: { priority: "alert" } });
    expect(sw.registration.showNotification.mock.calls[0]![1].requireInteraction).toBe(false);
  });

  it("no action buttons on an alert: one tap opens the page, where Acknowledge can say if it failed (D36)", async () => {
    const sw = loadSw();
    await push(sw, { title: "x", url: INCIDENT, notificationId: "clx9", priority: "alert" });
    expect(sw.registration.showNotification.mock.calls[0]![1].actions).toBeUndefined();
  });

  it("tapping an incident alert opens the incident with ?n=<notification>", async () => {
    const opened = fakeClient();
    const sw = loadSw({ opened });
    await click(sw, { url: INCIDENT, notificationId: "clx9" }).done;
    expect(sw.clients.openWindow).toHaveBeenCalledWith(`${INCIDENT}?n=clx9`);
  });

  it("any other link, or a tap without a valid row id, is opened as the box sent it", async () => {
    const sw = loadSw({ opened: fakeClient() });
    await click(sw, { url: "/calendar", notificationId: "clx9" }).done;
    expect(sw.clients.openWindow).toHaveBeenLastCalledWith("/calendar");
    await click(sw, { url: INCIDENT, notificationId: "../x" }).done;
    expect(sw.clients.openWindow).toHaveBeenLastCalledWith(INCIDENT);
    await click(sw, { url: `${INCIDENT}?n=someone-elses`, notificationId: "clx9" }).done;
    expect(sw.clients.openWindow).toHaveBeenLastCalledWith(`${INCIDENT}?n=someone-elses`);
  });
});
