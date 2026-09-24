/**
 * WARP-2977 P2b-2 (spec §6.8, §9 PR-2) — the Matter door-lock adapter core,
 * against injected fakes: a LockStore that dedupes on `dedupeKey` the way the
 * SecurityEvent unique index does, and a LockDeviceSource whose list can be
 * held open so a live frame can land mid-sweep.
 *
 * What this lane cannot prove — that two real trackers collapse to one row in
 * Postgres, and that the Prisma store tells `duplicate` from `failed` — is
 * L0's `security-lock-adapter.pg.test.ts`.
 *
 * Every frame fixture uses the REAL wire shape the sidecar emits
 * (`controller.ts` setupNodeListeners): `{nodeId: String(nodeId), path, value}`
 * with `path` an OBJECT carrying `attributeName`. The string-path fixtures
 * elsewhere in the repo are not what crosses the bridge.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LOCK_READINGS,
  MATTER_DOOR_LOCK_CLUSTER_ID,
  SECURITY_LOCK_LIST_TIMEOUT_MS,
  SECURITY_LOCK_SWEEP_INTERVAL_MS,
  SECURITY_LOCK_SWEEP_LOCK_KEY,
  _resetSecurityLockAdapterForTests,
  createLockTracker,
  createPrismaLockStore,
  createSecurityLockAdapter,
  lockDedupeKey,
  lockDisplayName,
  lockFrameSubscriber,
  lockHealthRow,
  lockRowDraft,
  matterLockDeviceSource,
  parseLockFrame,
  parseLockRef,
  registerSecurityLockJobs,
  securityLockAdapter,
  securityLockHealthRow,
  startSecurityLockAdapter,
  stillUnlockedLocks,
  type KnownLock,
  type LockDeviceSource,
  type LockHealthInput,
  type LockLogger,
  type LockReading,
  type LockRowDraft,
  type LockSourceDevice,
  type LockStore,
  type LockWriteOutcome,
} from "./security-lock-adapter.js";
import type { MatterGrouped } from "../types/smart-home.js";

// ── fixtures ─────────────────────────────────────────────────────────────

const NODE = "4660";
const REF = `matter:${NODE}/1`;
const T0 = Date.parse("2026-09-23T02:14:00.000Z");

/** The sidecar's `state_changed` event, as matter.service re-emits it (no `type`). */
function frame(value: unknown, over: { nodeId?: unknown; path?: Record<string, unknown> | string } = {}) {
  return {
    nodeId: "nodeId" in over ? over.nodeId : NODE,
    path:
      over.path ??
      ({ endpointId: 1, clusterId: 257, attributeId: 0, attributeName: "lockState" } as Record<string, unknown>),
    value,
  };
}

function lockDevice(over: Partial<LockSourceDevice> = {}): LockSourceDevice {
  return {
    nodeId: NODE,
    name: "Smart Lock",
    friendlyName: "Back door lock",
    roomName: "Hall",
    connectionState: "connected",
    endpoints: [{ endpointId: 1, deviceTypes: [{ deviceType: 10, revision: 1 }], clusters: [3, 29, 257] }],
    attributes: { lockState: 2 },
    ...over,
  };
}

function clock(start = T0) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
    at: () => t,
  };
}

function quietLogger(): LockLogger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface StoredRow {
  id: string;
  draft: LockRowDraft;
}

/** Dedupes on dedupeKey like the unique index; ids ascend like the BigInt identity. */
function fakeStore() {
  const rows: StoredRow[] = [];
  let seq = 100;
  const store = {
    rows,
    lastReading: vi.fn(async (ref: string) => {
      const mine = rows
        .filter((r) => r.draft.sourceRef === ref)
        .sort(
          (a, b) =>
            b.draft.startedAt.getTime() - a.draft.startedAt.getTime() || Number(BigInt(b.id) - BigInt(a.id)),
        );
      return mine[0] ? { id: mine[0].id, reading: mine[0].draft.labels[0] } : null;
    }),
    write: vi.fn(async (draft: LockRowDraft): Promise<LockWriteOutcome> => {
      if (rows.some((r) => r.draft.dedupeKey === draft.dedupeKey)) return "duplicate";
      rows.push({ id: String(seq++), draft });
      return "recorded";
    }),
    idByDedupeKey: vi.fn(async (key: string) => rows.find((r) => r.draft.dedupeKey === key)?.id ?? null),
  };
  return store satisfies LockStore;
}

