/**
 * WARP-225 — context-stats.service unit tests.
 *
 * Doesn't require a live Postgres; the service is purely a $queryRaw
 * orchestrator + JSON shaping layer, so we mock $queryRaw with canned
 * row sets and assert the wire shape the dashboard renders against.
 *
 * Cross-user isolation is enforced at the SQL layer (every query has
 * WHERE "userId" = $1). The route-level RBAC test in
 * `__tests__/me-context-stats.rbac.test.ts` exercises the end-to-end
 * isolation path; this file focuses on response shaping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getSummary,
  getFull,
  getQueued,
  getFailed,
  summaryKey,
  fullKey,
  queuedKey,
  failedKey,
  userKeyPrefix,
  CACHE_TTL_SUMMARY_S,
  CACHE_TTL_FULL_S,
  CACHE_TTL_QUEUED_S,
  CACHE_TTL_FAILED_S,
} from "./context-stats.service.js";

// ── Hand-rolled $queryRaw stub ──────────────────────────────────────────
//
// vitest's tagged-template support lets us match on the SQL fragment that
// follows the `prisma.$queryRaw\`` head. We dispatch by substring so the
// service can keep its raw SQL human-readable.

type Strings = TemplateStringsArray;
type RowFn = (sql: string, args: unknown[]) => unknown;

function makePrismaStub(rowFns: Array<{ match: RegExp; rows: RowFn }>): {
  prisma: { $queryRaw: (s: Strings, ...args: unknown[]) => Promise<unknown> };
  calls: string[];
} {
  const calls: string[] = [];
  const $queryRaw = async (s: Strings, ...args: unknown[]) => {
    // Reassemble the SQL with placeholder slots so a regex can still see
    // the `WHERE "userId" = $1` shape the service emits.
    const parts: string[] = [];
    for (let i = 0; i < s.length; i++) {
      parts.push(s[i]);
      if (i < args.length) parts.push(`$${i + 1}`);
    }
    const sql = parts.join(" ").replace(/\s+/g, " ").trim();
    calls.push(sql);
    for (const { match, rows } of rowFns) {
      if (match.test(sql)) return rows(sql, args);
    }
    throw new Error(`Unexpected query: ${sql.slice(0, 200)}`);
  };
  return { prisma: { $queryRaw }, calls };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("cache key helpers", () => {
  it("derive deterministic keys per user", () => {
    expect(summaryKey("alice")).toBe("context-stats:alice:summary");
    expect(fullKey("alice")).toBe("context-stats:alice:full");
    expect(queuedKey("alice")).toBe("context-stats:alice:queued");
    expect(failedKey("alice")).toBe("context-stats:alice:failed");
    expect(userKeyPrefix("alice")).toBe("context-stats:alice:");
  });

  it("isolates cache namespaces between users", () => {
    expect(summaryKey("alice")).not.toBe(summaryKey("bob"));
    expect(userKeyPrefix("alice")).not.toBe(userKeyPrefix("bob"));
  });

  it("exports the spec'd TTLs (30 / 60 / 300 / 300)", () => {
    expect(CACHE_TTL_SUMMARY_S).toBe(30);
    expect(CACHE_TTL_FULL_S).toBe(60);
    expect(CACHE_TTL_QUEUED_S).toBe(300);
    expect(CACHE_TTL_FAILED_S).toBe(300);
  });
});

describe("getSummary", () => {
  it("shapes counts + recently-indexed list with per-item chunk counts", async () => {
    const indexedAt = new Date("2026-05-09T12:00:00Z");
    const { prisma } = makePrismaStub([
      {
        match: /count\(\*\)::bigint AS c FROM "BrainMemoryItem" WHERE "userId" = \$1$/,
        rows: () => [{ c: 5n }],
      },
      {
        match: /^SELECT count\(\*\)::bigint AS c FROM "FileContentChunk" WHERE "userId"/,
        rows: () => [{ c: 142n }],
      },
      {
        match: /status" = 'queued_for_transcription'$/,
        rows: () => [{ c: 2n }],
      },
      {
        match: /status" = 'failed'$/,
        rows: () => [{ c: 1n }],
      },
      {
        match: /sum\("bytes"\), 0\)::bigint AS b\s+FROM "BrainMemoryItem"/,
        rows: () => [{ b: 10485760n }],
      },
      {
        match: /AS "chunkCount"\s+FROM "BrainMemoryItem"/,
        rows: () => [
          {
            id: "bmi-1",
            filename: "report.pdf",
            mimeType: "application/pdf",
            indexedAt,
            chunkCount: 12n,
          },
        ],
      },
    ]);

    const out = await getSummary(prisma as never, "alice");

    expect(out.files).toBe(5);
    expect(out.chunks).toBe(142);
    expect(out.queued).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.recentlyIndexed).toEqual([
      {
        id: "bmi-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        category: "pdf",
        indexedAt: indexedAt.toISOString(),
        chunkCount: 12,
      },
    ]);
  });

  it("returns zeros + empty list when the user has no rows", async () => {
    const { prisma } = makePrismaStub([
      { match: /\(\*\)::bigint AS c/, rows: () => [{ c: 0n }] },
      {
        match: /sum\("bytes"\), 0\)::bigint AS b\s+FROM "BrainMemoryItem" WHERE/,
        rows: () => [{ b: 0n }],
      },
      { match: /AS "chunkCount"\s+FROM "BrainMemoryItem"/, rows: () => [] },
    ]);
    const out = await getSummary(prisma as never, "ghost");
    expect(out.files).toBe(0);
    expect(out.chunks).toBe(0);
    expect(out.queued).toBe(0);
    expect(out.failed).toBe(0);
    expect(out.recentlyIndexed).toEqual([]);
  });
});

describe("getFull", () => {
  it("returns categories, throughput (dense 7-day), pipeline health, and bytes", async () => {
    const indexedAt = new Date("2026-05-09T08:00:00Z");
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const { prisma } = makePrismaStub([
      {
        match: /count\(\*\)::bigint AS c FROM "BrainMemoryItem" WHERE "userId" = \$1$/,
        rows: () => [{ c: 3n }],
      },
      {
        match: /^SELECT count\(\*\)::bigint AS c FROM "FileContentChunk"/,
        rows: () => [{ c: 100n }],
      },
      { match: /status" = 'queued_for_transcription'$/, rows: () => [{ c: 1n }] },
      { match: /status" = 'failed'$/, rows: () => [{ c: 0n }] },
      {
        match: /sum\("bytes"\), 0\)::bigint AS b\s+FROM "BrainMemoryItem" WHERE/,
        rows: () => [{ b: 2048n }],
      },
      {
        match: /ORDER BY i\."indexedAt" DESC LIMIT/,
        rows: () => [
          {
            id: "bmi-1",
            filename: "a.pdf",
            mimeType: "application/pdf",
            indexedAt,
            chunkCount: 4n,
          },
        ],
      },
      // byCategory — distinct from pipelineHealth by the `AS bytes`
      // selector, distinct from total-bytes by `AS files`.
      {
        match: /AS files,\s+COALESCE\(sum\("bytes"\), 0\)::bigint AS bytes/,
        rows: () => [
          { category: "pdf", files: 2n, bytes: 1024n },
          { category: "audio", files: 1n, bytes: 1024n },
        ],
      },
      // throughput7d
      {
        match: /date_trunc\('day', "indexedAt"\)::date AS day/,
        rows: () => [
          { day: yesterday, count: 2n },
          { day: today, count: 1n },
        ],
      },
      // pipelineHealth
      {
        match: /avg\(\s+EXTRACT\(EPOCH FROM/,
        rows: () => [
          {
            category: "pdf",
            files: 2n,
            avg_seconds: 0.85,
            failed: 0n,
          },
          {
            category: "audio",
            files: 1n,
            avg_seconds: null,
            failed: 0n,
          },
        ],
      },
    ]);

    const out = await getFull(prisma as never, "alice");

    expect(out.bytesIndexed).toBe(2048);
    expect(out.byCategory).toEqual([
      { category: "pdf", files: 2, bytes: 1024 },
      { category: "audio", files: 1, bytes: 1024 },
    ]);
    expect(out.throughput7d).toHaveLength(7);
    // last entry is today
    expect(out.throughput7d[6].count).toBe(1);
    expect(out.throughput7d[5].count).toBe(2);
    // earlier days are zero (densified)
    expect(out.throughput7d[0].count).toBe(0);

    expect(out.pipelineHealth).toEqual([
      { category: "pdf", files: 2, avgSecondsToReady: 0.9, failed: 0 },
      { category: "audio", files: 1, avgSecondsToReady: null, failed: 0 },
    ]);
  });
});

describe("getQueued", () => {
  it("attaches a human-readable reason per MIME family", async () => {
    const uploaded = new Date("2026-05-09T08:00:00Z");
    const { prisma } = makePrismaStub([
      {
        match: /WHERE "userId" = \$1\s+AND "status" = 'queued_for_transcription'/,
        rows: () => [
          {
            id: "audio-1",
            filename: "interview.mp3",
            mimeType: "audio/mpeg",
            uploadedAt: uploaded,
          },
          {
            id: "vid-1",
            filename: "lecture.mp4",
            mimeType: "video/mp4",
            uploadedAt: uploaded,
          },
          {
            id: "doc-1",
            filename: "x.pdf",
            mimeType: "application/pdf",
            uploadedAt: uploaded,
          },
        ],
      },
    ]);
    const out = await getQueued(prisma as never, "alice");
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      id: "audio-1",
      category: "audio",
      reason: "audio file, scheduled for nightly transcription",
    });
    expect(out[1].category).toBe("video");
    expect(out[1].reason).toMatch(/video file/);
    expect(out[2].category).toBe("pdf");
    expect(out[2].reason).toBe("queued for processing");
  });
});

describe("getFailed", () => {
  it("surfaces failureReason + recent-attempt cap state", async () => {
    const lastAttempt = new Date("2026-05-09T08:00:00Z");
    const { prisma } = makePrismaStub([
      {
        match: /WHERE "userId" = \$1\s+AND "status" = 'failed'/,
        rows: () => [
          {
            id: "f-1",
            filename: "broken.eml",
            mimeType: "message/rfc822",
            failureReason: "no_chunks",
            lastAttemptedAt: lastAttempt,
            recentAttemptCount: 2,
          },
        ],
      },
    ]);
    const out = await getFailed(prisma as never, "alice");
    expect(out).toEqual([
      {
        id: "f-1",
        filename: "broken.eml",
        mimeType: "message/rfc822",
        category: "email",
        failureReason: "no_chunks",
        lastAttemptedAt: lastAttempt.toISOString(),
        recentAttemptCount: 2,
      },
    ]);
  });

  it("handles never-attempted rows (lastAttemptedAt null)", async () => {
    const { prisma } = makePrismaStub([
      {
        match: /WHERE "userId" = \$1\s+AND "status" = 'failed'/,
        rows: () => [
          {
            id: "f-2",
            filename: "x",
            mimeType: null,
            failureReason: null,
            lastAttemptedAt: null,
            recentAttemptCount: 0,
          },
        ],
      },
    ]);
    const out = await getFailed(prisma as never, "alice");
    expect(out[0].lastAttemptedAt).toBeNull();
    expect(out[0].category).toBe("other");
  });
});
