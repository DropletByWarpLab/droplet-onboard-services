/**
 * WARP-1294 — EaglesoftApiConnector, fetch-mocked (no live server, no secrets,
 * inherently offline). Pins: honest-blocked-by-default (no route map / no
 * creds), the Authenticate → session-token → header handshake, the
 * get_schedule_today read mapped to the SAME canonical row keys the SQL track
 * returns, shared-registry validation, and secret hygiene.
 *
 * The route templates + field names in the fixture map are SYNTHETIC stand-ins
 * for what a live /help discovery yields — not the real Patterson contract.
 */
import { describe, it, expect, vi } from "vitest";
import { EaglesoftApiConnector } from "../src/api-connector.js";
import { ConnectorBlockedError } from "../src/connector.js";
import { UnknownReadQueryError } from "../src/read-queries.js";
import { UnknownWriteCommandError } from "../src/write-commands.js";
import { KNOWN_ROUTE_SKELETON, type EaglesoftApiRouteMap } from "../src/api-route-map.js";
import { type ResolvedCredentials } from "../src/api-auth.js";

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(""),
    headers: new Headers(),
  } as unknown as Response;
}

function errResponse(status: number, body: unknown = {}): Response {
  return {
    ok: false,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(""),
    headers: new Headers(),
  } as unknown as Response;
}

const creds: ResolvedCredentials = { integrationKey: "vendor-key", userId: "provider1", password: "pw" };
const resolveSecret = async () => creds;

/** A route map with authenticate + get_schedule_today discovered; the other
 *  reads/writes stay as the undiscovered skeleton (→ must block, never guess). */
function discoveredMap(): EaglesoftApiRouteMap {
  return {
    authenticate: {
      controller: "Authentication",
      method: "Authenticate",
      verb: "POST",
      template: "/api/authenticate",
      tokenPath: "SessionToken",
    },
    reads: {
      ...KNOWN_ROUTE_SKELETON.reads,
      get_schedule_today: {
        controller: "Schedule",
        method: "GetAppointmentsByDateRange",
        verb: "GET",
        template: "/api/schedule/range",
        listPath: "Appointments",
        params: { from: "startDate", to: "endDate" },
        fields: {
          appt_id: "AppointmentId",
          appt_time: "StartTime",
          provider_id: "ProviderId",
          operatory_id: "OperatoryId",
          status: "Status",
          patient_id: "PatientId",
        },
      },
    },
    writes: { ...KNOWN_ROUTE_SKELETON.writes },
  };
}

function config(routeMap?: EaglesoftApiRouteMap) {
  return {
    host: "eaglesoft.example",
    httpsPort: 9888,
    credentialsSecretRef: "secret://erp/eaglesoft-api/creds",
    routeMap,
  };
}

