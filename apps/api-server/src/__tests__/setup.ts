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
vi.mock("@prisma/client", () => {
  // Store for sync targets (in-memory for testing)
  const syncTargetStore = new Map<string, any>();

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
    syncTarget: {
      findMany: vi.fn().mockImplementation(() =>
        Promise.resolve(Array.from(syncTargetStore.values()))
      ),
      findUnique: vi.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(syncTargetStore.get(where.id) ?? null)
      ),
      create: vi.fn().mockImplementation(({ data }: any) => {
        const id = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const record = {
          id,
          ...data,
          enabled: data.enabled ?? true,
          lastSync: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          _count: { entries: 0 },
        };
        syncTargetStore.set(id, record);
        return Promise.resolve(record);
      }),
      update: vi.fn().mockImplementation(({ where, data }: any) => {
        const existing = syncTargetStore.get(where.id);
        if (!existing) return Promise.reject(new Error("Not found"));
        const updated = { ...existing, ...data, updatedAt: new Date() };
        syncTargetStore.set(where.id, updated);
        return Promise.resolve(updated);
      }),
      delete: vi.fn().mockImplementation(({ where }: any) => {
        const existing = syncTargetStore.get(where.id);
        syncTargetStore.delete(where.id);
        return Promise.resolve(existing);
      }),
    },
    fileEntry: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  };
  return { PrismaClient: vi.fn(() => mockPrisma) };
});
