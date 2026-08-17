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

// WARP-1394 — Nextcloud-side stubs for the pre-dual-source tests: zero
// synced rows, so the brain-only expectations stay unchanged. Prepended
// so their anchored patterns win before the older, looser brain regexes.
function ncZeroStubs(): Array<{ match: RegExp; rows: RowFn }> {
  return [
    {
      match: /count\(\*\)::bigint AS c FROM "FileIndexStatus" WHERE "userId" = \$1$/,
      rows: () => [{ c: 0n }],
    },
    {
      match: /"FileIndexStatus" WHERE "userId" = \$1 AND "status" = 'indexing'$/,
      rows: () => [{ c: 0n }],
    },
    {
      match: /"FileIndexStatus" WHERE "userId" = \$1 AND "status" = 'failed'$/,
      rows: () => [{ c: 0n }],
    },
    {
      match: /"FileIndexStatus" WHERE "userId" = \$1 AND "status" = 'skipped'$/,
      rows: () => [{ c: 0n }],
    },
    {
      match: /AS c FROM "FileContentChunk" WHERE "userId" = \$1 AND "source" = 'nextcloud'$/,
      rows: () => [{ c: 0n }],
    },
    {
      match: /sum\(length\("text"\)\), 0\)::bigint AS b\s+FROM "FileContentChunk"/,
      rows: () => [{ b: 0n }],
    },
    { match: /AS "chunkCount"\s+FROM "FileIndexStatus" i/, rows: () => [] },
    {
      match: /path_ext_to_category\("path"\) AS category,\s+count\(\*\)::bigint AS files\s+FROM "FileIndexStatus"/,
      rows: () => [],
    },
    {
      match: /path_ext_to_category\("path"\) AS category,\s+COALESCE\(sum\(length\("text"\)\), 0\)::bigint AS bytes\s+FROM "FileContentChunk"/,
      rows: () => [],
    },
    { match: /date_trunc\('day', "updatedAt"\)::date AS day/, rows: () => [] },
    {
      match: /AS files,\s+count\(\*\) FILTER \(WHERE "status" = 'failed'\)::bigint AS failed\s+FROM "FileIndexStatus"/,
      rows: () => [],
    },
    {
      match: /"path", "updatedAt"\s+FROM "FileIndexStatus"\s+WHERE "userId" = \$1\s+AND "status" = 'indexing'/,
      rows: () => [],
    },
    {
      match: /"path", "reason", "updatedAt"\s+FROM "FileIndexStatus"\s+WHERE "userId" = \$1\s+AND "status" = 'failed'/,
      rows: () => [],
    },
  ];
}



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
      ...ncZeroStubs(),
      {
        match: /count\(\*\)::bigint AS c FROM "BrainMemoryItem" WHERE "userId" = \$1$/,
        rows: () => [{ c: 5n }],
      },
      {
        match: /"FileContentChunk" WHERE "userId" = \$1 AND "source" = 'brain'$/,
        rows: () => [{ c: 142n }],
      },
      {
        match: /"BrainMemoryItem" WHERE "userId" = \$1 AND "status" = 'queued_for_transcription'$/,
        rows: () => [{ c: 2n }],
      },
      {
        match: /"BrainMemoryItem" WHERE "userId" = \$1 AND "status" = 'failed'$/,
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

    const out = await getSummary(prisma as never, "alice", "alice");

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
        source: "brain",
      },
    ]);
  });

  it("returns zeros + empty list when the user has no rows", async () => {
    const { prisma } = makePrismaStub([
      ...ncZeroStubs(),
      { match: /\(\*\)::bigint AS c/, rows: () => [{ c: 0n }] },
      {
        match: /sum\("bytes"\), 0\)::bigint AS b\s+FROM "BrainMemoryItem" WHERE/,
        rows: () => [{ b: 0n }],
      },
      { match: /AS "chunkCount"\s+FROM "BrainMemoryItem"/, rows: () => [] },
    ]);
    const out = await getSummary(prisma as never, "ghost", "ghost");
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
      ...ncZeroStubs(),
      {
        match: /count\(\*\)::bigint AS c FROM "BrainMemoryItem" WHERE "userId" = \$1$/,
        rows: () => [{ c: 3n }],
      },
      {
        match: /"FileContentChunk" WHERE "userId" = \$1 AND "source" = 'brain'$/,
        rows: () => [{ c: 100n }],
      },
      { match: /"BrainMemoryItem" WHERE "userId" = \$1 AND "status" = 'queued_for_transcription'$/, rows: () => [{ c: 1n }] },
      { match: /"BrainMemoryItem" WHERE "userId" = \$1 AND "status" = 'failed'$/, rows: () => [{ c: 0n }] },
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

    const out = await getFull(prisma as never, "alice", "alice");

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
      {
        category: "pdf",
        files: 2,
        avgSecondsToReady: 0.9,
        failed: 0,
        source: "brain",
      },
      {
        category: "audio",
        files: 1,
        avgSecondsToReady: null,
        failed: 0,
        source: "brain",
      },
    ]);
  });
});

