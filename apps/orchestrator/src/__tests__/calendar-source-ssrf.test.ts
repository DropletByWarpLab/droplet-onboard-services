/**
 * WARP-2022 — the SSRF guard at the two boundaries the fetch-path tests
 * cannot reach: HTTP registration, and the background poller.
 *
 * `caldav.client.test.ts` proves the guard refuses a destination without
 * opening a socket. This file proves the two things that are true only of
 * the wiring around it:
 *
 *   1. **Registration is refused up front.** A bad URL is a 400 when the
 *      user saves it, not a mystery `lastSyncError` fifteen minutes later,
 *      and no row is written.
 *   2. **The poller fails closed on rows that predate this change.** The
 *      real risk is not the URL someone registers tomorrow — it is the
 *      internal URL already sitting in the table, which `reminders-poller`
 *      re-fetches on a timer with no further user action.
 *
 * Point 2 is why this file deliberately does NOT mock `caldav.client.js`.
 * Every other calendar test stubs it; stubbing it here would prove only
 * that one mock called another. The real client runs against a sentinel
 * `fetch`, so "fails closed" means an actual socket was never opened.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import type { PrismaClient } from "@prisma/client";

// Resolver answers a PUBLIC address by default: the tests that expect a
// refusal must be refused by the RULES, not by a resolver that happens to
// fail. A test whose subject is DNS overrides this per-case.
const lookup = vi.fn(async (..._args: unknown[]) => [
  { address: "93.184.216.34", family: 4 },
]);
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookup(...args),
  default: { lookup: (...args: unknown[]) => lookup(...args) },
}));

vi.mock("../services/encryption.service.js", () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ""),
}));

import { createCalendarRouter } from "../routes/calendar.js";
import { createSource, syncSource, listSources } from "../services/calendar.service.js";
import { BLOCKED_DESTINATION_MESSAGE } from "../lib/outbound-url-guard.js";

interface SourceRow {
  id: string;
  userId: string;
  name: string;
  url: string;
  authMode: string;
  username: string | null;
  passwordEnc: string | null;
  syncIntervalSec: number;
  allowPrivateHost: boolean;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeStub(seed: Partial<SourceRow>[] = []) {
  let n = 0;
  const sources: SourceRow[] = seed.map((s, i) => ({
    id: `src-${i}`,
    userId: "alice",
    name: "seeded",
    url: "https://example.test/cal.ics",
    authMode: "none",
    username: null,
    passwordEnc: null,
    syncIntervalSec: 900,
    allowPrivateHost: false,
    lastSyncAt: null,
    lastSyncError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...s,
  }));
  return {
    sources,
    calendarSource: {
      create: vi.fn(async ({ data }: { data: Partial<SourceRow> }) => {
        const row = {
          id: `src-new-${++n}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSyncAt: null,
          lastSyncError: null,
          ...data,
        } as SourceRow;
        sources.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        sources.find((s) => s.id === where.id) ?? null,
      ),
      findMany: vi.fn(async () => sources),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<SourceRow> }) => {
        const row = sources.find((s) => s.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
    },
    calendarEvent: {
      upsert: vi.fn(async () => ({ id: "ev-1", createdAt: new Date(), updatedAt: new Date() })),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  };
}

/** A fetch that must never be reached. Any call is the defect. */
function sentinelFetch() {
  const spy = vi.fn(async () => new Response("SHOULD NEVER BE REACHED", { status: 200 }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function makeApp(stub: ReturnType<typeof makeStub>, role = "owner") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: { username: string; role: string } }).user = {
      username: "alice",
      role,
    };
    next();
  });
  app.use("/api", createCalendarRouter(stub as never));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Registration
// ─────────────────────────────────────────────────────────────────────────────

/** One row per rule the registration gate must reject. Same shape as the
 *  fetch-path table on purpose: a rule dropped from the guard turns exactly
 *  one row red at BOTH boundaries, and names itself while doing it. */
