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
 */
import { describe, it, expect, vi } from "vitest";
import { readPackageFile } from "./helpers/test-paths";

const SOURCE = readPackageFile("public/sw.js");

type Listener = (event: unknown) => void;

function loadSw(opts: { fetch?: (url: string, init: RequestInit) => Promise<unknown>; windows?: unknown[] } = {}) {
  const listeners: Record<string, Listener> = {};
  const clients = {
    matchAll: vi.fn(async () => opts.windows ?? []),
    openWindow: vi.fn(async (_url: string) => null),
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
  return { done: Promise.all(waited), close };
}

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
    const sw = loadSw();
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
  });

  it("without a notificationId (an older box, the camera fan-out), nothing is acked", async () => {
    const sw = loadSw();
    await click(sw, { url: "/cameras/front" }).done;
    expect(sw.fetchSpy).not.toHaveBeenCalled();
    expect(sw.clients.openWindow).toHaveBeenCalledWith("/cameras/front");
  });

  it.each(["../admin", "a/b", "", "x".repeat(65), 42])("an id that is not a row id (%j) is not sent", async (id) => {
    const sw = loadSw();
    await click(sw, { url: "/calendar", notificationId: id }).done;
    expect(sw.fetchSpy).not.toHaveBeenCalled();
  });

  it("the navigation never waits for the ack (browsers allow openWindow only briefly after the click)", async () => {
    let release: () => void = () => {};
    const sw = loadSw({ fetch: () => new Promise((r) => (release = () => r({ ok: true }))) });
    const { done } = click(sw, { url: "/calendar", notificationId: "clx1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.clients.openWindow).toHaveBeenCalledWith("/calendar");
    // …and the worker is kept alive until the ack settles.
    let settled = false;
    void done.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    release();
    await done;
    expect(settled).toBe(true);
  });

  it("a failed ack is swallowed: the click still navigates and waitUntil does not reject", async () => {
    const sw = loadSw({ fetch: async () => Promise.reject(new TypeError("offline")) });
    const { done } = click(sw, { url: "/calendar", notificationId: "clx1" });
    await expect(done).resolves.toBeDefined();
    expect(sw.clients.openWindow).toHaveBeenCalledWith("/calendar");
  });

  it("an existing dashboard tab is focused and navigated, as before", async () => {
    const tab = { url: "https://box.local/home", focus: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) };
    const sw = loadSw({ windows: [tab] });
    await click(sw, { url: "/calendar", notificationId: "clx1" }).done;
    expect(tab.focus).toHaveBeenCalled();
    expect(tab.navigate).toHaveBeenCalledWith("/calendar");
    expect(sw.clients.openWindow).not.toHaveBeenCalled();
    expect(sw.fetchSpy).toHaveBeenCalledTimes(1);
  });
});
