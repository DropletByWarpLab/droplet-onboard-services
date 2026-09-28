/**
 * WARP-3200 — deleting a workshop workspace cannot orphan an extension, on a
 * REAL Postgres.
 *
 * The delete refuses while an extension that can still be installed is built
 * from the workspace. Two writers can make one installable while a delete is
 * in flight: a promote's store (creates or revives the row as `signed`) and
 * an enable's claim (`uninstalled` → `signed`). The mocked suites pin that
 * each takes the workspace hold inside its write transaction; only a real
 * Postgres shows that the locks actually serialise them. Each race here is
 * forced, not hoped for: one side is parked INSIDE its transaction (after
 * its locking statement ran), and the other is released only once
 * pg_stat_activity shows it waiting on a lock.
 *
 *   - a delete holding the row: the real promote, and the real enable, wait
 *     for it, find no workspace, and store nothing;
 *   - a promote, or an enable, holding the row: the delete waits, then sees
 *     the `signed` extension and refuses, and the workspace stays;
 *   - control: a writer that takes no hold is NOT stopped by the parked
 *     delete, and the same interleaving leaves an extension whose workspace
 *     is gone. That is the race the hold closes.
 *
 * Real-Postgres and gated exactly like the other `*.pg.test.ts` suites.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({ config: { SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "t" } }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn(async () => null) }));

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";
import { deleteWorkspaceRowUnlessSource } from "../services/workspace-source-guard.service.js";
import {
  confirmPromotion,
  createPromoteConfirmationStore,
  preparePromotion,
  PromoteError,
  type PromoteDeps,
} from "../services/extension-promote.service.js";
import { createExtensionLifecycle, type ExtensionLifecycle } from "../services/extension-lifecycle.service.js";
import { deriveExtensionSlug } from "../services/extension-manifest.js";
import type { ActivityActor } from "../services/activity.service.js";
import { fakeSandbox, fakeSidecar, manifestBytes } from "./helpers/extension-test-kit.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const OWNER = { id: "u-owner-3200", actor: { type: "user", id: "u-owner-3200" } as ActivityActor };

/**
 * `real`, except that inside a `$transaction` the named call, once it has
 * run, waits for `release()` — its transaction still open, holding what it
 * locked. `paused` resolves when it is waiting.
 */