const REGISTRATION_BLOCKED: ReadonlyArray<{ rule: string; url: string }> = [
  { rule: "loopback v4", url: "http://127.0.0.1:8080/" },
  { rule: "loopback v6", url: "http://[::1]/" },
  { rule: "RFC1918", url: "http://192.168.1.1/x.ics" },
  { rule: "cloud metadata", url: "http://169.254.169.254/latest/meta-data/" },
  { rule: "CGNAT", url: "http://100.64.0.1/" },
  { rule: ".local name", url: "http://box.local/x.ics" },
  { rule: "ftp:// scheme", url: "ftp://h/x" },
  { rule: "file:// scheme", url: "file:///etc/passwd" },
  { rule: "userinfo", url: "http://u:p@dav.example.test/" },
];

describe("POST /api/calendar/sources — registration is refused up front", () => {
  it.each(REGISTRATION_BLOCKED)("rejects $rule with 400 and writes nothing", async ({ url }) => {
    const stub = makeStub();
    const spy = sentinelFetch();
    const res = await request(makeApp(stub))
      .post("/api/calendar/sources")
      .send({ name: "probe", url, authMode: "none" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    // Nothing persisted — the row must not exist to be polled later.
    expect(stub.calendarSource.create).not.toHaveBeenCalled();
    expect(stub.sources).toHaveLength(0);
    // And nothing dialled while deciding.
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not leak what is behind the refused destination", async () => {
    const stub = makeStub();
    const res = await request(makeApp(stub))
      .post("/api/calendar/sources")
      .send({ name: "probe", url: "http://127.0.0.1:9200/_cluster/health", authMode: "none" });

    expect(res.status).toBe(400);
    // MUTATION GUARD: surfacing err.detail (or an upstream status) here turns
    // registration back into the port scanner this ticket closed.
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|9200|elastic/i);
  });

  it("accepts an ordinary public CalDAV URL", async () => {
    const stub = makeStub();
    const res = await request(makeApp(stub))
      .post("/api/calendar/sources")
      .send({ name: "iCloud", url: "https://caldav.icloud.com/1/calendars/home/", authMode: "none" });

    expect(res.status).toBe(201);
    expect(stub.sources).toHaveLength(1);
    expect(stub.sources[0].allowPrivateHost).toBe(false);
  });

  it("does NOT resolve DNS at registration — saving works while the box is offline", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    const stub = makeStub();
    const res = await request(makeApp(stub))
      .post("/api/calendar/sources")
      .send({ name: "iCloud", url: "https://caldav.icloud.com/1/calendars/home/", authMode: "none" });

    expect(res.status).toBe(201);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("allowPrivateHost is an owner/admin decision", () => {
  it.each(["owner", "admin"])("lets %s register a LAN CalDAV server", async (role) => {
    const stub = makeStub();
    const res = await request(makeApp(stub, role))
      .post("/api/calendar/sources")
      .send({
        name: "Nextcloud",
        url: "http://192.168.1.50/remote.php/dav/",
        authMode: "none",
        allowPrivateHost: true,
      });

    expect(res.status).toBe(201);
    expect(stub.sources[0].allowPrivateHost).toBe(true);
  });

  it.each(["family", "guest"])("refuses %s the escape hatch", async (role) => {
    const stub = makeStub();
    const res = await request(makeApp(stub, role))
      .post("/api/calendar/sources")
      .send({
        name: "Nextcloud",
        url: "http://192.168.1.50/remote.php/dav/",
        authMode: "none",
        allowPrivateHost: true,
      });

    expect(res.status).toBe(403);
    expect(stub.sources).toHaveLength(0);
  });

  it("defaults the column to false when a lower role omits the field", async () => {
    const stub = makeStub();
    const res = await request(makeApp(stub, "family"))
      .post("/api/calendar/sources")
      .send({ name: "Public", url: "https://feeds.example.test/a.ics", authMode: "none" });

    expect(res.status).toBe(201);
    expect(stub.sources[0].allowPrivateHost).toBe(false);
  });

  // MUTATION GUARD: the hatch is for ADDRESS RANGES only. If it is ever
  // allowed to skip the scheme check, an owner can point the orchestrator at
  // the filesystem.
  it("still refuses file:// for an owner who set the flag", async () => {
    const stub = makeStub();
    const res = await request(makeApp(stub, "owner"))
      .post("/api/calendar/sources")
      .send({
        name: "nope",
        url: "file:///etc/passwd",
        authMode: "none",
        allowPrivateHost: true,
      });

    expect(res.status).toBe(400);
    expect(stub.sources).toHaveLength(0);
  });
});

describe("createSource (service level)", () => {
  it("refuses a blocked URL before touching prisma", async () => {
    const stub = makeStub();
    await expect(
      createSource(stub as unknown as PrismaClient, "alice", {
        name: "probe",
        url: "http://169.254.169.254/latest/meta-data/",
        authMode: "none",
      }),
    ).rejects.toMatchObject({ message: BLOCKED_DESTINATION_MESSAGE });
    expect(stub.calendarSource.create).not.toHaveBeenCalled();
  });

  it("surfaces allowPrivateHost through listSources so the panel can show it", async () => {
    const stub = makeStub([{ id: "src-0", allowPrivateHost: true }]);
    const rows = await listSources(stub as unknown as PrismaClient, "alice");
    expect(rows[0].allowPrivateHost).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The poller path — rows that predate this change
// ─────────────────────────────────────────────────────────────────────────────

describe("syncSource — a pre-existing internal source fails closed on its next tick", () => {
  it("refuses an already-registered RFC1918 URL and opens no socket", async () => {
    // The row the migration back-fills: registered before the guard existed,
    // allowPrivateHost defaulted to false, nobody has touched it since.
    const stub = makeStub([{ id: "legacy", url: "http://192.168.1.1/dav/" }]);
    const spy = sentinelFetch();

    const result = await syncSource(stub as unknown as PrismaClient, "legacy");

    expect(result.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    expect(result.total).toBe(0);
    // THE assertion — the poller re-runs this every syncIntervalSec.
    expect(spy).not.toHaveBeenCalled();
  });

  it("records the refusal in lastSyncError so the panel can explain it", async () => {
    const stub = makeStub([{ id: "legacy", url: "http://127.0.0.1:9200/dav/" }]);
    sentinelFetch();

    await syncSource(stub as unknown as PrismaClient, "legacy");

    const row = stub.sources.find((s) => s.id === "legacy");
    expect(row?.lastSyncError).toBe(BLOCKED_DESTINATION_MESSAGE);
    expect(row?.lastSyncAt).toBeInstanceOf(Date);
  });

  it("still syncs a flagged LAN source — the escape hatch survives the poller", async () => {
    const stub = makeStub([
      { id: "lan", url: "http://192.168.1.50/dav/", allowPrivateHost: true },
    ]);
    const spy = vi.fn(async () =>
      new Response(
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:lan-1\r\nSUMMARY:Standup\r\n" +
          "DTSTART:20260901T090000Z\r\nDTEND:20260901T093000Z\r\n" +
          "END:VEVENT\r\nEND:VCALENDAR",
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", spy);

    const result = await syncSource(stub as unknown as PrismaClient, "lan");

    expect(result.error).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // MUTATION GUARD: if syncSource stops forwarding the column, the flagged
  // LAN source above starts failing — and, worse, a legacy row could be
  // fetched if the default were ever read as truthy.
  it("treats a row whose column is missing entirely as NOT flagged", async () => {
    // A row read back before `prisma generate` knows the column — undefined,
    // not false. `=== true` is the only comparison that fails closed here.
    const stub = makeStub([{ id: "old" }]);
    stub.sources[0].url = "http://10.0.0.5/dav/";
    (stub.sources[0] as { allowPrivateHost?: boolean }).allowPrivateHost = undefined;
    const spy = sentinelFetch();

    const result = await syncSource(stub as unknown as PrismaClient, "old");

    expect(result.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    expect(spy).not.toHaveBeenCalled();
  });
});
