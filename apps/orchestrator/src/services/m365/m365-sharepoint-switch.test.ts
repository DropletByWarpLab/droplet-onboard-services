/**
 * WARP-3538 — the person's SharePoint switch (`setSharePointEnabled`).
 *
 * Two promises, one in each direction:
 *
 *   - ON asks Microsoft for nothing and reads nothing by itself: it records the
 *     person's choice on a connection that exists and is CONNECTED, and the next
 *     sign-in (and only that) asks for `Sites.Read.All`. A person cannot opt in
 *     before they are connected, and a disconnect that lands between the read and
 *     the write cannot be undone by it.
 *   - OFF is a deletion the confirmation dialog promised ("Droplet deletes the
 *     list of SharePoint files it kept and stops reading them"): the flag, the
 *     SharePoint cursors, the library rows and the landed SharePoint items go in
 *     ONE transaction — all or none — and OneDrive, every other workload and every
 *     other person are untouched.
 *
 * Prisma is an in-memory world whose tables EVALUATE their arguments, so a
 * dropped `userId` or `workload` predicate shows up as a row that should have
 * survived. Its `$transaction` is real enough to matter: it hands the callback a
 * DIFFERENT handle than the client's, it rolls every table back if the callback
 * throws, and it records which handle each statement went through — so "in one
 * transaction" is something these tests can see, not something they take on
 * trust.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { recordActivityMock } = vi.hoisted(() => ({ recordActivityMock: vi.fn().mockResolvedValue(null) }));
vi.mock("../activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { makeFakeCloudFileDb } from "../../__tests__/helpers/fake-cloud-files.js";
import { makeFakeTable, matchesWhere, type Row } from "../../__tests__/helpers/fake-table.js";
import { setSharePointEnabled } from "./m365-auth.service.js";

const USER = "user-1";
const OTHER = "user-2";
const BASE =
  "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Files.ReadWrite.All";
const WITH_SITES = `${BASE} Sites.Read.All`;

beforeEach(() => {
  recordActivityMock.mockClear();
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 3).toString("base64"));
});
afterEach(() => __setColumnCryptoKeyForTest(null));

type Via = "client" | "tx";
interface Call {
  via: Via;
  op: string;
  inTransaction: boolean;
}

/** The whole world: connections, cursors and the two cloud-file tables, behind a client and a transaction handle. */
function world(rows: Row[] = []) {
  const connections: Row[] = rows.map((r) => ({ ...r }));
  const cursors = makeFakeTable(() => ({}));
  const cloud = makeFakeCloudFileDb();
  let inTransaction = false;
  const calls: Call[] = [];

  const connection = {
    findUnique: async ({ where }: { where: Row }) => {
      const hit = connections.find((r) => matchesWhere(r, where));
      return hit ? { ...hit } : null;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = connections.filter((r) => matchesWhere(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };

  /** Every method of a delegate, recorded with the handle it was called through. */
  const through = <T extends Record<string, (...a: never[]) => unknown>>(via: Via, name: string, delegate: T): T =>
    Object.fromEntries(
      Object.entries(delegate).map(([method, fn]) => [
        method,
        (...args: never[]) => {
          calls.push({ via, op: `${name}.${method}`, inTransaction });
          return fn(...args);
        },
      ]),
    ) as T;

  const handle = (via: Via) => ({
    m365Connection: through(via, "m365Connection", connection),
    m365DeltaCursor: through(via, "m365DeltaCursor", cursors.delegate as never),
    cloudFileItem: through(via, "cloudFileItem", cloud.cloudFileItem as never),
    cloudFileSource: through(via, "cloudFileSource", cloud.cloudFileSource as never),
  });

  const tables = [connections, cursors.rows, cloud.items, cloud.sources];
  const tx = handle("tx");
  const prisma = {
    ...handle("client"),
    $transaction: vi.fn(async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      const before = tables.map((t) => t.map((r) => ({ ...r })));
      inTransaction = true;
      try {
        return await fn(tx);
      } catch (err) {
        // A real transaction leaves nothing behind when it fails.
        tables.forEach((t, i) => t.splice(0, t.length, ...before[i]!));
        throw err;
      } finally {
        inTransaction = false;
      }
    }),
  };

  return {
    prisma: prisma as never,
    $transaction: prisma.$transaction,
    calls,
    connection: (userId = USER) => connections.find((r) => r.userId === userId) ?? null,
    connections,
    cursor: (userId: string, workload: string, resourceId: string) => cursors.seed({ userId, workload, resourceId }),
    cursorKeys: (userId: string) =>
      cursors.rows.filter((r) => r.userId === userId).map((r) => `${r.workload}:${r.resourceId}`).sort(),
    library: (userId: string, sourceId: string) =>
      cloud.seedSource({ userId, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId, nameEnc: "dcv1:x" }),
    oneDrive: (userId: string, sourceId: string) =>
      cloud.seedSource({ userId, provider: "M365", kind: "ONEDRIVE", sourceId, nameEnc: "dcv1:x" }),
    item: (userId: string, sourceId: string, externalId: string) =>
      cloud.seedItem({ userId, provider: "M365", sourceId, externalId, isFolder: false, nameEnc: "dcv1:x" }),
    items: (userId: string) => cloud.items.filter((r) => r.userId === userId).map((r) => r.externalId as string).sort(),
    sources: (userId: string) => cloud.sources.filter((r) => r.userId === userId).map((r) => r.sourceId as string).sort(),
    cloud,
  };
}

const connected = (over: Row = {}): Row => ({
  id: "row-1",
  userId: USER,
  state: "CONNECTED",
  grantedScopes: BASE,
  sharePointEnabled: false,
  sharePointLibrariesCapped: 0,
  ...over,
});

/** A person with SharePoint on, two libraries read and landed, and a OneDrive — and somebody else with the same. */
function populated(over: Row = {}) {
  const w = world([
    connected({ sharePointEnabled: true, sharePointLibrariesCapped: 7, grantedScopes: WITH_SITES, ...over }),
    connected({ id: "row-2", userId: OTHER, sharePointEnabled: true, sharePointLibrariesCapped: 3, grantedScopes: WITH_SITES }),
  ]);
  for (const user of [USER, OTHER]) {
    w.cursor(user, "sharepoint", `lib-${user}-1`);
    w.cursor(user, "sharepoint", `lib-${user}-2`);
    w.cursor(user, "files", "-");
    w.cursor(user, "mail", "inbox");
    w.library(user, `lib-${user}-1`);
    w.library(user, `lib-${user}-2`);
    w.oneDrive(user, `od-${user}`);
    w.item(user, `lib-${user}-1`, `${user}-a`);
    w.item(user, `lib-${user}-2`, `${user}-b`);
    w.item(user, `od-${user}`, `${user}-c`);
  }
  return w;
}

const audits = () =>
  recordActivityMock.mock.calls.map((c) => c[0] as { what: string; sub: string; actor: unknown; refs: Record<string, unknown> });

describe("setSharePointEnabled — turning it ON", () => {
  it("records the choice on a connected person's row, and says Microsoft has not approved it yet", async () => {
    const w = world([connected()]);
    const r = await setSharePointEnabled(w.prisma, USER, true);

    expect(w.connection()).toMatchObject({ sharePointEnabled: true });
    // The base grant reads drives but cannot find one: the card now offers "Sign in again".
    expect(r).toEqual({
      ok: true,
      changed: true,
      view: expect.objectContaining({
        state: "CONNECTED",
        sharePoint: { enabled: true, granted: false, needsConsent: true },
      }),
    });
  });

  it("needs no consent when the grant already holds Sites.Read.All", async () => {
    const w = world([connected({ grantedScopes: WITH_SITES })]);
    const r = await setSharePointEnabled(w.prisma, USER, true);
    expect(r).toMatchObject({ ok: true, view: { sharePoint: { enabled: true, granted: true, needsConsent: false } } });
  });

  it("is a no-op when it is already on: nothing written, nothing audited", async () => {
    const w = world([connected({ sharePointEnabled: true })]);
    const r = await setSharePointEnabled(w.prisma, USER, true);
    expect(r).toMatchObject({ ok: true, changed: false, view: { sharePoint: { enabled: true } } });
    expect(w.calls.filter((c) => c.op === "m365Connection.updateMany")).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it("refuses a person with no connection row — a person cannot opt in before they are connected", async () => {
    const w = world([]);
    expect(await setSharePointEnabled(w.prisma, USER, true)).toEqual({ ok: false, reason: "not_connected" });
    expect(w.calls.filter((c) => c.op.endsWith("updateMany"))).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it.each(["DISCONNECTED", "PENDING_CONSENT", "NEEDS_RECONNECT", "ERROR"])(
    "refuses a connection that is %s, and leaves the flag alone",
    async (state) => {
      // A row exists, but there is no live account to ask for the scope on: the
      // next sign-in is the person's to start, and the switch is offered only
      // once they are connected.
      const w = world([connected({ state })]);
      expect(await setSharePointEnabled(w.prisma, USER, true)).toEqual({ ok: false, reason: "not_connected" });
      expect(w.connection()).toMatchObject({ sharePointEnabled: false });
      expect(audits()).toEqual([]);
    },
  );

  it("cannot undo a disconnect that lands between its read and its write", async () => {
    // The write is conditional on the row still being CONNECTED. Without the
    // condition, a person who pressed Disconnect in another tab would find
    // SharePoint switched on for an account that is gone — and the next sign-in
    // would ask the tenant for a scope nobody asked for.
    const w = world([connected()]);
    const real = (w.prisma as { m365Connection: { findUnique: (a: never) => Promise<Row | null> } }).m365Connection.findUnique;
    (w.prisma as { m365Connection: { findUnique: unknown } }).m365Connection.findUnique = async (a: never) => {
      const seen = await real(a);
      w.connections[0]!.state = "DISCONNECTED"; // the disconnect lands now
      return seen;
    };
    expect(await setSharePointEnabled(w.prisma, USER, true)).toEqual({ ok: false, reason: "not_connected" });
    expect(w.connection()).toMatchObject({ state: "DISCONNECTED", sharePointEnabled: false });
    expect(audits()).toEqual([]);
  });

  it("reads and deletes nothing else: no cursor, no source, no item is touched by turning it on", async () => {
    const w = populated({ sharePointEnabled: false });
    await setSharePointEnabled(w.prisma, USER, true);
    expect(w.calls.filter((c) => /deleteMany/.test(c.op))).toEqual([]);
    expect(w.items(USER)).toEqual([`${USER}-a`, `${USER}-b`, `${USER}-c`]);
  });

  it("only ever writes the person's own row", async () => {
    const w = populated({ sharePointEnabled: false });
    w.connections[1]!.sharePointEnabled = false;
    await setSharePointEnabled(w.prisma, USER, true);
    expect(w.connection(OTHER)).toMatchObject({ sharePointEnabled: false });
  });

  it("audits the opt-in like every other Microsoft 365 lifecycle event — who, which state, and nothing secret", async () => {
    // Mutation: drop the audit call and this goes red. Widening what the box
    // reads on a person's behalf belongs in the log next to connect/disconnect.
    const w = world([connected()]);
    await setSharePointEnabled(w.prisma, USER, true);

    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      what: "Microsoft 365 SharePoint turned on",
      sub: "CONNECTED",
      actor: { type: "user", id: USER },
      refs: { connector: "m365", userId: USER, state: "CONNECTED" },
    });
    expect(JSON.stringify(audits())).not.toMatch(/token|secret|cache/i);
  });
});

describe("setSharePointEnabled — turning it OFF", () => {
  it("clears the choice and the cap count, and deletes the person's SharePoint cursors, libraries and files", async () => {
    const w = populated();
    const r = await setSharePointEnabled(w.prisma, USER, false);

    expect(r).toMatchObject({ ok: true, changed: true, view: { sharePoint: { enabled: false } } });
    expect(w.connection()).toMatchObject({ sharePointEnabled: false, sharePointLibrariesCapped: 0 });
    expect(w.cursorKeys(USER)).toEqual(["files:-", "mail:inbox"]);
    expect(w.sources(USER)).toEqual([`od-${USER}`]);
    expect(w.items(USER)).toEqual([`${USER}-c`]);
  });

  it("does it ALL in one transaction, through the transaction's own handle", async () => {
    // Mutation: run the same statements on the client instead of the callback's
    // handle (or drop `$transaction`) and a failure half way leaves the flag off
    // and some of the list behind — "Droplet deleted it" would be untrue.
    const w = populated();
    await setSharePointEnabled(w.prisma, USER, false);

    expect(w.$transaction).toHaveBeenCalledTimes(1);
    const writes = w.calls.filter((c) => /updateMany|deleteMany/.test(c.op));
    expect(writes.length).toBeGreaterThanOrEqual(4); // the flag, the cursors, the items, the sources
    for (const write of writes) {
      expect(write, `${write.op} must go through the transaction`).toMatchObject({ via: "tx", inTransaction: true });
    }
  });

  it("is all or none: a failure part way rolls the flag and every deletion back, and the call rejects", async () => {
    const w = populated();
    // The last statement of the removal fails — after it has done its work, as a
    // connection that drops on the way back would.
    const real = w.cloud.cloudFileSource.deleteMany.getMockImplementation()!;
    w.cloud.cloudFileSource.deleteMany.mockImplementation(async (a) => {
      await real(a);
      throw new Error("connection reset");
    });

    await expect(setSharePointEnabled(w.prisma, USER, false)).rejects.toThrow("connection reset");

    expect(w.connection()).toMatchObject({ sharePointEnabled: true, sharePointLibrariesCapped: 7 });
    expect(w.cursorKeys(USER)).toEqual(["files:-", "mail:inbox", `sharepoint:lib-${USER}-1`, `sharepoint:lib-${USER}-2`]);
    expect(w.items(USER)).toEqual([`${USER}-a`, `${USER}-b`, `${USER}-c`]);
    expect(w.sources(USER)).toEqual([`lib-${USER}-1`, `lib-${USER}-2`, `od-${USER}`]);
    // …and nothing says it was turned off.
    expect(audits()).toEqual([]);
  });

  it("leaves OneDrive, every other workload and every other person exactly as they were", async () => {
    // Mutation: drop `workload: "sharepoint"` or `userId` from the removal and
    // the confirmation's "OneDrive is not affected" — or somebody else's list —
    // is a lie.
    const w = populated();
    const before = { other: w.cursorKeys(OTHER), otherItems: w.items(OTHER), otherSources: w.sources(OTHER) };
    await setSharePointEnabled(w.prisma, USER, false);

    expect(w.cursorKeys(USER)).toContain("files:-");
    expect(w.cursorKeys(USER)).toContain("mail:inbox");
    expect(w.sources(USER)).toContain(`od-${USER}`);
    expect(w.items(USER)).toContain(`${USER}-c`);
    expect({ other: w.cursorKeys(OTHER), otherItems: w.items(OTHER), otherSources: w.sources(OTHER) }).toEqual(before);
    expect(w.connection(OTHER)).toMatchObject({ sharePointEnabled: true, sharePointLibrariesCapped: 3 });
  });

  it("audits that it was turned off — and only when it was on", async () => {
    const w = populated();
    await setSharePointEnabled(w.prisma, USER, false);
    expect(audits().map((a) => a.what)).toEqual(["Microsoft 365 SharePoint turned off"]);
    expect(audits()[0]).toMatchObject({ sub: "CONNECTED", actor: { type: "user", id: USER } });

    recordActivityMock.mockClear();
    const again = await setSharePointEnabled(w.prisma, USER, false);
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(audits()).toEqual([]);
  });

  it("converges when it is already off: whatever a race left behind is still removed", async () => {
    // Off is idempotent AND repairing — a person who presses it again, or a
    // discovery that re-created a library after the first removal, ends with
    // none of it left.
    const w = populated({ sharePointEnabled: false });
    await setSharePointEnabled(w.prisma, USER, false);
    expect(w.cursorKeys(USER)).toEqual(["files:-", "mail:inbox"]);
    expect(w.items(USER)).toEqual([`${USER}-c`]);
    expect(audits()).toEqual([]);
  });

  it.each(["CONNECTED", "NEEDS_RECONNECT", "ERROR", "DISCONNECTED", "PENDING_CONSENT"])(
    "works for a connection that is %s — switching something off is never refused",
    async (state) => {
      const w = populated({ state });
      const r = await setSharePointEnabled(w.prisma, USER, false);
      expect(r).toMatchObject({ ok: true, view: { sharePoint: { enabled: false } } });
      expect(w.items(USER)).toEqual([`${USER}-c`]);
    },
  );

  it("is a quiet success for a person with no connection at all", async () => {
    const w = world([]);
    expect(await setSharePointEnabled(w.prisma, USER, false)).toMatchObject({
      ok: true,
      changed: false,
      view: { state: "DISCONNECTED", sharePoint: { enabled: false, granted: false, needsConsent: false } },
    });
    expect(audits()).toEqual([]);
  });

  it("returns the view as it is AFTER the change, not the one it read first", async () => {
    const w = populated();
    const r = await setSharePointEnabled(w.prisma, USER, false);
    expect(r.ok && r.view.sharePoint).toEqual({ enabled: false, granted: true, needsConsent: false });
  });
});