function parkAfter(real: PrismaClient, model: string, method: string) {
  let onPaused!: () => void;
  const paused = new Promise<void>((r) => (onPaused = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const bound = (target: object, p: PropertyKey) => {
    const v = Reflect.get(target, p) as unknown;
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  };
  const parkTx = (tx: object) =>
    new Proxy(tx, {
      get(t, p) {
        if (p !== model) return bound(t, p);
        return new Proxy(Reflect.get(t, p) as object, {
          get(d, q) {
            if (q !== method) return bound(d, q);
            const fn = Reflect.get(d, q) as (...a: unknown[]) => Promise<unknown>;
            return async (...args: unknown[]) => {
              const out = await fn.apply(d, args);
              onPaused();
              await gate;
              return out;
            };
          },
        });
      },
    });
  const client = new Proxy(real, {
    get(target, p) {
      if (p !== "$transaction") return bound(target, p);
      // The parked transaction outlives Prisma's 5 s default while the other
      // side is observed waiting; its isolation level is kept as passed.
      return (fn: (tx: unknown) => Promise<unknown>, options?: Record<string, unknown>) =>
        target.$transaction((tx) => fn(parkTx(tx)), { ...(options ?? {}), timeout: 20_000 });
    },
  }) as PrismaClient;
  return { client, paused, release };
}

/** Settles into a value or the error, so a refusal can be awaited later. */
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe.skipIf(!RUN)("deleting a workspace cannot orphan an extension (WARP-3200)", () => {
  let prisma: PrismaClient;
  const created: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterEach(async () => {
    if (created.length > 0) {
      // ExtensionVersion cascades with its extension.
      await prisma.extension.deleteMany({ where: { workspaceId: { in: created } } });
      await prisma.workshopWorkspace.deleteMany({ where: { id: { in: created } } });
      created.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Blocks until some backend waits on a lock while running `fragment`. */
  async function waitingOnLock(fragment: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${`%${fragment}%`}`;
      if (rows[0]!.n > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no backend waited on a lock running ${fragment}`);
  }

  /** A proposed workspace, and promote deps whose sandbox proposes its manifest. */
  async function proposedWorkspace() {
    const id = `wsdel${Date.now().toString(36)}-n${(seq += 1)}`;
    created.push(id);
    await prisma.workshopWorkspace.create({
      data: { id, userId: OWNER.id, name: "Word counter", status: "proposed", proposedTag: "proposal/0.1.0", proposedAt: new Date() },
    });
    const sandbox = fakeSandbox({ proposals: { [id]: manifestBytes({ id }) } });
    const identity = fakeSidecar();
    const install = vi.fn(async () => undefined);
    const deps = (client: PrismaClient): PromoteDeps => ({
      prisma: client,
      sandbox: sandbox.client,
      identity,
      lifecycle: { install } as unknown as ExtensionLifecycle,
      confirmations,
      audit: vi.fn(async () => null),
    });
    const confirmations = createPromoteConfirmationStore();
    return { id, slug: deriveExtensionSlug(id), sandbox, identity, install, deps };
  }

  async function promote(ws: Awaited<ReturnType<typeof proposedWorkspace>>, client: PrismaClient = prisma) {
    const p1 = await preparePromotion(ws.deps(prisma), OWNER, ws.id);
    return confirmPromotion(ws.deps(client), OWNER, ws.id, {
      confirmationToken: p1.confirmationToken,
      manifestSha256: p1.manifestSha256,
    });
  }

  /** A promoted extension the owner has since uninstalled: an enable can revive it. */
  async function uninstalledExtension() {
    const ws = await proposedWorkspace();
    await promote(ws);
    await prisma.extension.update({ where: { id: ws.slug }, data: { status: "uninstalled" } });
    const lifecycle = (client: PrismaClient) =>
      createExtensionLifecycle({ prisma: client, sandbox: ws.sandbox.client, identity: ws.identity, audit: vi.fn(async () => null) });
    return { ...ws, lifecycle };
  }

  it("a delete holding the row: the promote waits, finds no workspace, and stores nothing", async () => {
    const ws = await proposedWorkspace();
    const p1 = await preparePromotion(ws.deps(prisma), OWNER, ws.id);
    const del = parkAfter(prisma, "workshopWorkspace", "delete");
    const deleting = deleteWorkspaceRowUnlessSource(del.client, ws.id);
    await del.paused;

    const promoting = settle(
      confirmPromotion(ws.deps(prisma), OWNER, ws.id, { confirmationToken: p1.confirmationToken, manifestSha256: p1.manifestSha256 }),
    );
    await waitingOnLock("FOR KEY SHARE");
    del.release();

    expect(await deleting).toEqual({ deleted: true });
    const outcome = await promoting;
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toBeInstanceOf(PromoteError);
    expect(!outcome.ok && outcome.error).toMatchObject({ httpStatus: 404, code: "not_found" });
    expect(await prisma.extension.count({ where: { workspaceId: ws.id } })).toBe(0);
    expect(await prisma.extensionVersion.count({ where: { extensionId: ws.slug } })).toBe(0);
    expect(ws.install).not.toHaveBeenCalled();
  });

  it("a promote holding the row: the delete waits, sees the signed extension, refuses, and the workspace stays", async () => {
    const ws = await proposedWorkspace();
    const prom = parkAfter(prisma, "extension", "update");
    const promoting = settle(promote(ws, prom.client));
    await prom.paused;

    const deleting = deleteWorkspaceRowUnlessSource(prisma, ws.id);
    await waitingOnLock("FOR UPDATE");
    prom.release();

    const outcome = await promoting;
    expect(outcome.ok).toBe(true);
    expect(await deleting).toEqual({ deleted: false, reason: "extension_source", extensionName: "Word counter" });
    expect(await prisma.workshopWorkspace.count({ where: { id: ws.id } })).toBe(1);
    expect(await prisma.extension.findUnique({ where: { id: ws.slug }, select: { status: true } })).toEqual({ status: "signed" });
  });

  it("a delete holding the row: the enable of an uninstalled extension waits, finds no workspace, and nothing moves", async () => {
    const ext = await uninstalledExtension();
    const del = parkAfter(prisma, "workshopWorkspace", "delete");
    const deleting = deleteWorkspaceRowUnlessSource(del.client, ext.id);
    await del.paused;

    const enabling = settle(ext.lifecycle(prisma).enable(ext.slug, OWNER.actor));
    await waitingOnLock("FOR KEY SHARE");
    del.release();

    expect(await deleting).toEqual({ deleted: true });
    const outcome = await enabling;
    expect(!outcome.ok && outcome.error).toMatchObject({ code: "source_deleted", httpStatus: 409 });
    expect(await prisma.extension.findUnique({ where: { id: ext.slug }, select: { status: true } })).toEqual({ status: "uninstalled" });
    expect(ext.sandbox.installs).toEqual([]);
  });

  it("an enable holding the row: the delete waits, sees the revived extension, refuses, and the workspace stays", async () => {
    const ext = await uninstalledExtension();
    const en = parkAfter(prisma, "extension", "updateMany");
    const enabling = settle(ext.lifecycle(en.client).enable(ext.slug, OWNER.actor));
    await en.paused;

    const deleting = deleteWorkspaceRowUnlessSource(prisma, ext.id);
    await waitingOnLock("FOR UPDATE");
    en.release();

    expect(await deleting).toEqual({ deleted: false, reason: "extension_source", extensionName: "Word counter" });
    const outcome = await enabling;
    expect(outcome.ok).toBe(true);
    expect(await prisma.workshopWorkspace.count({ where: { id: ext.id } })).toBe(1);
    expect(ext.sandbox.installs.map((i) => i.req.workspaceId)).toEqual([ext.id]);
  });

  it("control: a writer that takes no hold is not stopped, and the same interleaving orphans an extension", async () => {
    // What the hold closes. Were the race not real — the parked delete
    // blocking this writer some other way — the test above would pass
    // without the hold, and prove nothing.
    const ws = await proposedWorkspace();
    const del = parkAfter(prisma, "workshopWorkspace", "delete");
    const deleting = deleteWorkspaceRowUnlessSource(del.client, ws.id);
    await del.paused;

    await prisma.$transaction(
      (tx) =>
        tx.extension.create({
          data: { id: ws.slug, workspaceId: ws.id, name: "Word counter", installedByUserId: OWNER.id, status: "signed" },
        }),
      READ_COMMITTED_TX,
    );
    del.release();

    expect(await deleting).toEqual({ deleted: true });
    expect(await prisma.workshopWorkspace.count({ where: { id: ws.id } })).toBe(0);
    expect(await prisma.extension.findUnique({ where: { id: ws.slug }, select: { status: true } })).toEqual({ status: "signed" });
  });
});
