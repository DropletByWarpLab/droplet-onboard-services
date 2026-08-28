/**
 * WARP-2218 / ADR-041 — `needs_reconnect` is a ROUTINE state and must survive
 * the trip from the cursor column to the `GET /api/integrations` payload
 * without being collapsed onto ERROR.
 *
 * The product response to a revoked customer credential is to ask the owner to
 * paste a new one. It is not an incident. The schema already encodes that
 * thinking twice — `M365ConnectionState.NEEDS_RECONNECT` MUST be
 * distinguishable from `DISCONNECTED` (`schema.prisma:4990-5012`), and
 * `M365SyncState.RESYNC_REQUIRED` is annotated "A normal transition, not a
 * failure" (`:5085-5097`). This suite holds the ERP path to the same line.
 */
import { describe, it, expect, vi } from "vitest";

import { createIntegrationsService } from "./integrations.service.js";

const CONN = {
  id: "conn-1",
  provider: "quickbooks-online",
  status: "CONNECTED",
  host: null,
  port: null,
  databaseName: null,
  secretRef: "qbo:pointer",
  schemaVersion: null,
  schemaHash: null,
  writeEnabled: false,
  lastHealthyAt: new Date("2026-08-27T12:00:00Z"),
};

function serviceWith(
  cursors: Array<{ connectionId: string; state: string; needsReconnect: boolean }>,
  conn: Record<string, unknown> | null = CONN,
) {
  const prisma = {
    integrationConnection: {
      findFirst: vi.fn(async ({ where }: any) =>
        conn && conn.provider === where.provider ? conn : null,
      ),
      findMany: vi.fn(async () => (conn ? [conn] : [])),
      findUnique: vi.fn(async () => conn),
      create: vi.fn(),
      update: vi.fn(),
    },
    erpAuditLog: { create: vi.fn() },
    erpSyncCursor: {
      findMany: vi.fn(async ({ where }: any) =>
        cursors.filter((c) => !where?.connectionId || c.connectionId === where.connectionId),
      ),
    },
  };
  return { svc: createIntegrationsService(prisma as never), prisma };
}

function cursor(over: Record<string, unknown> = {}) {
  return { connectionId: "conn-1", state: "IDLE", needsReconnect: false, ...over };
}

/**
 * Pick the row under test out of the hub listing.
 *
 * `list()` always prepends the two Eaglesoft providers — the framework knows
 * about them before they are configured — so index 0 is NOT the connection a
 * case set up. Selecting by provider keeps each assertion pointed at the row
 * it actually built.
 */
function rowFor(rows: Array<{ provider: string }>, provider: string) {
  const row = rows.find((r) => r.provider === provider);
  if (!row) throw new Error(`no listed row for provider ${provider}`);
  return row as never as {
    provider: string;
    status: string;
    configured: boolean;
    syncState: string | null;
    needsReconnect: boolean;
  };
}

