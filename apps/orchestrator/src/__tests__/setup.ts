/**
 * Global test setup — mocks external services so unit tests run without
 * Postgres, Redis, MQTT, or the AI Gateway.
 */

import { vi } from "vitest";

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
