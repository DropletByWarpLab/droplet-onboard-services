/**
 * WARP-3532 — the Work notifications API client: which route each call hits, what
 * it sends, and how a refusal reaches the page (as the box's own sentence).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  WorkWebhookError,
  createWorkWebhook,
  deleteWorkWebhook,
  fetchWebhookScopeProjects,
  fetchWorkWebhookDeliveries,
  fetchWorkWebhooks,
  redeliverWorkWebhook,
  rotateWorkWebhookSecret,
  testWorkWebhook,
  updateWorkWebhook,
} from "./api.work-webhooks";
import { fetchRemoteMcpChannel, fetchWorkIntegrationsChannel, setRemoteMcpChannel, setWorkIntegrationsChannel } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({ authFetch: vi.fn() }));
const authFetchMock = vi.mocked(authFetch);

function res(status: number, json: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(json) } as unknown as Response;
}

beforeEach(() => authFetchMock.mockReset());

const lastCall = () => {
  const [url, init] = authFetchMock.mock.calls.at(-1)! as [string, RequestInit | undefined];
  return { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers };
};

describe("requests", () => {
  it("lists webhooks and the event catalog", async () => {
    authFetchMock.mockResolvedValue(res(200, { webhooks: [], events: [] }));
    expect(await fetchWorkWebhooks()).toEqual({ webhooks: [], events: [] });
    expect(lastCall()).toMatchObject({ url: "/api/pm/webhooks", method: "GET" });
  });

  it("creates with a JSON body and returns the secret the box returned", async () => {
    authFetchMock.mockResolvedValue(res(201, { webhook: { id: "h" }, secret: "whsec_x" }));
    const input = { name: "n", url: "https://x.test/a", format: "SLACK" as const, events: ["work_item.created"], projectId: null };
    expect(await createWorkWebhook(input)).toEqual({ webhook: { id: "h" }, secret: "whsec_x" });
    expect(lastCall()).toMatchObject({ url: "/api/pm/webhooks", method: "POST", body: input });
    expect(lastCall().headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("patches, with exactly what it was given", async () => {
    authFetchMock.mockResolvedValue(res(200, { webhook: { id: "h" } }));
    await updateWorkWebhook("h 1", { enabled: false });
    expect(lastCall()).toMatchObject({ url: "/api/pm/webhooks/h%201", method: "PATCH", body: { enabled: false } });
  });

  it("deletes, and treats the empty 204 as success", async () => {
    authFetchMock.mockResolvedValue(res(204));
    await expect(deleteWorkWebhook("h")).resolves.toBeUndefined();
    expect(lastCall()).toMatchObject({ url: "/api/pm/webhooks/h", method: "DELETE" });
  });

  it("rotates, tests and re-delivers through their own routes", async () => {
    authFetchMock.mockResolvedValue(res(200, { webhook: {}, secret: "whsec_new", delivery: {} }));
    await rotateWorkWebhookSecret("h");
    expect(lastCall()).toMatchObject({ url: "/api/pm/webhooks/h/rotate-secret", method: "POST" });
    await testWorkWebhook("h");
    expect(lastCall()).toMatchObject({ url: "/api/pm/webhooks/h/test", method: "POST" });
    await redeliverWorkWebhook("h", "d/1");
    expect(lastCall()).toMatchObject({ url: "/api/pm/webhooks/h/deliveries/d%2F1/redeliver", method: "POST" });
  });

  it("pages the delivery log with a limit and an optional cursor", async () => {
    authFetchMock.mockResolvedValue(res(200, { deliveries: [], nextCursor: null }));
    await fetchWorkWebhookDeliveries("h");
    expect(lastCall().url).toBe("/api/pm/webhooks/h/deliveries?limit=25");
    await fetchWorkWebhookDeliveries("h", "2026-10-04T12:00:00.000Z|d-1");
    expect(lastCall().url).toBe("/api/pm/webhooks/h/deliveries?limit=25&cursor=2026-10-04T12%3A00%3A00.000Z%7Cd-1");
  });

  it("offers projects to scope to, keeping only what the picker needs", async () => {
    authFetchMock.mockResolvedValue(res(200, { projects: [{ id: "p", name: "Eng", identifier: "ENG", leadId: "u", extra: 1 }] }));
    expect(await fetchWebhookScopeProjects()).toEqual([{ id: "p", name: "Eng", identifier: "ENG" }]);
    authFetchMock.mockResolvedValue(res(200, {}));
    expect(await fetchWebhookScopeProjects()).toEqual([]);
  });
});

describe("failures", () => {
  it("surface the box's own sentence, with the status and code", async () => {
    authFetchMock.mockResolvedValue(res(400, { error: "blocked_destination", message: "That address can't be used." }));
    const err = await createWorkWebhook({ name: "n", url: "x", format: "JSON", events: ["e"], projectId: null }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkWebhookError);
    expect(err).toMatchObject({ message: "That address can't be used.", status: 400, code: "blocked_destination" });
  });

  it("fall back to a plain sentence that names the status, never the response body", async () => {
    authFetchMock.mockResolvedValue(res(500, { error: "internal", stack: "secret detail" }));
    const err = await fetchWorkWebhooks().catch((e) => e);
    expect(err.message).toBe("That didn’t work (500). Try again in a moment.");
    expect(err.message).not.toContain("secret detail");
    expect(err.code).toBe("internal");
  });

  it("survive a body that is not JSON", async () => {
    authFetchMock.mockResolvedValue({ ok: false, status: 502, json: vi.fn().mockRejectedValue(new Error("not json")) } as unknown as Response);
    const err = await fetchWorkWebhooks().catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: null });
  });
});

describe("the work_integrations switch", () => {
  it("reads the channel's state out of the off-LAN list, and says null when it cannot tell", async () => {
    authFetchMock.mockResolvedValue(res(200, { channels: [{ key: "place_lookup", enabled: true }, { key: "work_integrations", enabled: false }] }));
    expect(await fetchWorkIntegrationsChannel()).toEqual({ enabled: false });
    authFetchMock.mockResolvedValue(res(200, { channels: [{ key: "place_lookup", enabled: true }] }));
    expect(await fetchWorkIntegrationsChannel()).toBeNull();
    authFetchMock.mockResolvedValue(res(503));
    expect(await fetchWorkIntegrationsChannel()).toBeNull();
  });

  it("flips it with a reason, as the box requires, and throws with the status when refused", async () => {
    authFetchMock.mockResolvedValue(res(200));
    await setWorkIntegrationsChannel(true);
    const call = lastCall();
    expect(call).toMatchObject({ url: "/api/settings/off-lan/work_integrations", method: "PATCH" });
    expect(call.body).toEqual({ enabled: true, reason: "Turned on from Work notifications" });
    authFetchMock.mockResolvedValue(res(403));
    await expect(setWorkIntegrationsChannel(false)).rejects.toMatchObject({ status: 403 });
  });
});

describe("the remote_mcp switch (WARP-3912)", () => {
  it("reads the channel and PATCHes remote_mcp with a reason", async () => {
    authFetchMock.mockResolvedValue(res(200, { channels: [{ key: "remote_mcp", enabled: true }] }));
    expect(await fetchRemoteMcpChannel()).toEqual({ enabled: true });
    authFetchMock.mockResolvedValue(res(200));
    await setRemoteMcpChannel(false);
    const call = lastCall();
    expect(call).toMatchObject({ url: "/api/settings/off-lan/remote_mcp", method: "PATCH" });
    expect(call.body).toEqual({ enabled: false, reason: "Turned off from Connector credentials" });
    authFetchMock.mockResolvedValue(res(403));
    await expect(setRemoteMcpChannel(true)).rejects.toMatchObject({ status: 403 });
  });
});
