/**
 * WARP-2838 (ADR-051 §9.9) — resolving the brain switch.
 *
 * The bug this covers is not "the flag was wrong"; it is that the flag had no
 * writer. So the assertions here are about the RESOLUTION between the two
 * sources — an operator-set `BRAIN_ENABLED` and the owner's consent row — and
 * about the two ways a naive implementation lies:
 *
 *   1. accepting a write on a pinned box, leaving a consent record saying the
 *      owner switched on a brain that cannot run;
 *   2. reading an EMPTY `BRAIN_ENABLED` as a pin, which silently removes the
 *      owner's switch on any box whose compose file interpolates `${VAR:-}`.
 *
 * The consent row's actor pair is a database biconditional; the test that it is
 * cleared on the way off is here because `AutoFilingSetting` shipped the other
 * behaviour once and the off switch did not turn anything off.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { cfg } = vi.hoisted(() => ({
  cfg: { brain: { enabled: false, enabledPinnedByOperator: false } },
}));
vi.mock("../config.js", () => ({ config: cfg }));

import {
  BRAIN_SETTING_ID,
  BRAIN_SWITCH_PINNED,
  brainPassesSchedulable,
  isBrainEnabled,
  readBrainSwitch,
  setBrainEnabled,
} from "../services/brain/brain-switch.service.js";

/** The upsert argument, named so `mock.calls[0][0]` is typed rather than cast
 *  out of an empty tuple — the assertions below read the create/update blocks. */
type UpsertArg = {
  where: { id: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

function db(row: Record<string, unknown> | null = null) {
  return {
    brainSetting: {
      findUnique: vi.fn(async () => row),
      upsert: vi.fn(async (_arg: UpsertArg) => row ?? {}),
    },
  };
}

beforeEach(() => {
  cfg.brain.enabled = false;
  cfg.brain.enabledPinnedByOperator = false;
});

describe("readBrainSwitch — which source decides", () => {
  it("unset env + no row = off, and the row is NOT created by the read", async () => {
    const prisma = db(null);
    const out = await readBrainSwitch(prisma as never);
    expect(out).toEqual({
      enabled: false,
      pinnedByOperator: false,
      enabledById: null,
      enabledAt: null,
    });
    // A consent record that exists because something looked at it is not
    // consent. `upsert` here would be exactly that.
    expect(prisma.brainSetting.upsert).not.toHaveBeenCalled();
  });

  it("unset env + an enabled row = on, carrying who and when", async () => {
    const at = new Date("2026-09-08T10:00:00Z");
    const out = await readBrainSwitch(
      db({ enabled: true, enabledById: "u-owner", enabledAt: at }) as never,
    );
    expect(out.enabled).toBe(true);
    expect(out.pinnedByOperator).toBe(false);
    expect(out.enabledById).toBe("u-owner");
    expect(out.enabledAt).toEqual(at);
  });

  it("a pinned box does not consult the row at all — in EITHER direction", async () => {
    cfg.brain.enabledPinnedByOperator = true;

    cfg.brain.enabled = true;
    const onBox = db({ enabled: false, enabledById: null, enabledAt: null });
    const on = await readBrainSwitch(onBox as never);
    expect(on.enabled).toBe(true);
    expect(on.pinnedByOperator).toBe(true);
    expect(onBox.brainSetting.findUnique).not.toHaveBeenCalled();

    // The direction that matters more: a box an operator pinned OFF must stay
    // off even though an owner had previously consented in the product.
    cfg.brain.enabled = false;
    const offBox = db({ enabled: true, enabledById: "u-owner", enabledAt: new Date() });
    const off = await readBrainSwitch(offBox as never);
    expect(off.enabled).toBe(false);
    expect(offBox.brainSetting.findUnique).not.toHaveBeenCalled();
  });

  it("reports no actor under a pin, so no screen stamps a name on the environment's decision", async () => {
    cfg.brain.enabledPinnedByOperator = true;
    cfg.brain.enabled = true;
    const out = await readBrainSwitch(
      db({ enabled: true, enabledById: "u-owner", enabledAt: new Date() }) as never,
    );
    expect(out.enabledById).toBeNull();
    expect(out.enabledAt).toBeNull();
  });

  it("isBrainEnabled is the same answer, since the passes must not have their own", async () => {
    expect(await isBrainEnabled(db({ enabled: true }) as never)).toBe(true);
    expect(await isBrainEnabled(db(null) as never)).toBe(false);
  });
});

describe("brainPassesSchedulable — what boot registers", () => {
  it("registers on an ordinary box, whichever way the row is set", () => {
    // The switch has to work without a restart, so registration cannot depend
    // on what the row said at boot.
    expect(brainPassesSchedulable()).toBe(true);
  });

  it("registers on a box pinned ON", () => {
    cfg.brain.enabledPinnedByOperator = true;
    cfg.brain.enabled = true;
    expect(brainPassesSchedulable()).toBe(true);
  });

  it("registers NOTHING on a box pinned OFF", () => {
    // The pin is policy. A forbidden feature should not be waking up hourly to
    // re-discover that it is forbidden.
    cfg.brain.enabledPinnedByOperator = true;
    cfg.brain.enabled = false;
    expect(brainPassesSchedulable()).toBe(false);
  });
});

describe("setBrainEnabled — the consent write", () => {
  it("stamps the actor pair when turning on", async () => {
    const prisma = db(null);
    await setBrainEnabled(prisma as never, { enabled: true, actorId: "u-owner" });

    const call = prisma.brainSetting.upsert.mock.calls[0]![0];
    expect(call.where.id).toBe(BRAIN_SETTING_ID);
    expect(call.create.enabled).toBe(true);
    expect(call.create.enabledById).toBe("u-owner");
    expect(call.create.enabledAt).toBeInstanceOf(Date);
    expect(call.update.enabledById).toBe("u-owner");
  });

  it("CLEARS the actor pair in the same statement that turns it off", async () => {
    // `BrainSetting_enabled_has_actor` is a biconditional: leaving the pair
    // populated is `false = true`, a 23514 that rolls back and leaves a row
    // still saying the brain is on. The off switch would not turn it off.
    const prisma = db({ enabled: true, enabledById: "u-owner", enabledAt: new Date() });
    await setBrainEnabled(prisma as never, { enabled: false, actorId: "u-owner" });

    const call = prisma.brainSetting.upsert.mock.calls[0]![0];
    expect(call.update.enabled).toBe(false);
    expect(call.update.enabledById).toBeNull();
    expect(call.update.enabledAt).toBeNull();
    expect(call.create.enabledById).toBeNull();
    expect(call.create.enabledAt).toBeNull();
  });

  it("REFUSES on a pinned box rather than storing consent nothing would read", async () => {
    cfg.brain.enabledPinnedByOperator = true;
    cfg.brain.enabled = false;
    const prisma = db(null);
    await expect(
      setBrainEnabled(prisma as never, { enabled: true, actorId: "u-owner" }),
    ).rejects.toThrow(BRAIN_SWITCH_PINNED);
    expect(prisma.brainSetting.upsert).not.toHaveBeenCalled();
  });
});
