/**
 * WARP-3536 — "Also viewing": who has a work item's drawer open right now.
 * In memory, 20 s per heartbeat, bounded.
 */
import { describe, it, expect } from "vitest";
import { createPresenceStore, PRESENCE_TTL_MS } from "./pm-presence.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("presence store", () => {
  it("lists the OTHER people who have beaten on an item, never the caller", () => {
    const c = clock();
    const store = createPresenceStore({ now: c.now });
    store.beat("wi-1", "ana");
    store.beat("wi-1", "ben");
    store.beat("wi-1", "cy");

    expect(store.others("wi-1", "ana")).toEqual(["ben", "cy"]);
    expect(store.others("wi-1", "ben")).toEqual(["ana", "cy"]);
    // Someone who never beat still sees everybody (the GET is a read, not a join).
    expect(store.others("wi-1", "visitor")).toEqual(["ana", "ben", "cy"]);
  });

  it("a heartbeat lasts exactly the TTL (20 s)", () => {
    expect(PRESENCE_TTL_MS).toBe(20_000);
    const c = clock();
    const store = createPresenceStore({ now: c.now });
    store.beat("wi-1", "ana");

    c.advance(PRESENCE_TTL_MS - 1);
    expect(store.others("wi-1", "me")).toEqual(["ana"]);
    c.advance(1);
    expect(store.others("wi-1", "me")).toEqual([]);
  });

  it("a later heartbeat extends the entry", () => {
    const c = clock();
    const store = createPresenceStore({ now: c.now });
    store.beat("wi-1", "ana");
    c.advance(10_000);
    store.beat("wi-1", "ben");
    c.advance(10_000);
    store.beat("wi-1", "ana"); // ana would have expired at 20 s; this keeps her

    c.advance(10_000); // 30 s after her first beat, 10 s after her second
    expect(store.others("wi-1", "me")).toEqual(["ana"]); // ben expired at 30 s
  });

  it("keeps items apart", () => {
    const store = createPresenceStore({ now: clock().now });
    store.beat("wi-1", "ana");
    store.beat("wi-2", "ben");
    expect(store.others("wi-1", "me")).toEqual(["ana"]);
    expect(store.others("wi-2", "me")).toEqual(["ben"]);
    expect(store.others("wi-3", "me")).toEqual([]);
  });

  it("drops expired entries rather than only hiding them", () => {
    const c = clock();
    const store = createPresenceStore({ now: c.now });
    store.beat("wi-1", "ana");
    store.beat("wi-2", "ben");
    expect(store.size()).toBe(2);

    c.advance(PRESENCE_TTL_MS);
    expect(store.size()).toBe(0);
  });

  it("is bounded: past maxItems a NEW item is refused, tracked ones keep working", () => {
    const store = createPresenceStore({ now: clock().now, maxItems: 2 });
    store.beat("wi-1", "ana");
    store.beat("wi-2", "ana");
    store.beat("wi-3", "ana"); // refused: the map is full of live entries

    expect(store.size()).toBe(2);
    expect(store.others("wi-3", "me")).toEqual([]);
    store.beat("wi-1", "ben"); // an already-tracked item still takes viewers
    expect(store.others("wi-1", "me")).toEqual(["ana", "ben"]);
  });

  it("makes room by dropping what has expired before it refuses", () => {
    const c = clock();
    const store = createPresenceStore({ now: c.now, maxItems: 1 });
    store.beat("wi-1", "ana");
    c.advance(PRESENCE_TTL_MS);
    store.beat("wi-2", "ben");

    expect(store.others("wi-2", "me")).toEqual(["ben"]);
    expect(store.size()).toBe(1);
  });
});
