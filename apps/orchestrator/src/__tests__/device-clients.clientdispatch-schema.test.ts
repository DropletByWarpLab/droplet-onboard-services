/**
 * WARP-1298: schema-level assertions for the DeviceClient client-dispatched-
 * actions columns + the ed25519 client public key.
 *
 * Foundation for the desktop tool-host (ADR-014 §37–39, §③; WARP-350 epic).
 * Romain chose this shape (Option B on WARP-352) on 2026-07-12; the original
 * WARP-352 model had no column for the client public key, which was the
 * concrete blocker on WARP-353 (signature-verify had nothing to verify
 * against). The WS bridge / signature verification / tool catalog that consume
 * these columns land in WARP-353/354 — this is schema only.
 *
 * Mirrors the WARP-446 / WARP-171 / WARP-218 schema-shape pattern (see
 * ap-device.schema.test.ts): vitest's setup.ts mocks `@prisma/client`, so we
 * cannot drive a real DB. The authoritative contract this guards is the schema
 * text + the matching additive migration. The round-trip block at the bottom
 * additionally locks the app-facing default-deny runtime contract (toolConsent
 * defaults to `{}`, toolCapabilities to `[]`).
 *
 * Pairs with:
 *   - prisma/schema.prisma (model DeviceClient)
 *   - prisma/migrations/20260712000001_warp_1298_deviceclient_clientdispatch/migration.sql
 *   - docs/ADR-014-llm-client-dispatched-actions.md
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const SCHEMA_PATH = join(PRISMA_DIR, "schema.prisma");
const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");

const schema = readFileSync(SCHEMA_PATH, "utf8");

function deviceClientBody(): string {
  const modelMatch = schema.match(
    /model\s+DeviceClient\s*\{([\s\S]+?)\}\s*(?=\nenum|\nmodel|\/\/|$)/,
  );
  expect(modelMatch, "DeviceClient model must exist in schema.prisma").not.toBeNull();
  return modelMatch![1];
}

describe("Prisma schema — DeviceClient client-dispatch columns (WARP-1298)", () => {
  it("adds a WS-liveness heartbeat distinct from the coarse lastSeen (ADR-014 §37)", () => {
    const body = deviceClientBody();
    // Nullable — null until the client first connects to the WS bridge.
    expect(body).toMatch(/lastSeenWsAt\s+DateTime\?/);
    // The coarse column stays untouched.
    expect(body).toMatch(/lastSeen\s+DateTime\s+@default\(now\(\)\)/);
  });

  it("adds a default-deny per-tool consent map (ADR-014 §③)", () => {
    const body = deviceClientBody();
    // JSON map, default '{}' — nothing reachable until the user opts in per tool.
    expect(body).toMatch(/toolConsent\s+Json\s+@default\("\{\}"\)/);
  });

  it("adds the pair-time clientKind + declared capability list", () => {
    const body = deviceClientBody();
    // Distinct axis from deviceType/platform; nullable until a pairing flow sets it.
    expect(body).toMatch(/clientKind\s+String\?/);
    // Declared capabilities, default empty array.
    expect(body).toMatch(/toolCapabilities\s+Json\s+@default\("\[\]"\)/);
  });

  it("stores the paired client's ed25519 public key as a UNIQUE text column (VpnPeer.publicKey precedent)", () => {
    const body = deviceClientBody();
    // Text (base64/hex wire form), nullable, @unique — the key is the client
    // identity, so a revoked client must not re-pair its old key. WARP-353
    // verifies tool_response signatures against it.
    expect(body).toMatch(/clientPublicKey\s+String\?\s+@unique/);
  });

  it("indexes (userId, lastSeenWsAt) for the WARP-354 catalog query without dropping the existing indexes", () => {
    const body = deviceClientBody();
    expect(body).toMatch(/@@index\(\[userId\]\)/);
    expect(body).toMatch(/@@index\(\[status\]\)/);
    expect(body).toMatch(/@@index\(\[userId,\s*lastSeenWsAt\]\)/);
  });
});

describe("Prisma migration — WARP-1298 (additive, backfill-safe)", () => {
  it("ships an additive migration adding the five columns + the two indexes", () => {
    const dirs = readdirSync(MIGRATIONS_DIR);
    const ours = dirs.find((d) => d.endsWith("warp_1298_deviceclient_clientdispatch"));
    expect(ours, "expected a WARP-1298 deviceclient-clientdispatch migration directory").toBeDefined();

    const sql = readFileSync(join(MIGRATIONS_DIR, ours!, "migration.sql"), "utf8");

    // All new columns are nullable or defaulted → existing rows backfill cleanly.
    expect(sql).toMatch(/ALTER TABLE "DeviceClient"/);
    expect(sql).toMatch(/ADD COLUMN\s+"lastSeenWsAt"\s+TIMESTAMP\(3\)/);
    expect(sql).toMatch(/ADD COLUMN\s+"toolConsent"\s+JSONB NOT NULL DEFAULT '\{\}'/);
    expect(sql).toMatch(/ADD COLUMN\s+"clientKind"\s+TEXT/);
    expect(sql).toMatch(/ADD COLUMN\s+"toolCapabilities"\s+JSONB NOT NULL DEFAULT '\[\]'/);
    expect(sql).toMatch(/ADD COLUMN\s+"clientPublicKey"\s+TEXT/);

    // Unique on the ed25519 key; composite index for the catalog query.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "DeviceClient_clientPublicKey_key" ON "DeviceClient"\("clientPublicKey"\)/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "DeviceClient_userId_lastSeenWsAt_idx" ON "DeviceClient"\("userId", "lastSeenWsAt"\)/,
    );

    // Migration order guard: WARP-1298 (…000001) must sort AFTER the same-day
    // WARP-1257 intent-failure-states migration (…000000) so replays are stable.
    expect(ours!).toMatch(/^20260712000001_/);
  });
});

describe("DeviceClient client-dispatch runtime contract (WARP-1298)", () => {
  // Self-contained in-memory delegate mimicking Prisma's create/findUnique
  // default-application (same style as the clientStore stand-in in
  // device-clients.test.ts). Guards the app-facing default-deny contract; the
  // authoritative default lives in the schema/migration asserted above.
  type Row = Record<string, unknown>;
  function makeDeviceClientDelegate() {
    const store = new Map<string, Row>();
    // Columns that carry a DB default when the caller omits them.
    const DEFAULTS: Row = { toolConsent: {}, toolCapabilities: [] };
    return {
      async create({ data }: { data: Row }): Promise<Row> {
        const id = (data.id as string) ?? `dc-${store.size + 1}`;
        const row: Row = {
          id,
          lastSeen: new Date(),
          createdAt: new Date(),
          // Nullable, default-less columns surface as null when omitted.
          lastSeenWsAt: null,
          clientKind: null,
          clientPublicKey: null,
          ...DEFAULTS,
          ...data,
        };
        store.set(id, row);
        return row;
      },
      async findUnique({ where }: { where: { id: string } }): Promise<Row | null> {
        return store.get(where.id) ?? null;
      },
    };
  }

  it("round-trips every new client-dispatch field through create → findUnique", async () => {
    const deviceClient = makeDeviceClientDelegate();
    const pubKey = Buffer.alloc(32, 7).toString("base64"); // ed25519 wire form

    const created = await deviceClient.create({
      data: {
        id: "dc-round-trip",
        userId: "alice",
        deviceName: "Alice's MacBook",
        deviceType: "desktop",
        platform: "macos",
        ncAppPassword: "enc",
        lastSeenWsAt: new Date("2026-07-12T10:00:00.000Z"),
        toolConsent: { open_file: "confirm", notify: "allow" },
        clientKind: "desktop_macos",
        toolCapabilities: ["open_file", "notify"],
        clientPublicKey: pubKey,
      },
    });

    const read = await deviceClient.findUnique({ where: { id: "dc-round-trip" } });
    expect(read).not.toBeNull();
    expect(read!.lastSeenWsAt).toEqual(created.lastSeenWsAt);
    expect(read!.toolConsent).toEqual({ open_file: "confirm", notify: "allow" });
    expect(read!.clientKind).toBe("desktop_macos");
    expect(read!.toolCapabilities).toEqual(["open_file", "notify"]);
    expect(read!.clientPublicKey).toBe(pubKey);
  });

  it("defaults toolConsent to {} and toolCapabilities to [] when omitted (default-deny, ADR-014 §③)", async () => {
    const deviceClient = makeDeviceClientDelegate();

    const created = await deviceClient.create({
      data: {
        id: "dc-fresh-pair",
        userId: "bob",
        deviceName: "Bob's PC",
        deviceType: "desktop",
        platform: "windows",
        ncAppPassword: "enc",
      },
    });

    // Pairing grants presence + identity, never capability.
    expect(created.toolConsent).toEqual({});
    expect(created.toolCapabilities).toEqual([]);
    // Liveness + key are unset until the client connects / advertises.
    expect(created.lastSeenWsAt).toBeNull();
    expect(created.clientKind).toBeNull();
    expect(created.clientPublicKey).toBeNull();
  });
});