function seed(store: ReturnType<typeof fakeStore>, reading: LockReading, id = "7", at = new Date(T0 - 3_600_000)) {
  store.rows.push({
    id,
    draft: lockRowDraft({
      obs: { nodeId: NODE, endpointId: 1, ref: REF, reading },
      prevId: null,
      name: "Back door lock",
      via: "live",
      at,
    }),
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const obs = (reading: LockReading, nodeId = NODE, endpointId = 1) => ({
  nodeId,
  endpointId,
  ref: `matter:${nodeId}/${endpointId}`,
  reading,
});

function staticSource(devices: LockSourceDevice[] | (() => Promise<readonly LockSourceDevice[]>), up = true) {
  const list = vi.fn(typeof devices === "function" ? devices : async () => devices);
  const bridgeUp = vi.fn(() => up);
  return { list, bridgeUp } satisfies LockDeviceSource;
}

function adapterWith(opts: {
  store?: ReturnType<typeof fakeStore>;
  source?: LockDeviceSource;
  c?: ReturnType<typeof clock>;
  logger?: ReturnType<typeof quietLogger>;
}) {
  const store = opts.store ?? fakeStore();
  const c = opts.c ?? clock();
  const logger = opts.logger ?? quietLogger();
  const emitter = new EventEmitter();
  const subscribeStateChanges = vi.fn((cb: (e: unknown) => void) => {
    emitter.on("state_changed", cb);
    return () => emitter.off("state_changed", cb);
  });
  const adapter = createSecurityLockAdapter({
    store,
    source: opts.source ?? staticSource([lockDevice()]),
    subscribeStateChanges,
    now: c.now,
    logger,
  });
  return { adapter, store, c, logger, emitter, subscribeStateChanges };
}

afterEach(() => {
  _resetSecurityLockAdapterForTests();
});

// ── parse ────────────────────────────────────────────────────────────────

describe("parseLockFrame — only a DoorLock.LockState report on the real object path", () => {
  it("reads the real wire shape", () => {
    expect(parseLockFrame(frame(1))).toEqual({ nodeId: NODE, endpointId: 1, ref: REF, reading: "locked" });
  });

  it.each<[unknown, LockReading]>([
    [1, "locked"],
    [2, "unlocked"],
    [0, "not_fully_locked"],
    [3, "unlatched"],
    [null, "unknown"],
  ])("maps the RAW number %s to %s", (value, reading) => {
    expect(parseLockFrame(frame(value))?.reading).toBe(reading);
  });

  it("ignores OnOff (cluster 6) even at attribute 0", () => {
    expect(parseLockFrame(frame(1, { path: { endpointId: 1, clusterId: 6, attributeId: 0, attributeName: "onOff" } }))).toBeNull();
  });

  it("ignores another DoorLock attribute (attributeId 3)", () => {
    expect(
      parseLockFrame(frame(1, { path: { endpointId: 1, clusterId: 257, attributeId: 3, attributeName: "doorState" } })),
    ).toBeNull();
  });

  it("ignores a Dimmable Light (device type 0x0101) reporting its level: a lock is never identified by device type", () => {
    expect(
      parseLockFrame(frame(1, { path: { endpointId: 1, clusterId: 8, attributeId: 0, attributeName: "currentLevel" } })),
    ).toBeNull();
    expect(0x0101).toBe(MATTER_DOOR_LOCK_CLUSTER_ID); // the collision this rule exists for
  });

  it("ignores a STRING path — not the wire shape", () => {
    expect(parseLockFrame(frame(1, { path: "1/257/0" }))).toBeNull();
    expect(parseLockFrame({ nodeId: NODE, path: "1/257/0/lockState", value: 1 })).toBeNull();
  });

  it.each([4, 255, -1, "1", true, undefined, {}])("drops the non-LockState value %j", (value) => {
    expect(parseLockFrame(frame(value))).toBeNull();
  });

  it.each([["abc"], [""], ["-1"], ["1.5"], ["123456789012345678901"], ["18446744073709551616"], [4660], [null]])(
    "drops the bad nodeId %j",
    (nodeId) => {
      expect(parseLockFrame(frame(1, { nodeId }))).toBeNull();
    },
  );

  it("accepts the largest uint64 node id and canonicalises leading zeros to one key", () => {
    expect(parseLockFrame(frame(1, { nodeId: "18446744073709551615" }))?.ref).toBe("matter:18446744073709551615/1");
    expect(parseLockFrame(frame(1, { nodeId: "004660" }))?.ref).toBe(REF);
  });

  it.each([0, 65535, 1.5, "1", null])("drops the endpoint %j", (endpointId) => {
    expect(
      parseLockFrame(frame(1, { path: { endpointId, clusterId: 257, attributeId: 0, attributeName: "lockState" } })),
    ).toBeNull();
  });

  it("does not need attributeName — the ids decide", () => {
    expect(parseLockFrame(frame(2, { path: { endpointId: 2, clusterId: 257, attributeId: 0 } }))?.ref).toBe(`matter:${NODE}/2`);
  });

  it.each([null, undefined, "x", 1, [], { path: null }])("drops the non-frame %j", (e) => {
    expect(parseLockFrame(e)).toBeNull();
  });
});

// ── the row ──────────────────────────────────────────────────────────────

describe("lockRowDraft", () => {
  const at = new Date(T0);

  it("is a lock_state row that states the reading and nothing else", () => {
    expect(lockRowDraft({ obs: obs("unlocked"), prevId: "41", name: "Back door lock", via: "live", at })).toEqual({
      source: "matter_lock",
      kind: "lock_state",
      severity: "info",
      camera: null,
      sourceRef: REF,
      dedupeKey: `matter_lock:${NODE}/1:after:41:unlocked`,
      labels: ["unlocked"],
      cameraZones: [],
      score: null,
      startedAt: at,
      endedAt: null,
      summary: "Back door lock: unlocked",
      observed: "live",
    });
  });

  it.each(LOCK_READINGS.map((r) => [r, r === "not_fully_locked" ? "notice" : "info"]))(
    "%s is severity %s",
    (reading, severity) => {
      expect(lockRowDraft({ obs: obs(reading as LockReading), prevId: null, name: "L", via: "live", at }).severity).toBe(severity);
    },
  );

  it("a polled row says it was found by the check", () => {
    const d = lockRowDraft({ obs: obs("not_fully_locked"), prevId: null, name: "Back door lock", via: "polled", at });
    expect(d.summary).toBe("Back door lock: not fully locked (found when Droplet checked)");
    expect(d.observed).toBe("polled");
  });

  it("dedupeKey is deterministic: node, endpoint, the previous row, the reading", () => {
    expect(lockDedupeKey(obs("locked"), null)).toBe(`matter_lock:${NODE}/1:after:none:locked`);
    expect(lockDedupeKey(obs("locked", NODE, 2), "9")).toBe(`matter_lock:${NODE}/2:after:9:locked`);
  });

  it("name: the alias, else the device-list name, else 'Lock …<last4>'", () => {
    expect(lockDisplayName({ nodeId: NODE, friendlyName: "Back door lock", name: "Smart Lock" })).toBe("Back door lock");
    expect(lockDisplayName({ nodeId: NODE, friendlyName: null, name: "Smart Lock" })).toBe("Smart Lock");
    expect(lockDisplayName({ nodeId: "123456789", friendlyName: "  ", name: "" })).toBe("Lock …6789");
    expect(lockDisplayName({ nodeId: NODE, friendlyName: "Back\ndoor\u0007 lock" })).toBe("Back door lock");
  });

  it("name: cut by code point, never leaving half an emoji; a lone surrogate becomes U+FFFD", () => {
    const long = `${"a".repeat(79)}\u{1F512}tail`; // the emoji straddles UTF-16 units 80 and 81
    const cut = lockDisplayName({ nodeId: NODE, friendlyName: long });
    expect(cut).toBe(`${"a".repeat(79)}\u{1F512}`);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(lockDisplayName({ nodeId: NODE, friendlyName: "Gate \uD83D" })).toBe("Gate \uFFFD");
    expect(lockDisplayName({ nodeId: NODE, friendlyName: "\uDD12 Gate" })).toBe("\uFFFD Gate");
  });
});

// ── the tracker ──────────────────────────────────────────────────────────

describe("createLockTracker — transitions only, memory moves only with the store", () => {
  let store: ReturnType<typeof fakeStore>;
  let c: ReturnType<typeof clock>;
  let tracker: ReturnType<typeof createLockTracker>;

  beforeEach(() => {
    store = fakeStore();
    c = clock();
    tracker = createLockTracker({ store, now: c.now, logger: quietLogger(), nameOf: () => "Back door lock" });
  });

  it("first sight with no stored row writes a baseline stamped at receipt", async () => {
    await expect(tracker.observe(obs("locked"), "live")).resolves.toBe("recorded");
    expect(store.lastReading).toHaveBeenCalledWith(REF);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].draft).toMatchObject({
      dedupeKey: `matter_lock:${NODE}/1:after:none:locked`,
      labels: ["locked"],
      observed: "live",
      startedAt: new Date(T0),
      summary: "Back door lock: locked",
    });
  });

  it("first sight that matches the stored reading writes nothing", async () => {
    seed(store, "locked");
    await expect(tracker.observe(obs("locked"), "live")).resolves.toBe("unchanged");
    expect(store.write).not.toHaveBeenCalled();
  });

  it("first sight that differs from the stored reading chains after the stored row", async () => {
    seed(store, "locked", "7");
    await tracker.observe(obs("unlocked"), "live");
    expect(store.rows.map((r) => r.draft.dedupeKey)).toEqual([
      `matter_lock:${NODE}/1:after:none:locked`,
      `matter_lock:${NODE}/1:after:7:unlocked`,
    ]);
  });

  it("writes transitions only, each after the row before it; reads history once", async () => {
    for (const r of ["locked", "locked", "unlocked", "unlocked", "locked"] as const) {
      c.advance(1000);
      await tracker.observe(obs(r), "live");
    }
    expect(store.rows.map((r) => r.draft.dedupeKey)).toEqual([
      `matter_lock:${NODE}/1:after:none:locked`,
      `matter_lock:${NODE}/1:after:100:unlocked`,
      `matter_lock:${NODE}/1:after:101:locked`,
    ]);
    expect(store.lastReading).toHaveBeenCalledTimes(1);
  });

  it("a failed write keeps the old reading, so the next frame retries (and a return to it writes nothing)", async () => {
    seed(store, "locked", "7");
    store.write.mockResolvedValueOnce("failed");
    await expect(tracker.observe(obs("unlocked"), "live")).resolves.toBe("failed");
    expect(store.rows).toHaveLength(1);

    // Memory still says locked: the same unlocked frame is written this time.
    await expect(tracker.observe(obs("unlocked"), "live")).resolves.toBe("recorded");
    expect(store.rows.at(-1)?.draft.dedupeKey).toBe(`matter_lock:${NODE}/1:after:7:unlocked`);
    expect(store.write).toHaveBeenCalledTimes(2);
  });

  it("after a failed write, the device going back to the stored reading is no change", async () => {
    seed(store, "locked", "7");
    store.write.mockResolvedValueOnce("failed");
    await tracker.observe(obs("unlocked"), "live");
    await expect(tracker.observe(obs("locked"), "live")).resolves.toBe("unchanged");
    expect(store.write).toHaveBeenCalledTimes(1);
  });

  // Review F2: `failed` can be a lie — a connection dropped after COMMIT. Memory
  // must not survive a failed write, or the store's real latest row is never seen.
  describe("a write that LANDED but was reported failed (a drop after COMMIT)", () => {
    const landedThen = (outcome: "failed" | "throw") => {
      const real = store.write.getMockImplementation()!;
      store.write.mockImplementationOnce(async (draft: LockRowDraft) => {
        await real(draft);
        if (outcome === "throw") throw new Error("connection terminated after commit");
        return "failed";
      });
    };

    it.each(["failed", "throw"] as const)(
      "(%s) the door locked again before any retry: the history is read back, so the store's 'unlocked' is corrected",
      async (outcome) => {
        seed(store, "locked", "7");
        landedThen(outcome);
        await expect(tracker.observe(obs("unlocked"), "live")).resolves.toBe("failed");
        expect(store.rows.map((r) => r.draft.labels[0])).toEqual(["locked", "unlocked"]); // it did land
        const landedId = store.rows[1]!.id;

        await expect(tracker.observe(obs("locked"), "live")).resolves.toBe("recorded");
        expect(store.rows.map((r) => r.draft.labels[0])).toEqual(["locked", "unlocked", "locked"]);
        expect(store.rows.at(-1)?.draft.dedupeKey).toBe(`matter_lock:${NODE}/1:after:${landedId}:locked`);
        expect(tracker.writeHealth().unsaved).toBe(0);
      },
    );

    it("the same reading again: the landed row is found in the history — nothing re-sent, nothing owed", async () => {
      seed(store, "locked", "7");
      landedThen("failed");
      await tracker.observe(obs("unlocked"), "live");
      expect(tracker.writeHealth().unsaved).toBe(1);
      await expect(tracker.observe(obs("unlocked"), "live")).resolves.toBe("unchanged");
      expect(store.write).toHaveBeenCalledTimes(1);
      expect(store.rows).toHaveLength(2);
      expect(tracker.writeHealth().unsaved).toBe(0);
    });
  });

  it("a write that THROWS is a failure like any other", async () => {
    seed(store, "locked", "7");
    store.write.mockRejectedValueOnce(new Error("pool closed"));
    await expect(tracker.observe(obs("unlocked"), "live")).resolves.toBe("failed");
    await expect(tracker.observe(obs("unlocked"), "live")).resolves.toBe("recorded");
    expect(tracker.writeHealth().lastWriteError?.message).toBe("pool closed");
  });

  it("a failed history read writes nothing, and the next frame reads again", async () => {
    seed(store, "unlocked", "7");
    store.lastReading.mockRejectedValueOnce(new Error("db down"));
    await expect(tracker.observe(obs("unlocked"), "live")).resolves.toBe("failed");
    expect(store.write).not.toHaveBeenCalled();
    await expect(tracker.observe(obs("unlocked"), "live")).resolves.toBe("unchanged");
    expect(store.lastReading).toHaveBeenCalledTimes(2);
    expect(store.write).not.toHaveBeenCalled();
  });

  it("a duplicate is a success: the id is read back by dedupeKey and the next row chains after it", async () => {
    seed(store, "locked", "7");
    const theirs = lockRowDraft({ obs: obs("unlocked"), prevId: "7", name: "x", via: "live", at: new Date(T0) });
    store.rows.push({ id: "55", draft: theirs });
    // This tracker has not seen the other bridge's row: it still believes 7/locked.
    store.lastReading.mockResolvedValueOnce({ id: "7", reading: "locked" });
    await expect(tracker.observe(obs("unlocked"), "live")).resolves.toBe("duplicate");
    expect(store.idByDedupeKey).toHaveBeenCalledWith(theirs.dedupeKey);
    await tracker.observe(obs("locked"), "live");
    expect(store.rows.at(-1)?.draft.dedupeKey).toBe(`matter_lock:${NODE}/1:after:55:locked`);
  });

  it("a row whose id cannot be read back forgets the key, so the next frame reads the history again", async () => {
    seed(store, "locked", "7");
    store.idByDedupeKey.mockResolvedValueOnce(null);
    await expect(tracker.observe(obs("unlocked"), "live")).resolves.toBe("recorded");
    await tracker.observe(obs("locked"), "live");
    expect(store.lastReading).toHaveBeenCalledTimes(2);
    expect(store.rows.at(-1)?.draft.dedupeKey).toBe(`matter_lock:${NODE}/1:after:100:locked`);
  });

  it("applies one key's readings in arrival order, without blocking other keys", async () => {
    seed(store, "locked", "7");
    const held = deferred<LockWriteOutcome>();
    const realWrite = store.write.getMockImplementation()!;
    store.write.mockImplementationOnce(async (d) => {
      await held.promise;
      return realWrite(d);
    });

    const first = tracker.observe(obs("unlocked"), "live");
    const second = tracker.observe(obs("locked"), "live");
    const other = tracker.observe(obs("locked", "99", 1), "live");
    await other;
    await flush();
    // The other key finished; this key's second reading is still queued behind the first write.
    expect(store.write).toHaveBeenCalledTimes(2);
    expect(store.write.mock.calls.map(([d]) => d.dedupeKey)).toEqual([
      `matter_lock:${NODE}/1:after:7:unlocked`,
      "matter_lock:99/1:after:none:locked",
    ]);

    held.resolve("recorded");
    await expect(first).resolves.toBe("recorded");
    await expect(second).resolves.toBe("recorded");
    expect(store.rows.filter((r) => r.draft.sourceRef === REF).map((r) => r.draft.labels[0])).toEqual([
      "locked",
      "unlocked",
      "locked",
    ]);
  });

  it("two trackers (two bridges) on one store collapse to ONE row", async () => {
    seed(store, "locked", "7");
    const other = createLockTracker({ store, now: c.now, logger: quietLogger() });
    const outcomes = await Promise.all([tracker.observe(obs("unlocked"), "live"), other.observe(obs("unlocked"), "live")]);
    expect(outcomes.sort()).toEqual(["duplicate", "recorded"]);
    expect(store.rows.filter((r) => r.draft.labels[0] === "unlocked")).toHaveLength(1);
  });

  it("never rejects, even when the name lookup throws", async () => {
    const t = createLockTracker({
      store,
      now: c.now,
      logger: quietLogger(),
      nameOf: () => {
        throw new Error("boom");
      },
    });
    await expect(t.observe(obs("locked"), "live")).resolves.toBe("failed");
    expect(store.rows).toHaveLength(0);
  });

  it("tracks write health: a failure, then a recovery", async () => {
    seed(store, "locked", "7");
    store.write.mockResolvedValueOnce("failed");
    await tracker.observe(obs("unlocked"), "live");
    expect(tracker.writeHealth().lastWriteError?.at).toEqual(new Date(T0));
    expect(tracker.writeHealth().lastRecordedAt).toBeNull();
    expect(tracker.writeHealth().unsaved).toBe(1);
    c.advance(1000);
    await tracker.observe(obs("unlocked"), "live");
    expect(tracker.writeHealth().lastRecordedAt).toEqual(new Date(T0 + 1000));
    expect(tracker.writeHealth().lastLiveFrameAt).toEqual(new Date(T0 + 1000));
    expect(tracker.writeHealth().unsaved).toBe(0);
  });

  it("unsaved counts keys, not failures: two failures on one lock are one pending change", async () => {
    seed(store, "locked", "7");
    store.write.mockResolvedValueOnce("failed").mockResolvedValueOnce("failed");
    await tracker.observe(obs("unlocked"), "live");
    await tracker.observe(obs("unlocked"), "live");
    expect(tracker.writeHealth().unsaved).toBe(1);
    await tracker.observe(obs("locked", "99", 1), "live"); // another lock saves: this one is still pending
    expect(tracker.writeHealth().unsaved).toBe(1);
  });
});

// ── the subscriber ───────────────────────────────────────────────────────

describe("lockFrameSubscriber — can never throw into the bridge", () => {
  it("hands a lock frame to the tracker as live; ignores everything else", () => {
    const observe = vi.fn(async () => "recorded" as const);
    const sub = lockFrameSubscriber({ observe }, vi.fn());
    sub(frame(2));
    sub(frame(1, { path: { endpointId: 1, clusterId: 6, attributeId: 0 } }));
    sub("garbage");
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith({ nodeId: NODE, endpointId: 1, ref: REF, reading: "unlocked" }, "live");
  });

  it("a tracker that throws synchronously does not escape — through a real EventEmitter", () => {
    const warn = vi.fn();
    const sub = lockFrameSubscriber(
      {
        observe: () => {
          throw new Error("sync boom");
        },
      },
      warn,
    );
    const emitter = new EventEmitter();
    emitter.on("state_changed", sub);
    const after = vi.fn();
    emitter.on("state_changed", after);
    expect(() => emitter.emit("state_changed", frame(1))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1); // the other consumers still hear it
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: "sync boom" }));
  });

  it("a tracker that rejects is warned about, not left unhandled", async () => {
    const warn = vi.fn();
    const sub = lockFrameSubscriber({ observe: () => Promise.reject(new Error("async boom")) }, warn);
    expect(() => sub(frame(1))).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: "async boom" }));
  });

  it("a frame whose getter throws, with a logger that throws too, still does not escape", async () => {
    const hostile = {
      nodeId: NODE,
      get path(): unknown {
        throw new Error("getter");
      },
    };
    const sub = lockFrameSubscriber(
      { observe: () => Promise.reject(new Error("x")) },
      () => {
        throw new Error("logger down");
      },
    );
    expect(() => sub(hostile)).not.toThrow();
    expect(() => sub(frame(1))).not.toThrow();
    await flush();
  });
});

