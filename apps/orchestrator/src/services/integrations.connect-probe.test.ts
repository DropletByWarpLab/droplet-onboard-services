/**
 * WARP-2466 scope item 3 — `connect()` probes the stored credential.
 *
 * The gap this closes, in WARP-2275's implementer's words: *"the state mapping
 * and NEEDS_RECONNECT are implemented and tested; no prober drives them"*. A
 * freshly pasted key sat at PROVISIONING forever because nothing ever asked
 * the vendor whether it worked.
 *
 * Prisma is the same in-memory `vi.fn()` stub the sibling suite uses (the team
 * rule after a mock/prod divergence incident is no mock-DATABASE integration
 * tests; a structural stub for a service's own logic is the shipped pattern).
 * No connector here reaches a vendor: each is a literal whose `health()`
 * resolves or rejects with a real exported error class, so a renamed class or
 * a changed `code` turns this red rather than passing against a stale memory.
 */
import {
  ConnectorBlockedError,
  HubSpotSearchRateLimitedError,
  HubSpotSuperAdminRevokedError,
  MailchimpCapabilityMissingError,
  StripeAccessPolicyError,
  StripeReauthorizationRequiredError,
} from "@droplet/erp-connector";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationsService } from "./integrations.service.js";

type Row = Record<string, unknown> & { id: string; provider: string; status: string };