describe("EaglesoftApiConnector", () => {
  it("is the eaglesoft-api provider", () => {
    expect(new EaglesoftApiConnector(config()).provider).toBe("eaglesoft-api");
  });

  it("blocks connect() when the route map is not discovered", async () => {
    await expect(
      new EaglesoftApiConnector(config(), { resolveSecret }).connect(),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("blocks connect() when credentials cannot be resolved (default resolver)", async () => {
    await expect(new EaglesoftApiConnector(config(discoveredMap())).connect()).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
  });

  it("authenticates, then attaches the session token + mapped query on a read", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ SessionToken: "sess-123" }))
      .mockResolvedValueOnce(
        okResponse({
          Appointments: [
            { AppointmentId: "a2", StartTime: "2026-07-12T10:00:00Z", ProviderId: "pr1", OperatoryId: "op1", Status: "scheduled", PatientId: "p2" },
            { AppointmentId: "a1", StartTime: "2026-07-12T09:00:00Z", ProviderId: "pr1", OperatoryId: "op1", Status: "scheduled", PatientId: "p1" },
          ],
        }),
      );
    const c = new EaglesoftApiConnector(config(discoveredMap()), { resolveSecret, fetchImpl });

    await c.connect();
    expect(await c.health()).toEqual({ ok: true });

    const rows = (await c.runRead("get_schedule_today", {
      from: "2026-07-12T00:00:00.000Z",
      to: "2026-07-13T00:00:00.000Z",
    })) as Record<string, unknown>[];

    // (1) auth handshake first: POST the Authenticate route with a timeout signal
    const authCall = fetchImpl.mock.calls[0];
    expect(String(authCall[0])).toContain("/api/authenticate");
    expect(authCall[1].method).toBe("POST");
    expect(authCall[1].signal).toBeInstanceOf(AbortSignal);

    // (2) the read carries the session token + the DISCOVERED query names
    const readCall = fetchImpl.mock.calls[1];
    expect(String(readCall[0])).toContain("/api/schedule/range");
    expect(String(readCall[0])).toContain("startDate=");
    expect(String(readCall[0])).toContain("endDate=");
    expect((readCall[1].headers as Record<string, string>).Authorization).toBe("sess-123");

    // (3) rows carry EXACTLY the canonical keys, sorted by appt_time
    expect(Object.keys(rows[0]).sort()).toEqual([
      "appt_id",
      "appt_time",
      "operatory_id",
      "patient_id",
      "provider_id",
      "status",
    ]);
    expect(rows.map((r) => r.appt_id)).toEqual(["a1", "a2"]);
  });

  it("throws UnknownReadQueryError for an unregistered read name", async () => {
    const c = new EaglesoftApiConnector(config(discoveredMap()), { resolveSecret });
    await expect(c.runRead("nope", {})).rejects.toBeInstanceOf(UnknownReadQueryError);
  });

  it("blocks a registered-but-undiscovered read route (never a guessed request)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse({ SessionToken: "s" }));
    const c = new EaglesoftApiConnector(config(discoveredMap()), { resolveSecret, fetchImpl });
    await c.connect();
    await expect(c.runRead("find_patient", { query: "smith" })).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
    // only the auth call went out — no guessed find_patient request
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("defers writes honestly (blocked, never a fake APPLIED)", async () => {
    const c = new EaglesoftApiConnector(config(discoveredMap()), { resolveSecret });
    await expect(
      c.applyWrite("reschedule_appointment", { appt_id: "a1", last_modified: "t", appt_time: "t2" }),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("throws UnknownWriteCommandError for an unregistered write name", async () => {
    const c = new EaglesoftApiConnector(config(discoveredMap()), { resolveSecret });
    await expect(c.applyWrite("nope", {})).rejects.toBeInstanceOf(UnknownWriteCommandError);
  });

  // Honest-degradation guarantees: every transport failure must surface as
  // ConnectorBlockedError so the orchestrator degrades (connect → PROVISIONING,
  // read → ERP_NOT_CONNECTED) and NEVER fakes CONNECTED / leaks a raw error.
  it("maps a non-2xx auth response (401) to ConnectorBlockedError — connect never fakes CONNECTED", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(errResponse(401));
    await expect(
      new EaglesoftApiConnector(config(discoveredMap()), { resolveSecret, fetchImpl }).connect(),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("maps a non-2xx read response (500) to ConnectorBlockedError — read degrades to ERP_NOT_CONNECTED", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ SessionToken: "s" }))
      .mockResolvedValueOnce(errResponse(500));
    const c = new EaglesoftApiConnector(config(discoveredMap()), { resolveSecret, fetchImpl });
    await c.connect();
    await expect(
      c.runRead("get_schedule_today", {
        from: "2026-07-12T00:00:00.000Z",
        to: "2026-07-13T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("maps a network/timeout error to ConnectorBlockedError", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("ETIMEDOUT"));
    await expect(
      new EaglesoftApiConnector(config(discoveredMap()), { resolveSecret, fetchImpl }).connect(),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("blocks connect() when auth returns 200 but no session token — never a fake CONNECTED", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse({ notAToken: true }));
    await expect(
      new EaglesoftApiConnector(config(discoveredMap()), { resolveSecret, fetchImpl }).connect(),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("never serializes a secret in its config (pointer only)", () => {
    const cfg = config(discoveredMap());
    expect(JSON.stringify(cfg)).not.toMatch(/serialkey|clientid|password/i);
    expect(cfg.credentialsSecretRef.startsWith("secret://")).toBe(true);
  });
});