// ── the sweep ────────────────────────────────────────────────────────────

describe("sweep — finds what the live stream missed", () => {
  it("writes a polled row for a changed lock, named from the list", async () => {
    const { adapter, store, c, logger } = adapterWith({});
    seed(store, "locked", "7");
    c.advance(5000);
    const r = await adapter.sweep();
    expect(r).toMatchObject({ status: "ok", locks: 1, observed: 1, recorded: 1 });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ recorded: 1 }), "security lock sweep");
    expect(store.rows.at(-1)?.draft).toMatchObject({
      observed: "polled",
      dedupeKey: `matter_lock:${NODE}/1:after:7:unlocked`,
      summary: "Back door lock: unlocked (found when Droplet checked)",
      startedAt: new Date(T0 + 5000),
    });
    expect(adapter.knownLocks()).toEqual([
      {
        ref: REF,
        nodeId: NODE,
        endpointId: 1,
        name: "Back door lock",
        room: "Hall",
        connected: true,
        reading: "unlocked",
        polled: true,
      },
    ]);
  });

  it("an unchanged lock writes nothing", async () => {
    const { adapter, store } = adapterWith({});
    seed(store, "unlocked", "7");
    await expect(adapter.sweep()).resolves.toMatchObject({ status: "ok", recorded: 0 });
    expect(store.write).not.toHaveBeenCalled();
  });

  it("t0 guard: a live frame heard while the list was in flight wins over the (older) list", async () => {
    const listed = deferred<readonly LockSourceDevice[]>();
    const source = staticSource(() => listed.promise);
    const { adapter, store, c, emitter } = adapterWith({ source });
    seed(store, "unlocked", "7");
    adapter.start();

    const sweeping = adapter.sweep();
    c.advance(200);
    emitter.emit("state_changed", frame(1)); // locked, heard after t0
    await flush();
    listed.resolve([lockDevice({ attributes: { lockState: 2 } })]); // the list still says unlocked
    await expect(sweeping).resolves.toMatchObject({ status: "ok", superseded: 1, recorded: 0 });
    expect(store.rows.map((r) => r.draft.labels[0])).toEqual(["unlocked", "locked"]);
    expect(store.rows.at(-1)?.draft.observed).toBe("live");
    expect(adapter.knownLocks()[0].reading).toBe("locked");
  });

  it("t0 guard is 'at or after': a live frame in the very millisecond the sweep started still wins", async () => {
    const listed = deferred<readonly LockSourceDevice[]>();
    const { adapter, store, emitter } = adapterWith({ source: staticSource(() => listed.promise) });
    seed(store, "unlocked", "7");
    adapter.start();
    const sweeping = adapter.sweep();
    emitter.emit("state_changed", frame(1)); // same instant as t0 (the clock has not moved)
    await flush();
    listed.resolve([lockDevice({ attributes: { lockState: 2 } })]);
    await expect(sweeping).resolves.toMatchObject({ superseded: 1, recorded: 0 });
    expect(store.rows.map((r) => r.draft.labels[0])).toEqual(["unlocked", "locked"]);
  });

  it("a live frame from BEFORE the sweep does not block it", async () => {
    const { adapter, store, c, emitter } = adapterWith({});
    adapter.start();
    emitter.emit("state_changed", frame(1));
    await flush();
    c.advance(1);
    // The device moved and the stream missed it; the sweep finds unlocked.
    await expect(adapter.sweep()).resolves.toMatchObject({ recorded: 1, superseded: 0 });
    expect(store.rows.map((r) => [r.draft.labels[0], r.draft.observed])).toEqual([
      ["locked", "live"],
      ["unlocked", "polled"],
    ]);
  });

  it("skips a node with several DoorLock endpoints, and logs it once", async () => {
    const multi = lockDevice({
      endpoints: [
        { endpointId: 1, deviceTypes: [], clusters: [257] },
        { endpointId: 2, deviceTypes: [], clusters: [257] },
      ],
    });
    const { adapter, store, logger } = adapterWith({ source: staticSource([multi]) });
    await expect(adapter.sweep()).resolves.toMatchObject({ status: "ok", locks: 2, observed: 0 });
    await adapter.sweep();
    expect(store.write).not.toHaveBeenCalled();
    expect(store.lastReading).not.toHaveBeenCalled();
    const multiWarns = logger.warn.mock.calls.filter(([, msg]) => String(msg).includes("several door-lock endpoints"));
    expect(multiWarns).toHaveLength(1);
    expect(adapter.knownLocks().map((l) => [l.ref, l.polled])).toEqual([
      [`matter:${NODE}/1`, false],
      [`matter:${NODE}/2`, false],
    ]);
  });

  it("never identifies a lock by device type or a stray attribute: no DoorLock cluster, no lock", async () => {
    const light = lockDevice({
      nodeId: "77",
      friendlyName: "Desk lamp",
      endpoints: [{ endpointId: 1, deviceTypes: [{ deviceType: 0x0101, revision: 1 }], clusters: [6, 8] }],
      attributes: { lockState: 1 },
    });
    const { adapter, store } = adapterWith({ source: staticSource([light]) });
    await expect(adapter.sweep()).resolves.toMatchObject({ status: "ok", locks: 0 });
    expect(store.write).not.toHaveBeenCalled();
  });

  it.each([
    ["disconnected", { connectionState: "disconnected" as const }],
    ["lockState absent", { attributes: {} }],
    ["lockState a string", { attributes: { lockState: "locked" } }],
    ["lockState out of range", { attributes: { lockState: 7 } }],
  ])("does not observe a lock whose list entry is %s", async (_label, over) => {
    const { adapter, store } = adapterWith({ source: staticSource([lockDevice(over)]) });
    await expect(adapter.sweep()).resolves.toMatchObject({ status: "ok", locks: 1, observed: 0 });
    expect(store.write).not.toHaveBeenCalled();
  });

  it("a node gone from a SUCCESSFUL list is forgotten with no row; if it returns, its history is read again", async () => {
    const devices = [lockDevice()];
    const { adapter, store } = adapterWith({ source: staticSource(() => Promise.resolve(devices)) });
    await adapter.sweep();
    expect(store.rows).toHaveLength(1);
    expect(store.lastReading).toHaveBeenCalledTimes(1);

    devices.length = 0;
    await expect(adapter.sweep()).resolves.toMatchObject({ status: "ok", locks: 0, dropped: 1 });
    expect(store.rows).toHaveLength(1);
    expect(adapter.knownLocks()).toEqual([]);

    devices.push(lockDevice());
    await adapter.sweep();
    expect(store.lastReading).toHaveBeenCalledTimes(2);
    expect(store.rows).toHaveLength(1);
  });

  it("a failed list writes nothing, forgets nothing and records the error", async () => {
    let fail = false;
    const source = staticSource(async () => {
      if (fail) throw new Error("matter-controller 401");
      return [lockDevice()];
    });
    const { adapter, store, c } = adapterWith({ source });
    await adapter.sweep();
    expect(store.rows).toHaveLength(1);

    fail = true;
    c.advance(60_000);
    await expect(adapter.sweep()).resolves.toEqual({ status: "failed", message: "matter-controller 401" });
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(adapter.sweepState()).toMatchObject({
      consecutiveSweepFailures: 1,
      lastSweepError: { at: new Date(T0 + 60_000), message: "matter-controller 401" },
      lastSweepOkAt: new Date(T0),
      lastSweepLockCount: 1,
    });
    expect(adapter.knownLocks()).toHaveLength(1);
  });

  it("a list that is not an array is a failure, not zero locks", async () => {
    const { adapter } = adapterWith({ source: staticSource(async () => ({}) as unknown as LockSourceDevice[]) });
    await expect(adapter.sweep()).resolves.toMatchObject({ status: "failed" });
    expect(adapter.sweepState().lastSweepLockCount).toBeNull();
  });

  it("a sweep already running is not doubled", async () => {
    const listed = deferred<readonly LockSourceDevice[]>();
    const { adapter } = adapterWith({ source: staticSource(() => listed.promise) });
    const first = adapter.sweep();
    await expect(adapter.sweep()).resolves.toEqual({ status: "busy" });
    listed.resolve([]);
    await expect(first).resolves.toMatchObject({ status: "ok" });
  });

  it("a live frame before any sweep is named by the fallback; after a sweep, by the list", async () => {
    const { adapter, store, c, emitter } = adapterWith({});
    adapter.start();
    emitter.emit("state_changed", frame(1));
    await flush();
    expect(store.rows[0].draft.summary).toBe("Lock …4660: locked");
    c.advance(1000);
    await adapter.sweep(); // unlocked, polled
    c.advance(1000);
    emitter.emit("state_changed", frame(1));
    await flush();
    expect(store.rows.at(-1)?.draft.summary).toBe("Back door lock: locked");
  });
});