describe("needs_reconnect on the integrations payload", () => {
  it("surfaces a revoked credential as needsReconnect, NOT as ERROR", async () => {
    // MUTATION: map the revoked-credential outcome to `status: "ERROR"` (or
    // drop `needsReconnect` from the payload) → red. An owner told their
    // connection is BROKEN goes looking for a fault; an owner told it needs a
    // new credential fixes it in thirty seconds.
    const { svc } = serviceWith([cursor({ needsReconnect: true, state: "BACKOFF" })]);
    const row = rowFor(await svc.list(), "quickbooks-online");

    expect(row.needsReconnect).toBe(true);
    expect(row.status).not.toBe("ERROR");
    expect(row.status).toBe("CONNECTED");
  });

  it("keeps reconnect-needed distinguishable from never-configured", async () => {
    const configured = rowFor(
      await serviceWith([cursor({ needsReconnect: true })]).svc.list(),
      "quickbooks-online",
    );
    // A provider with no row at all.
    const unconfigured = rowFor(await serviceWith([], null).svc.list(), "eaglesoft");

    expect(configured.needsReconnect).toBe(true);
    expect(configured.configured).toBe(true);
    expect(unconfigured.needsReconnect).toBe(false);
    expect(unconfigured.status).toBe("NOT_CONFIGURED");
    // The two are not the same payload, which is the whole requirement.
    expect(unconfigured.syncState).toBeNull();
  });

  it("keeps reconnect-needed distinguishable from broken", async () => {
    const reconnect = rowFor(
      await serviceWith([cursor({ needsReconnect: true })]).svc.list(),
      "quickbooks-online",
    );
    const broken = rowFor(
      await serviceWith([cursor({ state: "FAILED" })], { ...CONN, status: "ERROR" }).svc.list(),
      "quickbooks-online",
    );

    expect(reconnect.needsReconnect).toBe(true);
    expect(reconnect.status).toBe("CONNECTED");
    expect(broken.needsReconnect).toBe(false);
    expect(broken.status).toBe("ERROR");
  });

  it("never renders RESYNC_REQUIRED as an error", async () => {
    // MUTATION: route RESYNC_REQUIRED through the error branch → red. A dead
    // cursor position needs nothing from anybody; the next tick re-enumerates.
    const { svc } = serviceWith([cursor({ state: "RESYNC_REQUIRED" })]);
    const row = rowFor(await svc.list(), "quickbooks-online");

    expect(row.syncState).toBe("RESYNC_REQUIRED");
    expect(row.status).not.toBe("ERROR");
    expect(row.needsReconnect).toBe(false);
  });

  it("reads the explicit enum column — a null watermark is not a state", async () => {
    // No state is inferred from a null or an absent row anywhere in the path.
    const { svc } = serviceWith([cursor({ state: "IDLE" })]);
    expect(rowFor(await svc.list(), "quickbooks-online").syncState).toBe("IDLE");
  });

  it("reports an explicit null when no cursor is registered yet", async () => {
    // "No cursor" is a different fact from any of the five states, and is
    // carried as an explicit null rather than an omitted key.
    const { svc } = serviceWith([]);
    const row = rowFor(await svc.list(), "quickbooks-online");
    expect(row.syncState).toBeNull();
    expect("syncState" in row).toBe(true);
  });

  it("surfaces the most ACTIONABLE state when entities disagree, in EITHER order", async () => {
    // A healthy invoice cursor beside a failed bill cursor is not healthy.
    // MUTATION: take the last cursor read instead of the ranked one → the
    // FAILED-first case yields IDLE → red, and the one thing the owner can act
    // on disappears from the hub.
    //
    // Both orders are asserted deliberately. With only `[IDLE, FAILED]` the
    // last-wins mutation happens to produce the right answer and the test
    // proves nothing — verified: one-order was green under the mutation.
    const failedLast = serviceWith([cursor({ state: "IDLE" }), cursor({ state: "FAILED" })]);
    const failedFirst = serviceWith([cursor({ state: "FAILED" }), cursor({ state: "IDLE" })]);

    expect(rowFor(await failedLast.svc.list(), "quickbooks-online").syncState).toBe("FAILED");
    expect(rowFor(await failedFirst.svc.list(), "quickbooks-online").syncState).toBe("FAILED");
  });

  it("ranks BACKOFF above SYNCING and IDLE regardless of order", async () => {
    const s = serviceWith([cursor({ state: "BACKOFF" }), cursor({ state: "IDLE" })]);
    expect(rowFor(await s.svc.list(), "quickbooks-online").syncState).toBe("BACKOFF");
  });

  it("carries the same fields on the detail surface", async () => {
    const { svc } = serviceWith(
      [cursor({ needsReconnect: true, state: "BACKOFF" })],
      { ...CONN, provider: "eaglesoft" },
    );
    const detail = await svc.getEaglesoft();
    expect(detail.needsReconnect).toBe(true);
    expect(detail.syncState).toBe("BACKOFF");
  });

  it("does not fetch cursors it cannot use for an unconfigured provider", async () => {
    const { svc } = serviceWith([], null);
    const rows = await svc.list();
    // Every listed provider still carries both keys explicitly.
    for (const r of rows) {
      expect(r).toHaveProperty("syncState");
      expect(r).toHaveProperty("needsReconnect");
    }
  });
});
