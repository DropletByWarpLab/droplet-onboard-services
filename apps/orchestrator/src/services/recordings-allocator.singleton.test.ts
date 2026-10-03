import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRecordingsAllocator,
  kickRecordingsAllocator,
  setRecordingsAllocator,
} from "./recordings-allocator.singleton.js";
import type { RecordingsAllocator } from "./recordings.types.js";

function fakeAllocator(overrides: Partial<RecordingsAllocator> = {}): RecordingsAllocator {
  return {
    reconcile: vi.fn(async () => ({ action: "none" as const })),
    pollMigration: vi.fn(async () => undefined),
    setAllocation: vi.fn(async () => ({ accepted: true as const })),
    deleteOldFootage: vi.fn(async () => ({ accepted: true as const })),
    getFacts: vi.fn(),
    getOverview: vi.fn(),
    ...overrides,
  } as RecordingsAllocator;
}

describe("recordings allocator singleton (WARP-3514)", () => {
  afterEach(() => setRecordingsAllocator(null));

  it("is null before boot wiring, so import order never matters", () => {
    expect(getRecordingsAllocator()).toBeNull();
  });

  it("returns what boot wiring registered", () => {
    const allocator = fakeAllocator();
    setRecordingsAllocator(allocator);
    expect(getRecordingsAllocator()).toBe(allocator);
  });

  it("kick is a safe no-op before the allocator exists", () => {
    expect(() => kickRecordingsAllocator()).not.toThrow();
  });

  it("kick asks the allocator to reconcile with reason 'kick' and does not await it", () => {
    let release: () => void = () => undefined;
    const reconcile = vi.fn(
      () =>
        new Promise<{ action: "none" }>((resolve) => {
          release = () => resolve({ action: "none" });
        }),
    );
    setRecordingsAllocator(fakeAllocator({ reconcile }));

    // Returns synchronously even though the reconcile has not settled.
    expect(kickRecordingsAllocator()).toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith({ reason: "kick" });
    release();
  });

  it("kick swallows a reconcile failure — the caller already answered its own request", async () => {
    const reconcile = vi.fn(async () => {
      throw new Error("bridge exploded");
    });
    setRecordingsAllocator(fakeAllocator({ reconcile }));

    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    kickRecordingsAllocator();
    // Let the rejected promise's catch handler run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", unhandled);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