// ── health ───────────────────────────────────────────────────────────────

function healthInput(over: Partial<LockHealthInput> = {}): LockHealthInput {
  return {
    started: true,
    sweepScheduled: true,
    bridgeUp: true,
    lastSweepOkAt: new Date(T0),
    lastSweepError: null,
    consecutiveSweepFailures: 0,
    lastSweepLockCount: 1,
    knownLocks: [{ nodeId: NODE, name: "Back door lock", connected: true }],
    write: { lastRecordedAt: null, lastWriteError: null, lastLiveFrameAt: null, unsaved: 0 },
    ...over,
  };
}

describe("lockHealthRow", () => {
  it("not started, or the sweep not scheduled → down 'Not running'", () => {
    expect(lockHealthRow(healthInput({ started: false }))).toMatchObject({ state: "down", detail: "Not running" });
    expect(lockHealthRow(healthInput({ sweepScheduled: false }))).toMatchObject({ state: "down", detail: "Not running" });
  });

  it("a smart-home service that has NEVER answered is down — never 'No door locks paired'", () => {
    const neverAnswered = healthInput({
      bridgeUp: false,
      lastSweepOkAt: null,
      lastSweepLockCount: null,
      knownLocks: [],
      lastSweepError: { at: new Date(T0), message: "ECONNREFUSED" },
      consecutiveSweepFailures: 12,
    });
    expect(lockHealthRow(neverAnswered)).toMatchObject({ state: "down", detail: "Can't reach the smart-home service" });
    // The empty-token 401 loop: the bridge reports up, every list fails.
    expect(lockHealthRow({ ...neverAnswered, bridgeUp: true })).toMatchObject({
      state: "down",
      detail: "Can't reach the smart-home service",
    });
    // Bridge up and only ONE failure so far — still no success ever → down, not "Listening to 0 locks".
    expect(lockHealthRow({ ...neverAnswered, bridgeUp: true, consecutiveSweepFailures: 1 })).toMatchObject({
      state: "down",
      detail: "Can't reach the smart-home service",
    });
  });

  it("registered, service up, first sweep not run yet → down 'Hasn't checked the locks yet'", () => {
    expect(
      lockHealthRow(healthInput({ lastSweepOkAt: null, lastSweepLockCount: null, knownLocks: [] })),
    ).toMatchObject({ state: "down", detail: "Hasn't checked the locks yet" });
  });

  it("the live bridge down → down, even with a good last list", () => {
    expect(lockHealthRow(healthInput({ bridgeUp: false }))).toMatchObject({
      state: "down",
      detail: "Can't reach the smart-home service",
    });
    expect(lockHealthRow(healthInput({ bridgeUp: false, lastSweepLockCount: 0, knownLocks: [] })).state).toBe("down");
  });

  it("two failed sweeps after a good one keep the good one; the third → down", () => {
    const err = { at: new Date(T0 + 120_000), message: "timeout" };
    expect(lockHealthRow(healthInput({ consecutiveSweepFailures: 2, lastSweepError: err })).state).toBe("ok");
    expect(lockHealthRow(healthInput({ consecutiveSweepFailures: 3, lastSweepError: err }))).toMatchObject({
      state: "down",
      detail: "Can't reach the smart-home service",
    });
  });

  it("'No door locks paired' ONLY when the last successful list had none", () => {
    expect(lockHealthRow(healthInput({ lastSweepLockCount: 0, knownLocks: [] }))).toMatchObject({
      state: "not_configured",
      detail: "No door locks paired",
    });
  });

  it("ok 'Listening to N locks'", () => {
    expect(lockHealthRow(healthInput())).toMatchObject({ state: "ok", detail: "Listening to 1 lock" });
    expect(
      lockHealthRow(
        healthInput({
          lastSweepLockCount: 2,
          knownLocks: [
            { nodeId: "1", name: "A", connected: true },
            { nodeId: "2", name: "B", connected: true },
          ],
        }),
      ),
    ).toMatchObject({ state: "ok", detail: "Listening to 2 locks" });
  });

  it("a known lock that is disconnected → down '<name> isn't reporting'", () => {
    expect(lockHealthRow(healthInput({ knownLocks: [{ nodeId: NODE, name: "Back door lock", connected: false }] }))).toMatchObject({
      state: "down",
      detail: "Back door lock isn't reporting",
    });
    expect(
      lockHealthRow(
        healthInput({
          lastSweepLockCount: 3,
          knownLocks: [
            { nodeId: "1", name: "Back door lock", connected: false },
            { nodeId: "2", name: "Front door lock", connected: false },
            { nodeId: "3", name: "Gate", connected: true },
          ],
        }),
      ).detail,
    ).toBe("Back door lock and 1 other lock aren't reporting");
  });

  it("a disconnected device with two DoorLock endpoints is ONE device not reporting", () => {
    expect(
      lockHealthRow(
        healthInput({
          lastSweepLockCount: 2,
          knownLocks: [
            { nodeId: NODE, name: "Double door", connected: false },
            { nodeId: NODE, name: "Double door", connected: false },
          ],
        }),
      ).detail,
    ).toBe("Double door isn't reporting");
  });

  it("a lock change not saved yet → down; settled → ok, whatever the timestamps say", () => {
    const failing = {
      lastRecordedAt: new Date(T0 + 5),
      lastWriteError: { at: new Date(T0 + 1), message: "x" },
      lastLiveFrameAt: null,
      unsaved: 1,
    };
    expect(lockHealthRow(healthInput({ write: failing }))).toMatchObject({
      state: "down",
      detail: "Lock changes are arriving but could not be saved",
    });
    // An old error with nothing pending is history, not a fault.
    expect(lockHealthRow(healthInput({ write: { ...failing, lastRecordedAt: null, unsaved: 0 } })).state).toBe("ok");
  });

  it("lastSeenAt is the later of the last good list and the last live frame", () => {
    expect(lockHealthRow(healthInput()).lastSeenAt).toBe(new Date(T0).toISOString());
    expect(
      lockHealthRow(
        healthInput({ write: { lastRecordedAt: null, lastWriteError: null, lastLiveFrameAt: new Date(T0 + 9000), unsaved: 0 } }),
      ).lastSeenAt,
    ).toBe(new Date(T0 + 9000).toISOString());
    expect(lockHealthRow(healthInput({ lastSweepOkAt: null, bridgeUp: false })).lastSeenAt).toBeNull();
  });

  it("the copy never says monitored, armed, alarm, secure, protected, guard or space", () => {
    const details = [
      lockHealthRow(healthInput({ started: false })),
      lockHealthRow(healthInput({ lastSweepOkAt: null })),
      lockHealthRow(healthInput({ bridgeUp: false })),
      lockHealthRow(healthInput({ knownLocks: [{ nodeId: "1", name: "L", connected: false }] })),
      lockHealthRow(
        healthInput({
          knownLocks: [
            { nodeId: "1", name: "L", connected: false },
            { nodeId: "2", name: "M", connected: false },
            { nodeId: "3", name: "N", connected: false },
          ],
        }),
      ),
      lockHealthRow(healthInput({ write: { lastRecordedAt: null, lastWriteError: null, lastLiveFrameAt: null, unsaved: 1 } })),
      lockHealthRow(healthInput({ lastSweepLockCount: 0, knownLocks: [] })),
      lockHealthRow(healthInput({ lastSweepLockCount: 2 })),
      lockHealthRow(healthInput()),
    ].map((r) => r.detail);
    // Every state's copy is in the list above, once.
    expect(new Set(details).size).toBe(details.length);
    const summaries = LOCK_READINGS.flatMap((reading) =>
      (["live", "polled"] as const).map(
        (via) => lockRowDraft({ obs: obs(reading), prevId: null, name: "L", via, at: new Date(T0) }).summary,
      ),
    );
    for (const text of [...details, ...summaries]) {
      expect(text).not.toMatch(/monitor|armed|\barm\b|alarm|\bsecure|protected|guard|space|\bzones?\b/i);
    }
  });
});

