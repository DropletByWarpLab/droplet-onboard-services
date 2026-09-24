/**
 * WARP-2804 — the recipient's side of a notification: ack one, ack all, the
 * unread count, and the list.
 *
 * Run against the evaluating fake (helpers/fake-notification-log.ts), so each
 * predicate in the where-clauses is load-bearing here: drop `username` and
 * Maria's row is acked by Stefan; drop the `ackState` filter and a second ack
 * overwrites the first `ackedAt`; drop `before` and a notification that
 * arrived after the user looked is swept unseen; count `untracked` and every
 * badge fills with 90 days of history. The real-Postgres twin
 * (`notifications-ack.pg.test.ts`) proves the same against the CHECK and under
 * concurrency.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));

import {
  ackNotification,
  ackAllNotifications,
  countUnread,
  listNotifications,
  NOTIFICATION_ROW_SELECT,
} from "../services/notifications.service.js";
import { makeFakeNotificationLog, type FakeNotificationLog } from "./helpers/fake-notification-log.js";

const T0 = new Date("2026-09-24T08:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

let log: FakeNotificationLog;
let prisma: PrismaClient;

beforeEach(() => {
  vi.clearAllMocks();
  log = makeFakeNotificationLog(T0);
  prisma = { notificationLog: log.delegate } as unknown as PrismaClient;
});

const SAID = { sessionId: "sid-stefan-phone", client: "droplet-ios/1.4.0 (iOS 18.2)" };

describe("ackNotification", () => {
  it("acks the recipient's own unread row: state, time, method, sign-in and client", async () => {
    const row = log.seed({ username: "stefan", createdAt: at(0) });
    const before = Date.now();
    const out = await ackNotification(prisma, { id: row.id, username: "stefan", method: "inbox", ...SAID });
    expect(out?.changed).toBe(true);
    expect(out?.row).toMatchObject({ id: row.id, ackState: "acked", ackMethod: "inbox" });
    expect(out!.row.ackedAt!.getTime()).toBeGreaterThanOrEqual(before);
    // The device facts are STORED …
    expect(log.rows[0]).toMatchObject({ ackSessionId: SAID.sessionId, ackClient: SAID.client });
    // … and never handed back.
    expect(out!.row).not.toHaveProperty("ackSessionId");
    expect(out!.row).not.toHaveProperty("ackClient");
  });

  it("`opened` is recorded as the method", async () => {
    const row = log.seed({ username: "stefan" });
    const out = await ackNotification(prisma, { id: row.id, username: "stefan", method: "opened", ...SAID });
    expect(out?.row.ackMethod).toBe("opened");
  });

  it("MUTATION: first ack wins — a second ack changes nothing and returns the original", async () => {
    const row = log.seed({ username: "stefan" });
    const first = await ackNotification(prisma, { id: row.id, username: "stefan", method: "opened", ...SAID });
    await new Promise((r) => setTimeout(r, 5));
    const second = await ackNotification(prisma, {
      id: row.id,
      username: "stefan",
      method: "inbox",
      sessionId: "sid-stefan-laptop",
      client: "Edge on Windows",
    });
    expect(second?.changed).toBe(false);
    expect(second?.row.ackedAt).toEqual(first!.row.ackedAt);
    expect(second?.row.ackMethod).toBe("opened");
    expect(log.rows[0]).toMatchObject({ ackSessionId: SAID.sessionId, ackClient: SAID.client });
  });

  it("an `untracked` row (written before WARP-2804) can still be acked", async () => {
    const row = log.seed({ username: "stefan", ackState: "untracked" });
    const out = await ackNotification(prisma, { id: row.id, username: "stefan", method: "inbox", ...SAID });
    expect(out).toMatchObject({ changed: true, row: { ackState: "acked" } });
  });

  it("MUTATION: someone else's id is null — exactly like a missing one — and their row is untouched", async () => {
    const maria = log.seed({ username: "maria" });
    const out = await ackNotification(prisma, { id: maria.id, username: "stefan", method: "inbox", ...SAID });
    expect(out).toBeNull();
    expect(log.rows[0]).toMatchObject({ ackState: "unacked", ackedAt: null, ackSessionId: null, ackClient: null });
    expect(await ackNotification(prisma, { id: "log-missing", username: "stefan", method: "inbox", ...SAID })).toBeNull();
  });

  it("a token without a sid and a client that said nothing store NULLs", async () => {
    const row = log.seed({ username: "stefan" });
    await ackNotification(prisma, { id: row.id, username: "stefan", method: "inbox", sessionId: null, client: null });
    expect(log.rows[0]).toMatchObject({ ackState: "acked", ackSessionId: null, ackClient: null });
  });
});

describe("ackAllNotifications", () => {
  it("MUTATION: acks the recipient's unread rows up to `before`, and never one that arrived after", async () => {
    const a = log.seed({ username: "stefan", createdAt: at(0) });
    const b = log.seed({ username: "stefan", createdAt: at(10) });
    const late = log.seed({ username: "stefan", createdAt: at(20) });
    const out = await ackAllNotifications(prisma, { username: "stefan", before: at(10), ...SAID });
    expect(out).toEqual({ acked: 2, unread: 1 });
    const state = (id: string) => log.rows.find((r) => r.id === id)!;
    expect(state(a.id)).toMatchObject({ ackState: "acked", ackMethod: "all", ackSessionId: SAID.sessionId });
    expect(state(b.id)).toMatchObject({ ackState: "acked", ackMethod: "all" });
    expect(state(late.id)).toMatchObject({ ackState: "unacked", ackedAt: null });
  });

  it("`untracked` rows are not swept (they are not unread), another person's rows are never touched", async () => {
    const old = log.seed({ username: "stefan", createdAt: at(0), ackState: "untracked" });
    const maria = log.seed({ username: "maria", createdAt: at(1) });
    const out = await ackAllNotifications(prisma, { username: "stefan", before: at(30), ...SAID });
    expect(out).toEqual({ acked: 0, unread: 0 });
    expect(log.rows.find((r) => r.id === old.id)!.ackState).toBe("untracked");
    expect(log.rows.find((r) => r.id === maria.id)!.ackState).toBe("unacked");
  });

  it("an already-acked row keeps its first ack", async () => {
    const row = log.seed({ username: "stefan", createdAt: at(0) });
    await ackNotification(prisma, { id: row.id, username: "stefan", method: "opened", ...SAID });
    const out = await ackAllNotifications(prisma, { username: "stefan", before: at(30), sessionId: "sid-2", client: null });
    expect(out.acked).toBe(0);
    expect(log.rows[0]).toMatchObject({ ackMethod: "opened", ackSessionId: SAID.sessionId });
  });
});

describe("countUnread", () => {
  it("MUTATION: counts only the recipient's `unacked` rows — never `untracked`, never `acked`", async () => {
    log.seed({ username: "stefan", ackState: "unacked" });
    log.seed({ username: "stefan", ackState: "unacked" });
    log.seed({ username: "stefan", ackState: "untracked" });
    log.seed({ username: "stefan", ackState: "acked", ackedAt: at(0), ackMethod: "inbox" });
    log.seed({ username: "maria", ackState: "unacked" });
    expect(await countUnread(prisma, "stefan")).toBe(2);
  });
});

describe("listNotifications", () => {
  it("newest first; `state: 'unacked'` filters to unread", async () => {
    log.seed({ username: "stefan", createdAt: at(0), title: "old" });
    log.seed({ username: "stefan", createdAt: at(1), title: "seen", ackState: "acked", ackedAt: at(2), ackMethod: "inbox" });
    log.seed({ username: "stefan", createdAt: at(3), title: "new" });
    log.seed({ username: "stefan", createdAt: at(4), title: "history", ackState: "untracked" });
    log.seed({ username: "maria", createdAt: at(5), title: "not yours" });
    const all = await listNotifications(prisma, "stefan");
    expect(all.rows.map((r) => r.title)).toEqual(["history", "new", "seen", "old"]);
    const unread = await listNotifications(prisma, "stefan", { state: "unacked" });
    expect(unread.rows.map((r) => r.title)).toEqual(["new", "old"]);
  });

  it("the cursor pages without repeating or skipping, ties on createdAt broken by id", async () => {
    // Five rows, two of them in the same millisecond.
    for (const [i, s] of [[1, 0], [2, 1], [3, 1], [4, 2], [5, 3]] as const) {
      log.seed({ id: `n-${i}`, username: "stefan", createdAt: at(s) });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listNotifications(prisma, "stefan", { limit: 2, cursor });
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(["n-5", "n-4", "n-3", "n-2", "n-1"]);
    expect(pages).toBe(3);
  });

  it("the cursor is `<ms>.<id>`, and null on the last page", async () => {
    log.seed({ id: "n-1", username: "stefan", createdAt: at(0) });
    log.seed({ id: "n-2", username: "stefan", createdAt: at(1) });
    const first = await listNotifications(prisma, "stefan", { limit: 1 });
    expect(first.nextCursor).toBe(`${at(1).getTime()}.n-2`);
    const last = await listNotifications(prisma, "stefan", { limit: 1, cursor: first.nextCursor });
    expect(last.rows.map((r) => r.id)).toEqual(["n-1"]);
    expect(last.nextCursor).toBeNull();
  });

  it.each(["nope", "123", "abc.n-1", "1.", `${"9".repeat(16)}.n-1`, "1.a b"])("refuses the cursor %j", async (cursor) => {
    await expect(listNotifications(prisma, "stefan", { cursor })).rejects.toThrow(/invalid_cursor/);
  });

  it("the select never carries the ack's device facts", async () => {
    log.seed({
      username: "stefan",
      ackState: "acked",
      ackedAt: at(1),
      ackMethod: "opened",
      ackSessionId: "sid-x",
      ackClient: "Safari on iPhone",
    });
    const { rows } = await listNotifications(prisma, "stefan");
    expect(rows[0]).not.toHaveProperty("ackSessionId");
    expect(rows[0]).not.toHaveProperty("ackClient");
    expect(rows[0]).not.toHaveProperty("username");
    expect(rows[0]).toMatchObject({ ackState: "acked", ackMethod: "opened" });
    expect(Object.keys(NOTIFICATION_ROW_SELECT).sort()).toEqual(
      [
        "id",
        "kind",
        "title",
        "body",
        "url",
        "data",
        "channels",
        "deliveredAt",
        "error",
        "pushOutcome",
        "createdAt",
        "ackState",
        "ackedAt",
        "ackMethod",
      ].sort(),
    );
    expect(log.delegate.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: NOTIFICATION_ROW_SELECT }));
  });
});
