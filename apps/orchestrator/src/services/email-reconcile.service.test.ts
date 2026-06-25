import { describe, it, expect, vi, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  resolveStaleMs,
  reconcileStaleSending,
  EMAIL_SENDING_STALE_DEFAULT_MS,
} from "./email-reconcile.service.js";

describe("WARP-890 — resolveStaleMs (|| swallows 0 fix)", () => {
  it("defaults to 10 min when unset", () => {
    expect(resolveStaleMs(undefined)).toBe(EMAIL_SENDING_STALE_DEFAULT_MS);
    expect(EMAIL_SENDING_STALE_DEFAULT_MS).toBe(10 * 60 * 1000);
  });

  it("defaults when empty string", () => {
    expect(resolveStaleMs("")).toBe(EMAIL_SENDING_STALE_DEFAULT_MS);
  });

  it("HONORS an explicit 0 (the bug: `Number(x) || default` swallowed it)", () => {
    expect(resolveStaleMs("0")).toBe(0);
  });

  it("parses a finite override", () => {
    expect(resolveStaleMs("30000")).toBe(30000);
  });

  it("falls back to default on NaN garbage", () => {
    expect(resolveStaleMs("not-a-number")).toBe(EMAIL_SENDING_STALE_DEFAULT_MS);
  });
});

describe("WARP-890 — reconcileStaleSending", () => {
  afterEach(() => {
    delete process.env.EMAIL_SENDING_STALE_MS;
    vi.restoreAllMocks();
  });

  function mkPrisma() {
    const updateMany = vi.fn(
      async (_args: { where: unknown; data: unknown }) => ({ count: 2 }),
    );
    return {
      prisma: { emailDraft: { updateMany } } as unknown as Pick<
        PrismaClient,
        "emailDraft"
      >,
      updateMany,
    };
  }

  it("sweeps status='sending' AND claimedAt < cutoff to 'failed'", async () => {
    const { prisma, updateMany } = mkPrisma();
    const now = new Date("2026-06-24T12:00:00.000Z");
    const count = await reconcileStaleSending(prisma, now);
    expect(count).toBe(2);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0]![0] as unknown as {
      where: { status: string; claimedAt: { lt: Date } };
      data: { status: string };
    };
    expect(arg.where.status).toBe("sending");
    // cutoff = now - default 10m
    expect(arg.where.claimedAt.lt.getTime()).toBe(
      now.getTime() - EMAIL_SENDING_STALE_DEFAULT_MS,
    );
    expect(arg.data.status).toBe("failed");
  });

  it("respects an explicit EMAIL_SENDING_STALE_MS=0 (cutoff === now)", async () => {
    process.env.EMAIL_SENDING_STALE_MS = "0";
    const { prisma, updateMany } = mkPrisma();
    const now = new Date("2026-06-24T12:00:00.000Z");
    await reconcileStaleSending(prisma, now);
    const arg = updateMany.mock.calls[0]![0] as unknown as {
      where: { claimedAt: { lt: Date } };
    };
    expect(arg.where.claimedAt.lt.getTime()).toBe(now.getTime());
  });
});