describe("the adapter's health, end to end", () => {
  it.each([
    ["the bridge down too", false],
    ["the bridge up (the empty-token 401 loop)", true],
  ])("a never-answering service, %s: down after every failed sweep, never not_configured", async (_l, up) => {
    const source = staticSource(async () => {
      throw new Error("ECONNREFUSED");
    }, up);
    const { adapter } = adapterWith({ source });
    adapter.start();
    adapter.noteSweepScheduled();
    for (let i = 0; i < 4; i++) {
      await adapter.sweep();
      expect(adapter.health()).toMatchObject({ state: "down", detail: "Can't reach the smart-home service" });
    }
  });

  it("a successful empty list → not_configured; a paired lock → ok", async () => {
    const devices: LockSourceDevice[] = [];
    const { adapter } = adapterWith({ source: staticSource(() => Promise.resolve(devices)) });
    adapter.start();
    adapter.noteSweepScheduled();
    expect(adapter.health()).toMatchObject({ state: "down", detail: "Hasn't checked the locks yet" });
    await adapter.sweep();
    expect(adapter.health()).toMatchObject({ state: "not_configured", detail: "No door locks paired" });
    devices.push(lockDevice());
    await adapter.sweep();
    expect(adapter.health()).toMatchObject({ state: "ok", detail: "Listening to 1 lock" });
  });

  it("a store blip that recovers WITHOUT a write clears the save failure — a still lock must not read down for days", async () => {
    const { adapter, store, c } = adapterWith({});
    seed(store, "unlocked", "7"); // the list says unlocked too: nothing will ever need writing
    adapter.start();
    adapter.noteSweepScheduled();
    store.lastReading.mockRejectedValueOnce(new Error("db restarting"));
    await expect(adapter.sweep()).resolves.toMatchObject({ status: "ok", failed: 1 });
    expect(adapter.health()).toMatchObject({ state: "down", detail: "Lock changes are arriving but could not be saved" });

    c.advance(60_000);
    await expect(adapter.sweep()).resolves.toMatchObject({ status: "ok", failed: 0, recorded: 0 });
    expect(store.write).not.toHaveBeenCalled();
    expect(adapter.health()).toMatchObject({ state: "ok", detail: "Listening to 1 lock" });
  });

  it("a failed write is cleared when the lock goes back to what the store already says", async () => {
    const { adapter, store, c, emitter } = adapterWith({});
    seed(store, "locked", "7");
    adapter.start();
    adapter.noteSweepScheduled();
    await adapter.sweep(); // unlocked → recorded after 7
    c.advance(1000);
    store.write.mockResolvedValueOnce("failed");
    emitter.emit("state_changed", frame(1)); // locked: the write fails
    await flush();
    expect(adapter.health().state).toBe("down");
    c.advance(1000);
    emitter.emit("state_changed", frame(2)); // back to unlocked, which the store holds: nothing unsaved
    await flush();
    expect(adapter.health()).toMatchObject({ state: "ok" });
  });

  it("one lock's recovery does not hide another lock's unsaved change", async () => {
    const { adapter, store, c, emitter } = adapterWith({
      source: staticSource([
        lockDevice(),
        lockDevice({ nodeId: "99", friendlyName: "Gate", attributes: { lockState: 1 } }),
      ]),
    });
    adapter.start();
    adapter.noteSweepScheduled();
    await adapter.sweep(); // two baselines
    c.advance(1000);
    store.write.mockResolvedValueOnce("failed");
    emitter.emit("state_changed", frame(1)); // 4660 locked: fails
    await flush();
    c.advance(1000);
    emitter.emit("state_changed", frame(2, { nodeId: "99" })); // Gate unlocked: saved, later
    await flush();
    expect(store.rows.at(-1)?.draft.sourceRef).toBe("matter:99/1");
    expect(adapter.health()).toMatchObject({ state: "down", detail: "Lock changes are arriving but could not be saved" });
  });

  it("a decommissioned lock's unsaved change stops counting once a successful list drops it", async () => {
    const devices = [lockDevice()];
    const { adapter, store, c, emitter } = adapterWith({ source: staticSource(() => Promise.resolve(devices)) });
    adapter.start();
    adapter.noteSweepScheduled();
    await adapter.sweep();
    c.advance(1000);
    store.write.mockResolvedValueOnce("failed");
    emitter.emit("state_changed", frame(1));
    await flush();
    expect(adapter.health().state).toBe("down");
    devices.length = 0;
    await adapter.sweep();
    expect(adapter.health()).toMatchObject({ state: "not_configured", detail: "No door locks paired" });
  });

  it("a source whose bridgeUp throws reads as unreachable", async () => {
    const source: LockDeviceSource = {
      list: async () => [lockDevice()],
      bridgeUp: () => {
        throw new Error("x");
      },
    };
    const { adapter } = adapterWith({ source });
    adapter.start();
    adapter.noteSweepScheduled();
    await adapter.sweep();
    expect(adapter.health()).toMatchObject({ state: "down", detail: "Can't reach the smart-home service" });
  });
});

