/**
 * Global test setup — mocks external services so unit tests run without
 * Postgres, Redis, MQTT, or the AI Gateway.
 */

import { vi } from "vitest";

// --- WARP-233: column-crypto test key ---
// The email blind index + dcv1 column encryption derive keys from
// DEVICE_SECRET_KEY at call time (auth login, SCIM provisioning, SSO linking
// all hash the email before touching prisma). Install a deterministic key via
// the module's own test seam — NOT process.env, which would silently satisfy
// encryption.test.ts's "no key configured" path through config.ts.
import { __setColumnCryptoKeyForTest } from "../services/column-crypto.service.js";
__setColumnCryptoKeyForTest(Buffer.alloc(32, 42).toString("base64"));

// --- Mock ioredis ---
// Disable caching in tests to avoid stale data between test cases
vi.mock("ioredis", () => {
  const RedisMock = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),    // Always cache miss
    set: vi.fn().mockResolvedValue("OK"),    // Accept but don't store
    del: vi.fn().mockResolvedValue(1),
    ping: vi.fn().mockResolvedValue("PONG"),
    disconnect: vi.fn(),
  }));
  return { default: RedisMock };
});

// --- Mock mqtt ---
vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn(() => ({
      on: vi.fn((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 10);
      }),
      connected: true,
      publish: vi.fn(),
      subscribe: vi.fn(),
    })),
  },
  connect: vi.fn(() => ({
    on: vi.fn((event: string, cb: Function) => {
      if (event === "connect") setTimeout(() => cb(), 10);
    }),
    connected: true,
    publish: vi.fn(),
    subscribe: vi.fn(),
  })),
}));

// --- Mock @prisma/client ---
// Minimal stand-in for `Prisma.PrismaClientKnownRequestError` — the
// service layer uses `instanceof` on it to translate P2025 into
// DeviceRegistryError.notFound (WARP-82 fix-up). Mirroring the shape
// here keeps unit tests from having to generate the real Prisma client.
class PrismaClientKnownRequestError extends Error {
  code: string;
  clientVersion: string;
  constructor(message: string, opts: { code: string; clientVersion: string }) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
    this.code = opts.code;
    this.clientVersion = opts.clientVersion;
  }
}

// WARP-1261: a stable, always-present HOUSEHOLD department fixture — matches
// the shape (+ a real uuid-format id, since files-spaces.test.ts pins it with
// `stringMatching(/^dept:[a-f0-9-]{36}$/)`) of the bootstrap-time seed row a
// real box provisions. Referenced by both `department.findFirst`/`findUnique`
// below.
const DEFAULT_HOUSEHOLD = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Household",
  kind: "HOUSEHOLD",
  parentId: null,
  state: "active",
  quotaBytes: null,
};

vi.mock("@prisma/client", () => {
  const mockPrisma = {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    device: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "test-uuid",
          deviceId: "droplet-dev-001",
          hostname: "droplet-dev",
          hardwareRev: "dev",
          networkMode: "dhcp",
          ip: "192.168.1.100",
          lastSeen: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
      update: vi.fn().mockResolvedValue({}),
    },
    // BUG-11: app.ts installs requirePasswordChangeGate on every request;
    // the gate calls `prisma.user.findUnique` synchronously inside the
    // handler, so a mock without a `user` table throws a TypeError
    // (bypassing the gate's fail-open .catch) and 500s every gated route.
    // `null` means "no directory row" → the gate fails open, matching a
    // fresh auth-disabled dev session.
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      // WARP-233: findUserByEmail probes findUnique (blind index) then
      // findFirst (pre-backfill plaintext fallback) — same "no row" default.
      findFirst: vi.fn().mockResolvedValue(null),
    },
    // Module toggles: app.ts installs the module gate on every non-core
    // module router; requireModuleEnabled() reads ModuleSetting overrides via
    // `moduleSetting.findMany()` on the first gated request per TTL. A mock
    // without this model throws, the gate fails closed to 404, and every
    // gated route (devices, network, files, cameras, …) 404s across ~10
    // suites. `[]` means "no overrides" → the registry's defaultEnabled wins,
    // matching a fresh box with no toggles applied.
    moduleSetting: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    // WARP-1260/1261: requireSpaceAccess (space middleware) and GET
    // /api/files/spaces both read `department` — the household space is
    // resolved via `findFirst({ where: { kind: "HOUSEHOLD" } })`, and
    // dept:<uuid> access/path resolution reads it via `findUnique`. A mock
    // without this model throws (real PrismaClientInitializationError from
    // the un-mocked delegate), which the space gate treats as a fail-closed
    // read error → every full-app files integration test 404s/500s. Seed a
    // single always-present HOUSEHOLD row (mirrors the bootstrap-time seed
    // on a real box) so the default "personal + household" listing works
    // out of the box; tests that need additional DEPARTMENT/TEAM rows or a
    // missing household override these mocks per-test.
    department: {
      findFirst: vi.fn(async (args?: { where?: { kind?: string } }) =>
        args?.where?.kind === "HOUSEHOLD" ? DEFAULT_HOUSEHOLD : null
      ),
      findUnique: vi.fn(async (args?: { where?: { id?: string } }) =>
        args?.where?.id === DEFAULT_HOUSEHOLD.id ? DEFAULT_HOUSEHOLD : null
      ),
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Membership lookups (owner/admin short-circuit still checks membership
    // to decide whether to emit the audited "admin-space-entry" row; family/
    // guest need an explicit row). `null` = "not a member" — the safe default
    // for a fresh session with no seeded memberships.
    departmentMembership: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  return {
    PrismaClient: vi.fn(() => mockPrisma),
    // Mirrors the generated client's top-level enum exports (const objects
    // whose values equal their keys). off-lan-gate.service.ts imports the
    // `OffLanChannelKey` value to key its `offLanAllowlistChannel.findUnique`
    // read (WARP-467); the schema's `enum OffLanChannelKey { ... }` is the
    // source of truth for this set.
    OffLanChannelKey: {
      software_updates: "software_updates",
      cloud_model_escape: "cloud_model_escape",
      outbound_email: "outbound_email",
      telemetry: "telemetry",
      web_fetch: "web_fetch",
    },
    // WARP-181: actor attribution on ActivityRow. Mirrors the schema's
    // `enum ActivityActorType` — keep in lockstep or ~200 suites cascade
    // into 401/500s (the recorder validates against these values).
    ActivityActorType: {
      user: "user",
      ai: "ai",
      system: "system",
      anonymous: "anonymous",
    },
    Prisma: {
      PrismaClientKnownRequestError,
      // Mirrors the generated client's const-object enum — reset.service opens
      // its double-fire-guard transaction with
      // `Prisma.TransactionIsolationLevel.Serializable` (pr-reviewer #549).
      TransactionIsolationLevel: {
        ReadUncommitted: "ReadUncommitted",
        ReadCommitted: "ReadCommitted",
        RepeatableRead: "RepeatableRead",
        Serializable: "Serializable",
      },
    },
  };
});