describe("getQueued", () => {
  it("attaches a human-readable reason per MIME family", async () => {
    const uploaded = new Date("2026-05-09T08:00:00Z");
    const { prisma } = makePrismaStub([
      ...ncZeroStubs(),
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
    const out = await getQueued(prisma as never, "alice", "alice");
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
      ...ncZeroStubs(),
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
    const out = await getFailed(prisma as never, "alice", "alice");
    expect(out).toEqual([
      {
        id: "f-1",
        filename: "broken.eml",
        mimeType: "message/rfc822",
        category: "email",
        failureReason: "no_chunks",
        lastAttemptedAt: lastAttempt.toISOString(),
        recentAttemptCount: 2,
        source: "brain",
      },
    ]);
  });

  it("handles never-attempted rows (lastAttemptedAt null)", async () => {
    const { prisma } = makePrismaStub([
      ...ncZeroStubs(),
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
    const out = await getFailed(prisma as never, "alice", "alice");
    expect(out[0].lastAttemptedAt).toBeNull();
    expect(out[0].category).toBe("other");
  });
});

// ── WARP-1394 — Nextcloud-synced files (FileIndexStatus) must be part of
// every aggregate, not just chat attachments (BrainMemoryItem). A box
// whose whole corpus arrived via file sync previously reported files: 0
// and the dashboard rendered the "context is empty" onboarding card.
//
// Identity is DUAL-KEYED: brain rows are scoped by the local User UUID
// (WARP-493), synced rows by the Nextcloud username the watcher stamps.
// Every service entry point takes both.
describe("dual-source aggregation (WARP-1394)", () => {
  const T0 = new Date("2026-07-01T08:00:00Z");
  const T1 = new Date("2026-07-02T08:00:00Z");
  const T2 = new Date("2026-07-03T08:00:00Z");
  const T3 = new Date("2026-07-04T08:00:00Z");
  const T4 = new Date("2026-07-05T08:00:00Z");

  // Brain-side stubs (existing pipeline) reused across the tests below.
  function brainStubs(): Array<{ match: RegExp; rows: () => unknown }> {
    return [
      {
        match: /count\(\*\)::bigint AS c FROM "BrainMemoryItem" WHERE "userId" = \$1$/,
        rows: () => [{ c: 2n }],
      },
      {
        match: /"FileContentChunk" WHERE "userId" = \$1 AND "source" = 'brain'$/,
        rows: () => [{ c: 4n }],
      },
      {
        match: /"BrainMemoryItem" WHERE "userId" = \$1 AND "status" = 'queued_for_transcription'$/,
        rows: () => [{ c: 1n }],
      },
      {
        match: /"BrainMemoryItem" WHERE "userId" = \$1 AND "status" = 'failed'$/,
        rows: () => [{ c: 1n }],
      },
      {
        match: /sum\("bytes"\), 0\)::bigint AS b\s+FROM "BrainMemoryItem"/,
        rows: () => [{ b: 2048n }],
      },
      {
        match: /AS "chunkCount"\s+FROM "BrainMemoryItem"/,
        rows: () => [
          {
            id: "bmi-1",
            filename: "report.pdf",
            mimeType: "application/pdf",
            indexedAt: T1,
            chunkCount: 4n,
          },
        ],
      },
    ];
  }

  // Nextcloud-side stubs: 3 rows total (1 ready docx, 1 indexing pdf,
  // 1 failed pdf), 4096 bytes of indexed chunk text.
  function ncStubs(): Array<{ match: RegExp; rows: () => unknown }> {
    return [
      {
        match: /count\(\*\)::bigint AS c FROM "FileIndexStatus" WHERE "userId" = \$1$/,
        rows: () => [{ c: 3n }],
      },
      {
        match: /"FileIndexStatus" WHERE "userId" = \$1 AND "status" = 'indexing'$/,
        rows: () => [{ c: 1n }],
      },
      {
        match: /"FileIndexStatus" WHERE "userId" = \$1 AND "status" = 'failed'$/,
        rows: () => [{ c: 1n }],
      },
      {
        match: /"FileIndexStatus" WHERE "userId" = \$1 AND "status" = 'skipped'$/,
        rows: () => [{ c: 1n }],
      },
      {
        match: /AS c FROM "FileContentChunk" WHERE "userId" = \$1 AND "source" = 'nextcloud'$/,
        rows: () => [{ c: 6n }],
      },
      {
        match: /sum\(length\("text"\)\), 0\)::bigint AS b\s+FROM "FileContentChunk"/,
        rows: () => [{ b: 4096n }],
      },
      {
        match: /AS "chunkCount"\s+FROM "FileIndexStatus" i/,
        rows: () => [{ path: "/Docs/plan.docx", updatedAt: T2, chunkCount: 6n }],
      },
    ];
  }

  it("getSummary merges counts and recently-indexed across both pipelines", async () => {
    const { prisma } = makePrismaStub([...brainStubs(), ...ncStubs()]);

    const out = await getSummary(prisma as never, "alice", "alice-nc");

    // files = 2 chat attachments + 3 synced files; queued = 1 + 1 (an
    // 'indexing' synced row is in-flight); failed = 1 + 1.
    expect(out.files).toBe(5);
    expect(out.chunks).toBe(10);
    expect(out.queued).toBe(2);
    expect(out.failed).toBe(2);

    // Merged newest-first; synced rows are keyed nc:<path>, carry no
    // MIME (category comes from the extension), and declare their source.
    expect(out.recentlyIndexed).toEqual([
      {
        id: "nc:/Docs/plan.docx",
        filename: "plan.docx",
        mimeType: null,
        category: "text",
        indexedAt: T2.toISOString(),
        chunkCount: 6,
        source: "nextcloud",
      },
      {
        id: "bmi-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        category: "pdf",
        indexedAt: T1.toISOString(),
        chunkCount: 4,
        source: "brain",
      },
    ]);
  });

  it("getFull merges bytes, categories, throughput, and pipeline health", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const { prisma } = makePrismaStub([
      ...brainStubs(),
      ...ncStubs(),
      // brain byCategory
      {
        match: /AS files,\s+COALESCE\(sum\("bytes"\), 0\)::bigint AS bytes/,
        rows: () => [
          { category: "pdf", files: 2n, bytes: 1024n },
          { category: "audio", files: 1n, bytes: 1024n },
        ],
      },
      // nc byCategory file counts (extension-derived)
      {
        match: /path_ext_to_category\("path"\) AS category,\s+count\(\*\)::bigint AS files\s+FROM "FileIndexStatus"/,
        rows: () => [
          { category: "text", files: 2n },
          { category: "pdf", files: 1n },
        ],
      },
      // nc byCategory indexed-text bytes
      {
        match: /path_ext_to_category\("path"\) AS category,\s+COALESCE\(sum\(length\("text"\)\), 0\)::bigint AS bytes\s+FROM "FileContentChunk"/,
        rows: () => [
          { category: "text", files: 0n, bytes: 3000n },
          { category: "pdf", files: 0n, bytes: 1096n },
        ],
      },
      // brain throughput
      {
        match: /date_trunc\('day', "indexedAt"\)::date AS day/,
        rows: () => [
          { day: yesterday, count: 2n },
          { day: today, count: 1n },
        ],
      },
      // nc throughput ('ready' rows by updatedAt)
      {
        match: /date_trunc\('day', "updatedAt"\)::date AS day/,
        rows: () => [{ day: today, count: 2n }],
      },
      // brain pipeline health
      {
        match: /avg\(\s+EXTRACT\(EPOCH FROM/,
        rows: () => [
          { category: "pdf", files: 2n, avg_seconds: 12.5, failed: 0n },
        ],
      },
      // nc pipeline health (no timing columns exist for synced files)
      {
        match: /AS files,\s+count\(\*\) FILTER \(WHERE "status" = 'failed'\)::bigint AS failed\s+FROM "FileIndexStatus"/,
        rows: () => [
          { category: "text", files: 2n, failed: 1n },
          { category: "pdf", files: 1n, failed: 0n },
        ],
      },
    ]);

    const out = await getFull(prisma as never, "alice", "alice-nc");

    expect(out.files).toBe(5);
    // 2048 original chat-attachment bytes + 4096 bytes of indexed synced text.
    expect(out.bytesIndexed).toBe(6144);

    // Categories merge across sources, ordered by file count desc.
    expect(out.byCategory).toEqual([
      { category: "pdf", files: 3, bytes: 2120 },
      { category: "text", files: 2, bytes: 3000 },
      { category: "audio", files: 1, bytes: 1024 },
    ]);

    // Throughput sums per-day across sources (dense 7-day window).
    const byDay = new Map(out.throughput7d.map((d) => [d.day, d.count]));
    expect(byDay.get(today.toISOString().slice(0, 10))).toBe(3);
    expect(byDay.get(yesterday.toISOString().slice(0, 10))).toBe(2);
    expect(out.throughput7d).toHaveLength(7);

    // Pipeline health keeps sources as separate rows: timing only exists
    // for the chat-attachment pipeline, so synced rows carry avg null
    // without meaning "never reached ready".
    expect(out.pipelineHealth).toEqual([
      {
        category: "pdf",
        files: 2,
        avgSecondsToReady: 12.5,
        failed: 0,
        source: "brain",
      },
      {
        category: "text",
        files: 2,
        avgSecondsToReady: null,
        failed: 1,
        source: "nextcloud",
      },
      {
        category: "pdf",
        files: 1,
        avgSecondsToReady: null,
        failed: 0,
        source: "nextcloud",
      },
    ]);
  });

  it("getQueued includes in-flight synced files, ordered oldest-first", async () => {
    const { prisma } = makePrismaStub([
      {
        match: /"id", "filename", "mimeType", "uploadedAt"\s+FROM "BrainMemoryItem"/,
        rows: () => [
          {
            id: "bmi-q",
            filename: "song.mp3",
            mimeType: "audio/mpeg",
            uploadedAt: T3,
          },
        ],
      },
      {
        match: /"path", "updatedAt"\s+FROM "FileIndexStatus"\s+WHERE "userId" = \$1\s+AND "status" = 'indexing'/,
        rows: () => [{ path: "/Inbox/scan.pdf", updatedAt: T0 }],
      },
    ]);

    const out = await getQueued(prisma as never, "alice", "alice-nc");

    expect(out).toEqual([
      {
        id: "nc:/Inbox/scan.pdf",
        filename: "scan.pdf",
        mimeType: null,
        category: "pdf",
        uploadedAt: T0.toISOString(),
        reason: "being indexed from your synced files",
        source: "nextcloud",
      },
      {
        id: "bmi-q",
        filename: "song.mp3",
        mimeType: "audio/mpeg",
        category: "audio",
        uploadedAt: T3.toISOString(),
        reason: "audio file, scheduled for nightly transcription",
        source: "brain",
      },
    ]);
  });

  it("getFailed includes failed synced files, newest attempt first", async () => {
    const { prisma } = makePrismaStub([
      {
        match: /"failureReason",\s+"lastAttemptedAt", "recentAttemptCount"\s+FROM "BrainMemoryItem"/,
        rows: () => [
          {
            id: "bmi-f",
            filename: "broken.docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            failureReason: "no_chunks",
            lastAttemptedAt: T3,
            recentAttemptCount: 2,
          },
        ],
      },
      {
        match: /"path", "reason", "updatedAt"\s+FROM "FileIndexStatus"\s+WHERE "userId" = \$1\s+AND "status" = 'failed'/,
        rows: () => [
          { path: "/Docs/x.pdf", reason: "nc_file_id_unresolved", updatedAt: T4 },
        ],
      },
    ]);

    const out = await getFailed(prisma as never, "alice", "alice-nc");

    expect(out).toEqual([
      {
        id: "nc:/Docs/x.pdf",
        filename: "x.pdf",
        mimeType: null,
        category: "pdf",
        failureReason: "nc_file_id_unresolved",
        lastAttemptedAt: T4.toISOString(),
        recentAttemptCount: 0,
        source: "nextcloud",
      },
      {
        id: "bmi-f",
        filename: "broken.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        category: "text",
        failureReason: "no_chunks",
        lastAttemptedAt: T3.toISOString(),
        recentAttemptCount: 2,
        source: "brain",
      },
    ]);
  });
});