// ── wiring shapes ────────────────────────────────────────────────────────

describe("startSecurityLockAdapter / registerSecurityLockJobs", () => {
  function deps(subscribe?: (cb: (e: unknown) => void) => () => void) {
    const unsubscribe = vi.fn();
    return {
      unsubscribe,
      d: {
        store: fakeStore(),
        source: staticSource([lockDevice()]),
        subscribeStateChanges: vi.fn(subscribe ?? (() => unsubscribe)),
        logger: quietLogger(),
      },
    };
  }

  it("with no adapter started, the header row is 'Not running'", () => {
    expect(securityLockAdapter()).toBeNull();
    expect(securityLockHealthRow()).toEqual({ id: "locks", state: "down", detail: "Not running", lastSeenAt: null });
  });

  it("subscribes a safe callback; a second start replaces (and unsubscribes) the first", () => {
    const one = deps();
    const a = startSecurityLockAdapter(one.d);
    expect(one.d.subscribeStateChanges).toHaveBeenCalledTimes(1);
    const cb = one.d.subscribeStateChanges.mock.calls[0][0] as (e: unknown) => void;
    expect(() => cb({ nodeId: NODE, get path(): unknown { throw new Error("x"); } })).not.toThrow();
    expect(securityLockAdapter()).toBe(a);

    const two = deps();
    const b = startSecurityLockAdapter(two.d);
    expect(one.unsubscribe).toHaveBeenCalledTimes(1);
    expect(securityLockAdapter()).toBe(b);
  });

  it("a subscribe that throws does not throw out of startup; health says 'Not running'", () => {
    const { d } = deps(() => {
      throw new Error("emitter gone");
    });
    let adapter!: ReturnType<typeof startSecurityLockAdapter>;
    expect(() => {
      adapter = startSecurityLockAdapter(d);
    }).not.toThrow();
    registerSecurityLockJobs({ scheduleInterval: vi.fn() }, adapter);
    expect(securityLockHealthRow()).toMatchObject({ state: "down", detail: "Not running" });
    expect(d.logger.error).toHaveBeenCalled();
  });

  it("schedules the sweep every 60 s on its own advisory lock, then health follows the sweep", async () => {
    const { d } = deps();
    const adapter = startSecurityLockAdapter(d);
    expect(securityLockHealthRow()).toMatchObject({ detail: "Not running" }); // sweep not scheduled yet
    const scheduleInterval = vi.fn();
    registerSecurityLockJobs({ scheduleInterval }, adapter);
    expect(scheduleInterval).toHaveBeenCalledWith(SECURITY_LOCK_SWEEP_INTERVAL_MS, expect.any(Function), {
      lockKey: SECURITY_LOCK_SWEEP_LOCK_KEY,
    });
    expect(SECURITY_LOCK_SWEEP_INTERVAL_MS).toBe(60_000);
    expect(SECURITY_LOCK_SWEEP_LOCK_KEY).toBe("droplet:security-lock-sweep");

    const tick = scheduleInterval.mock.calls[0][1] as () => Promise<void>;
    await tick();
    expect(d.store.rows).toHaveLength(1);
    expect(d.store.rows[0].draft.observed).toBe("polled");
    expect(securityLockHealthRow()).toMatchObject({ state: "ok", detail: "Listening to 1 lock" });
  });

  it("stop() unsubscribes and reads as not running", () => {
    const { d, unsubscribe } = deps();
    const adapter = startSecurityLockAdapter(d);
    adapter.noteSweepScheduled();
    adapter.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(adapter.health()).toMatchObject({ detail: "Not running" });
  });
});