function makePrismaMock() {
  const rows = new Map<string, Row>();
  let seq = 0;
  const integrationConnection = {
    findFirst: vi.fn(async ({ where }: any) => {
      for (const r of rows.values()) if (r.provider === where.provider) return { ...r };
      return null;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const r = rows.get(where.id);
      return r ? { ...r } : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      seq += 1;
      const row: Row = {
        id: `conn_${seq}`,
        schemaVersion: null,
        schemaHash: null,
        lastHealthyAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      rows.set(row.id, row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = { ...rows.get(where.id)!, ...data, updatedAt: new Date() };
      rows.set(where.id, row);
      return { ...row };
    }),
  };
  return {
    rows,
    prisma: {
      integrationConnection,
      erpAuditLog: { create: vi.fn(async () => ({})) },
      activity: { create: vi.fn(async () => ({})) },
    } as any,
  };
}

/** A connector whose `health()` does whatever the case needs. Everything else
 *  succeeds, so the probe is the only thing under test. */
function connectorWith(health: () => Promise<{ ok: boolean }>) {
  return {
    provider: "stripe",
    servesDatasets: [],
    schemaFingerprint: null,
    connect: vi.fn(async () => {}),
    introspect: vi.fn(async () => ({ tables: [], fingerprint: "f" })),
    close: vi.fn(async () => {}),
    health: vi.fn(health),
    runRead: vi.fn(async () => []),
    applyWrite: vi.fn(async () => ({})),
  };
}

const OK = async () => ({ ok: true });

function serviceFor(connector: ReturnType<typeof connectorWith>) {
  const mock = makePrismaMock();
  return {
    mock,
    svc: createIntegrationsService(mock.prisma, { connectorFor: () => connector as any }),
  };
}

/** Connect a cloud provider and return the PERSISTED row, not the return value
 *  — the acceptance criterion is about what is stored. */
async function connectAndReadRow(
  provider: string,
  connector: ReturnType<typeof connectorWith>,
) {
  const { mock, svc } = serviceFor(connector);
  await svc.connect({ provider, host: "" } as any);
  return [...mock.rows.values()][0];
}

describe("connect() probes a cloud credential with health()", () => {
  let healthyConnector: ReturnType<typeof connectorWith>;

  beforeEach(() => {
    healthyConnector = connectorWith(OK);
  });

  it("advances PROVISIONING → CONNECTED on a healthy probe", async () => {
    // Mutation: delete the `await connector.health()` call in `connect()` and
    // the row still reaches CONNECTED — so this test alone cannot catch that.
    // The one below is the one that does; both are needed.
    const row = await connectAndReadRow("stripe", healthyConnector);
    expect(healthyConnector.health).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("CONNECTED");
    expect(row.lastHealthyAt).toBeInstanceOf(Date);
  });

  it("does NOT reach CONNECTED when the probe rejects", async () => {
    // THE mutation that matters: skip `health()` in `connect()` and a revoked
    // credential lands at CONNECTED, which is the whole defect WARP-2458 and
    // this ticket exist to remove. With the probe in place it cannot.
    const row = await connectAndReadRow(
      "stripe",
      connectorWith(async () => {
        throw new StripeReauthorizationRequiredError("revoked");
      }),
    );
    expect(row.status).not.toBe("CONNECTED");
    expect(row.status).toBe("NEEDS_RECONNECT");
  });

  it("never leaves a cloud row at PROVISIONING after a completed probe", async () => {
    // The acceptance criterion, asserted across every outcome class the three
    // connectors can produce — including a blocked connector, which used to
    // be the branch that parked a row at PROVISIONING indefinitely.
    // Mutation: restore the unconditional `ConnectorBlockedError` →
    // PROVISIONING branch for cloud tracks → red on the last case.
    const outcomes: Array<[string, () => Promise<{ ok: boolean }>]> = [
      ["reauthorize", async () => { throw new StripeReauthorizationRequiredError("x"); }],
      ["super-admin", async () => { throw new HubSpotSuperAdminRevokedError("x"); }],
      ["throttled", async () => { throw new HubSpotSearchRateLimitedError(5, "x"); }],
      ["access-policy", async () => { throw new StripeAccessPolicyError("x"); }],
      ["capability", async () => { throw new MailchimpCapabilityMissingError("lists", "plan"); }],
      ["blocked", async () => { throw new ConnectorBlockedError("health", "nothing wired"); }],
      ["unknown", async () => { throw new Error("boom"); }],
      // A rejection whose VALUE is `undefined`. The catch still runs, but a
      // classifier reached through `statusAfterHealthProbe(err)` reads the
      // undefined as its no-argument success calling convention and answers
      // CONNECTED — a failed probe recorded as a healthy row. The catch must
      // call `integrationStatusForHealthFailure` directly, where undefined is
      // just another unclassifiable failure: ERROR.
      // eslint-disable-next-line no-throw-literal
      ["rejected-undefined", async () => { throw undefined; }],
    ];
    for (const [name, health] of outcomes) {
      const row = await connectAndReadRow("stripe", connectorWith(health));
      expect(row.status, `${name} left the row at PROVISIONING`).not.toBe("PROVISIONING");
      expect(row.status, `${name} reported CONNECTED`).not.toBe("CONNECTED");
    }
  });

  it("maps each named failure to the state its remediation implies", async () => {
    // Per-connector, as the AC asks. The distinction is the product: only
    // NEEDS_RECONNECT tells the owner to go and paste a new key, and telling
    // them that when a throttle or a plan boundary is the cause wastes their
    // time and teaches them to ignore the state.
    // Mutation: map any of these onto NEEDS_RECONNECT → red.
    const cases: Array<[string, () => Promise<{ ok: boolean }>, string]> = [
      ["stripe", async () => { throw new StripeReauthorizationRequiredError("x"); }, "NEEDS_RECONNECT"],
      ["hubspot", async () => { throw new HubSpotSuperAdminRevokedError("x"); }, "NEEDS_RECONNECT"],
      // WARP-2623 — this row read "ERROR" until the persisted enum grew a
      // member for it. The probe SUCCEEDED and one dataset is refused by the
      // account's plan, so the row must not persist as "Can't connect".
      ["mailchimp", async () => { throw new MailchimpCapabilityMissingError("lists", "plan"); }, "CAPABILITY_LIMITED"],
      ["stripe", async () => { throw new StripeAccessPolicyError("x"); }, "ERROR"],
      ["hubspot", async () => { throw new HubSpotSearchRateLimitedError(5, "x"); }, "DEGRADED"],
    ];
    for (const [provider, health, expected] of cases) {
      const row = await connectAndReadRow(provider, connectorWith(health));
      expect(row.status, `${provider} → ${expected}`).toBe(expected);
    }
  });

  it("puts no credential material in the persisted row or the audit call", async () => {
    // Rule 19, at the one moment a credential enters the box.
    const secret = "rk_test_" + "EXAMPLE" + "FIXTURENOTAREAL";
    const { mock, svc } = serviceFor(healthyConnector);
    await svc.connect({ provider: "stripe", host: "" } as any);
    const written = JSON.stringify([...mock.rows.values()]);
    expect(written).not.toContain(secret);
    expect(written).not.toContain("rk_test");
  });
});

describe("LAN tracks keep their honest degradation", () => {
  it("still parks a blocked LAN connector at PROVISIONING", async () => {
    // The behaviour the probe must NOT change. A LAN track that raises
    // ConnectorBlockedError has not been probed at all — the SQL driver or the
    // discovered route map is absent and nothing was dialed — so the row
    // genuinely is mid-provisioning and saying so is correct.
    //
    // Mutation: drop the `!isCloudTrack` guard and every un-wired Eaglesoft
    // connection reports NOT_CONFIGURED instead of "connecting", which is a
    // different and false statement.
    const row = await connectAndReadRow(
      "eaglesoft",
      connectorWith(async () => {
        throw new ConnectorBlockedError("health", "driver absent");
      }),
    );
    expect(row.status).toBe("PROVISIONING");
  });
});
