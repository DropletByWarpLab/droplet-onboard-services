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
          hostname: "droplet-pi",
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
  };
  return {
    PrismaClient: vi.fn(() => mockPrisma),
    Prisma: { PrismaClientKnownRequestError },
  };
});