describe("matterLockDeviceSource — over the matter.service exports", () => {
  const grouped = (over: Partial<MatterGrouped> = {}): MatterGrouped => ({
    lights: [],
    switches: [],
    sensors: [],
    climate: [],
    media: [],
    covers: [],
    locks: [],
    other: [],
    ...over,
  });
  const full = (d: LockSourceDevice) => ({ ...d, category: "switch" as const, state: "on" });

  it("flattens EVERY group: the sidecar's category is not how a lock is found", async () => {
    const inOther = full(lockDevice({ nodeId: "5" }));
    const inLocks = full(lockDevice({ nodeId: "6" }));
    const src = matterLockDeviceSource({
      getCommissionedDevices: async () => grouped({ other: [inOther], locks: [inLocks, inLocks] }),
      isMatterInitialized: () => true,
    });
    expect((await src.list()).map((d) => d.nodeId).sort()).toEqual(["5", "6"]);
  });

  it("throws on a malformed list, so it can never read as 'no locks'", async () => {
    for (const bad of [null, "x", {}, { locks: "nope" }]) {
      const src = matterLockDeviceSource({
        getCommissionedDevices: async () => bad as unknown as MatterGrouped,
        isMatterInitialized: () => true,
      });
      await expect(src.list()).rejects.toThrow();
    }
  });

  it("passes a sidecar failure through as a throw", async () => {
    const src = matterLockDeviceSource({
      getCommissionedDevices: async () => {
        throw new Error("503");
      },
      isMatterInitialized: () => false,
    });
    await expect(src.list()).rejects.toThrow("503");
  });

  it("bridgeUp is isMatterInitialized; a throw reads as down", () => {
    expect(matterLockDeviceSource({ getCommissionedDevices: async () => grouped(), isMatterInitialized: () => true }).bridgeUp()).toBe(true);
    expect(
      matterLockDeviceSource({
        getCommissionedDevices: async () => grouped(),
        isMatterInitialized: () => {
          throw new Error("x");
        },
      }).bridgeUp(),
    ).toBe(false);
  });
});

// ── L0 (WARP-2977 P2b-2): what the routes and the store read ─────────────

describe("parseLockRef — a lock link's ref is exactly a lock row's sourceRef", () => {
  it("reads a canonical matter:<node>/<endpoint>, the largest uint64 node and endpoint 65534 included", () => {
    expect(parseLockRef("matter:4660/1")).toEqual({ nodeId: "4660", endpointId: 1 });
    expect(parseLockRef("matter:18446744073709551615/65534")).toEqual({ nodeId: "18446744073709551615", endpointId: 65534 });
  });

  it.each([
    ["matter:04660/1", "a leading zero — the rows are keyed on the canonical id, so it could never match one"],
    ["matter:4660/01", "a leading zero on the endpoint"],
    ["matter:4660/0", "the root endpoint"],
    ["matter:4660/65535", "the wildcard endpoint"],
    ["matter:18446744073709551616/1", "a node past uint64"],
    ["matter:4660", "no endpoint"],
    ["matter:4660/1/2", "an extra segment"],
    ["matter:x/1", "a non-numeric node"],
    ["lock:4660/1", "another scheme"],
    ["front_door", "a camera"],
    ["", "nothing"],
  ])("refuses %j (%s)", (ref) => {
    expect(parseLockRef(ref)).toBeNull();
  });

  it("round-trips with lockRef", () => {
    const p = parseLockRef(REF)!;
    expect(`matter:${p.nodeId}/${p.endpointId}`).toBe(REF);
  });
});

