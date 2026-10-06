/**
 * WARP-3536 — the page-wide fan-out for `droplet/pm/<username>`: the one socket
 * that already exists hands each Projects frame here, and the Projects page
 * subscribes. Anything that is not a well-formed `pm.changed` frame is ignored.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { subscribePmLive, publishPmLiveFrame, notifyPmLiveResync, type PmLiveSignal } from "./pm-live-events";

const GOOD = { type: "pm.changed", projectId: "p-1", workItemId: "w-1", verb: "state_changed" };

function listen() {
  const seen: PmLiveSignal[] = [];
  const off = subscribePmLive((s) => void seen.push(s));
  return { seen, off };
}

const offs: Array<() => void> = [];
afterEach(() => {
  while (offs.length) offs.pop()!();
});

describe("publishPmLiveFrame", () => {
  it("hands a well-formed frame on the person's topic to every subscriber", () => {
    const a = listen();
    const b = listen();
    offs.push(a.off, b.off);

    publishPmLiveFrame("droplet/pm/alice", GOOD);

    expect(a.seen).toEqual([GOOD]);
    expect(b.seen).toEqual([GOOD]);
  });

  it.each([
    ["another topic", "droplet/notifications/alice", GOOD],
    ["no topic", undefined, GOOD],
    ["a non-string topic", 42, GOOD],
    ["no payload", "droplet/pm/alice", null],
    ["a payload that is not an object", "droplet/pm/alice", "pm.changed"],
    ["another type", "droplet/pm/alice", { ...GOOD, type: "pm.deleted" }],
    ["no project id", "droplet/pm/alice", { ...GOOD, projectId: undefined }],
    ["an empty work item id", "droplet/pm/alice", { ...GOOD, workItemId: "" }],
    ["a non-string verb", "droplet/pm/alice", { ...GOOD, verb: 7 }],
    ["an id that is not an id (too long)", "droplet/pm/alice", { ...GOOD, projectId: "x".repeat(65) }],
  ])("ignores %s", (_name, topic, payload) => {
    const l = listen();
    offs.push(l.off);
    publishPmLiveFrame(topic, payload);
    expect(l.seen).toEqual([]);
  });

  it("passes on ONLY the four fields, whatever else the frame carried", () => {
    const l = listen();
    offs.push(l.off);
    publishPmLiveFrame("droplet/pm/alice", { ...GOOD, title: "Secret plans", html: "<script>" });
    expect(l.seen).toEqual([GOOD]);
  });

  it("stops delivering to a subscriber that has unsubscribed", () => {
    const l = listen();
    l.off();
    publishPmLiveFrame("droplet/pm/alice", GOOD);
    expect(l.seen).toEqual([]);
  });

  it("one subscriber that throws does not stop the others", () => {
    const bad = subscribePmLive(() => {
      throw new Error("boom");
    });
    const l = listen();
    offs.push(bad, l.off);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    publishPmLiveFrame("droplet/pm/alice", GOOD);
    spy.mockRestore();
    expect(l.seen).toEqual([GOOD]);
  });
});

describe("notifyPmLiveResync", () => {
  it("tells subscribers to re-read everything (a socket that came back may have missed frames)", () => {
    const l = listen();
    offs.push(l.off);
    notifyPmLiveResync();
    expect(l.seen).toEqual([{ type: "resync" }]);
  });
});
