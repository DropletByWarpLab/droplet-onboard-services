/**
 * WARP-3510 — one process-wide lock over every Frigate config writer.
 *
 * `addCamera`, `syncCamerasFromDb`, `deleteCamera`, `updateCameraSettings` and
 * the retention backfill are all read-modify-write against Frigate's authored
 * YAML (or a config/set that Frigate merges into the same file). Two of them in
 * flight at once each read the same text, each write it back, and whichever
 * lands second silently undoes the other — a deleted camera comes back, a new
 * one vanishes. They now queue behind one promise-chain lock.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { withFrigateConfigLock } from "./frigate.client.js";

/** A promise you resolve by hand, to pin an interleaving. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

describe("withFrigateConfigLock", () => {
  it("runs overlapping sections one at a time, in arrival order", async () => {
    const events: string[] = [];
    const first = gate();

    const a = withFrigateConfigLock(async () => {
      events.push("a:start");
      await first.promise;
      events.push("a:end");
      return "a";
    });
    const b = withFrigateConfigLock(async () => {
      events.push("b:start");
      events.push("b:end");
      return "b";
    });
    const c = withFrigateConfigLock(async () => {
      events.push("c:start");
      return "c";
    });

    // Let any section that is going to start, start.
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["a:start"]);

    first.open();
    await expect(Promise.all([a, b, c])).resolves.toEqual(["a", "b", "c"]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start"]);
  });

  it("hands the lock on after a section throws, and still rejects the thrower", async () => {
    const boom = withFrigateConfigLock(async () => {
      throw new Error("frigate said no");
    });
    const next = withFrigateConfigLock(async () => "still ran");

    await expect(boom).rejects.toThrow("frigate said no");
    await expect(next).resolves.toBe("still ran");
  });

  it("is re-entrant: a section that calls another locked function does not deadlock", async () => {
    const inner = vi.fn(async () => "inner");

    const result = await withFrigateConfigLock(async () => {
      // e.g. the add pipeline holds the lock across addCamera + the DB write,
      // and addCamera takes the lock itself.
      const value = await withFrigateConfigLock(inner);
      return `outer+${value}`;
    });

    expect(result).toBe("outer+inner");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does not let an unrelated caller ride a section's re-entrancy", async () => {
    const hold = gate();
    const events: string[] = [];

    const owner = withFrigateConfigLock(async () => {
      events.push("owner:start");
      await hold.promise;
      events.push("owner:end");
    });
    // Started from outside the owner's async chain — it must queue.
    const outsider = withFrigateConfigLock(async () => {
      events.push("outsider");
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["owner:start"]);

    hold.open();
    await Promise.all([owner, outsider]);
    expect(events).toEqual(["owner:start", "owner:end", "outsider"]);
  });
});