describe("adapter.listLocks — a FRESH list of the paired door-lock endpoints, for the Areas page and link checks", () => {
  it("names each DoorLock endpoint (alias, room, connection) with the reading last heard; writes nothing", async () => {
    const { adapter, store, emitter } = adapterWith({
      source: staticSource([
        lockDevice(),
        lockDevice({
          nodeId: "99",
          friendlyName: null,
          name: "Double door",
          roomName: null,
          connectionState: "disconnected",
          endpoints: [
            { endpointId: 1, deviceTypes: [], clusters: [257] },
            { endpointId: 2, deviceTypes: [], clusters: [257] },
          ],
        }),
        lockDevice({ nodeId: "5", endpoints: [{ endpointId: 1, deviceTypes: [{ deviceType: 0x0101, revision: 1 }], clusters: [6, 8] }] }),
      ]),
    });
    adapter.start();
    emitter.emit("state_changed", frame(1));
    await flush();
    const writesBefore = store.write.mock.calls.length;
    const locks = await adapter.listLocks();
    expect(locks).toEqual([
      { ref: REF, nodeId: NODE, endpointId: 1, name: "Back door lock", room: "Hall", connected: true, reading: "locked", polled: true },
      { ref: "matter:99/1", nodeId: "99", endpointId: 1, name: "Double door", room: null, connected: false, reading: null, polled: false },
      { ref: "matter:99/2", nodeId: "99", endpointId: 2, name: "Double door", room: null, connected: false, reading: null, polled: false },
    ]);
    expect(store.write.mock.calls.length).toBe(writesBefore);
    // The sweep's own state is untouched: listing is not a sweep.
    expect(adapter.sweepState().lastSweepOkAt).toBeNull();
  });

  // Review F3: the sidecar's own timeout is 30 s — a page load and a link save must not hang that long.
  describe(`a smart-home service that hangs: the fresh list gives up after ${SECURITY_LOCK_LIST_TIMEOUT_MS / 1000} s`, () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects at the cap (so /sources reads the locks as unavailable and a new lock link is a 503), not before", async () => {
      expect(SECURITY_LOCK_LIST_TIMEOUT_MS).toBe(5_000);
      const { adapter } = adapterWith({ source: staticSource(() => new Promise(() => undefined)) });
      let settled: unknown = "pending";
      const p = adapter.listLocks().then(
        () => (settled = "resolved"),
        (err: Error) => (settled = err),
      );
      await vi.advanceTimersByTimeAsync(SECURITY_LOCK_LIST_TIMEOUT_MS - 1);
      expect(settled).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled).toBeInstanceOf(Error);
      expect((settled as Error).message).toMatch(/did not answer within 5 s/);
    });

    it("an answer inside the cap is used, and leaves no timer behind", async () => {
      const { adapter } = adapterWith({
        source: staticSource(() => new Promise((r) => setTimeout(() => r([lockDevice()]), 4_000))),
      });
      const p = adapter.listLocks();
      await vi.advanceTimersByTimeAsync(4_000);
      expect((await p).map((l) => l.ref)).toEqual([REF]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("the sweep is not capped by it (it keeps the service's own timeout)", async () => {
      const { adapter } = adapterWith({
        source: staticSource(() => new Promise((r) => setTimeout(() => r([lockDevice()]), 8_000))),
      });
      const p = adapter.sweep();
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(p).resolves.toMatchObject({ status: "ok", locks: 1 });
    });
  });

  it("throws when the smart-home service cannot answer — never an empty list", async () => {
    const { adapter } = adapterWith({
      source: staticSource(async () => {
        throw new Error("sidecar 503");
      }),
    });
    await expect(adapter.listLocks()).rejects.toThrow("sidecar 503");
    await expect(
      adapterWith({ source: staticSource(async () => "nope" as never) }).adapter.listLocks(),
    ).rejects.toThrow();
  });
});

describe("stillUnlockedLocks — the names a Close up / Away answer lists (never 'all locked')", () => {
  const known = (over: Partial<KnownLock>): KnownLock => ({
    ref: REF,
    nodeId: NODE,
    endpointId: 1,
    name: "Back door lock",
    room: null,
    connected: true,
    reading: "unlocked" as LockReading | null,
    polled: true,
    ...over,
  });

  it("connected locks last heard unlocked, not fully locked or unlatched — one name per device, sorted", () => {
    expect(
      stillUnlockedLocks([
        known({ name: "Side gate", nodeId: "2", ref: "matter:2/1", reading: "unlatched" }),
        known({}),
        known({ name: "Cellar", nodeId: "3", ref: "matter:3/1", reading: "not_fully_locked" }),
        // A second endpoint of the same device: one name.
        known({ endpointId: 2, ref: `matter:${NODE}/2` }),
      ]),
    ).toEqual(["Back door lock", "Cellar", "Side gate"]);
  });

  it("never a lock that is locked, unknown, never heard, or not reporting — a stale reading is not 'still unlocked'", () => {
    expect(
      stillUnlockedLocks([
        known({ reading: "locked" }),
        known({ reading: "unknown", nodeId: "2" }),
        known({ reading: null, nodeId: "3" }),
        known({ connected: false, nodeId: "4" }),
      ]),
    ).toEqual([]);
  });
});

describe("createPrismaLockStore — the LockStore over the one writer", () => {
  function prismaFake() {
    return {
      securityEvent: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        createMany: vi.fn(),
      },
    };
  }

  it("lastReading reads the latest matter_lock row of that ref, newest first with the id as tiebreak", async () => {
    const p = prismaFake();
    p.securityEvent.findFirst.mockResolvedValue({ id: 41n, labels: ["unlatched"] });
    const store = createPrismaLockStore(p as never);
    expect(await store.lastReading(REF)).toEqual({ id: "41", reading: "unlatched" });
    expect(p.securityEvent.findFirst).toHaveBeenCalledWith({
      where: { source: "matter_lock", sourceRef: REF },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: { id: true, labels: true },
    });
    p.securityEvent.findFirst.mockResolvedValue(null);
    expect(await store.lastReading(REF)).toBeNull();
  });

  it("a stored label that is not a reading is a failed read (the tracker then writes nothing and retries), never a guess", async () => {
    const p = prismaFake();
    p.securityEvent.findFirst.mockResolvedValue({ id: 41n, labels: ["Locked"] });
    await expect(createPrismaLockStore(p as never).lastReading(REF)).rejects.toThrow();
  });

  it("write goes through writeSecurityEvent and reports recorded / duplicate / failed", async () => {
    const p = prismaFake();
    p.securityEvent.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockRejectedValueOnce(new Error("pool exhausted"));
    const store = createPrismaLockStore(p as never);
    const draft = lockRowDraft({ obs: obs("unlocked"), prevId: null, name: "Back door lock", via: "polled", at: new Date(T0) });
    expect(await store.write(draft)).toBe("recorded");
    expect(await store.write(draft)).toBe("duplicate");
    expect(await store.write(draft)).toBe("failed");
    expect(p.securityEvent.createMany).toHaveBeenCalledWith({ data: [draft], skipDuplicates: true });
  });

  it("idByDedupeKey reads the row's id as a decimal string, or null", async () => {
    const p = prismaFake();
    p.securityEvent.findUnique.mockResolvedValueOnce({ id: 9_007_199_254_740_993n }).mockResolvedValueOnce(null);
    const store = createPrismaLockStore(p as never);
    expect(await store.idByDedupeKey("k")).toBe("9007199254740993");
    expect(p.securityEvent.findUnique).toHaveBeenCalledWith({ where: { dedupeKey: "k" }, select: { id: true } });
    expect(await store.idByDedupeKey("k")).toBeNull();
  });
});
