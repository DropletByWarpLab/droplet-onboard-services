/**
 * WARP-2651 — the attach lifecycle as an EXPLICIT enum, and the read-time
 * surface that renders it.
 *
 * The reconciler's own behaviour is `remote-mcp-reconciler.test.ts`. This file
 * pins the three properties that file would still pass without: the state is a
 * declared value and never derived from an absent session, the backoff is
 * bounded at both ends, and every reason maps to a remediation a person can act
 * on.
 */
import { describe, it, expect } from "vitest";
import { providerDescriptor } from "@droplet/shared-types";
import {
  ownsBridgeSession,
  remoteMcpBackoffMs,
  RemoteMcpLifecycleRegistry,
  REMOTE_MCP_ATTACH_STATES,
  type RemoteMcpAttachReason,
} from "./remote-mcp-lifecycle.service.js";
import { buildCredentialView } from "./saas-credential.service.js";

const SERVER = "atlassian";

describe("the state is DECLARED, never derived", () => {
  it("an unregistered server has no view at all — which is not a failure state", () => {
    const reg = new RemoteMcpLifecycleRegistry();
    expect(reg.get(SERVER)).toBeUndefined();
    expect(reg.view(SERVER)).toBeNull();
    expect(reg.list()).toEqual([]);
  });

  it("carries a reason for every non-attached state, and none for attached", () => {
    const reg = new RemoteMcpLifecycleRegistry();
    reg.record({ serverId: SERVER, state: "attached" });
    expect(reg.view(SERVER)).toMatchObject({ reason: null, remediation: "none" });

    reg.record({ serverId: SERVER, state: "detached", reason: "gate_refused" });
    expect(reg.view(SERVER)).toMatchObject({
      state: "detached",
      reason: "gate_refused",
      remediation: "reconnect_account",
    });
  });

  it("`since` moves on a CHANGE and holds across a no-op re-record", () => {
    const clock = { now: 1_000 };
    const reg = new RemoteMcpLifecycleRegistry(() => clock.now);
    reg.record({ serverId: SERVER, state: "reattaching", reason: "session_lost" });
    const first = reg.get(SERVER)!.since;

    clock.now += 5_000;
    reg.record({ serverId: SERVER, state: "reattaching", reason: "session_lost" });
    // "How long has this been reattaching" has to survive a tick that found
    // nothing changed, or it degrades into "since the last tick".
    expect(reg.get(SERVER)!.since).toBe(first);

    clock.now += 5_000;
    reg.record({ serverId: SERVER, state: "attached" });
    expect(reg.get(SERVER)!.since).toBe(clock.now);
  });

  it("reports `changed` only for a real transition, so audit rows are not a heartbeat", () => {
    const reg = new RemoteMcpLifecycleRegistry();
    expect(reg.record({ serverId: SERVER, state: "attached" })).toMatchObject({
      changed: true,
      from: null,
      to: "attached",
    });
    expect(reg.record({ serverId: SERVER, state: "attached" }).changed).toBe(false);
    expect(reg.record({ serverId: SERVER, state: "detached", reason: "session_lost" })).toMatchObject(
      { changed: true, from: "attached", to: "detached" },
    );
  });

  it("keeps the drift baseline across a state change that does not supply one", () => {
    const reg = new RemoteMcpLifecycleRegistry();
    reg.record({ serverId: SERVER, state: "attached", vettedTools: ["a", "b"] });
    reg.record({ serverId: SERVER, state: "reattaching", reason: "session_lost" });
    // The baseline is what makes the RE-open able to detect drift. Losing it on
    // the way into `reattaching` would silently disable the check exactly when
    // it is needed.
    expect(reg.get(SERVER)!.vettedTools).toEqual(["a", "b"]);
  });
});

describe("the bridge backoff is bounded at both ends", () => {
  it("is zero before a failure, grows, and caps at ten minutes", () => {
    expect(remoteMcpBackoffMs(0)).toBe(0);
    expect(remoteMcpBackoffMs(1)).toBe(30_000);
    expect(remoteMcpBackoffMs(2)).toBe(60_000);
    // Capped: an unbounded backoff leaves a box detached for hours after the
    // container came back.
    expect(remoteMcpBackoffMs(50)).toBe(10 * 60_000);
  });

  it("arms on a failed hop and clears on a successful one", () => {
    const clock = { now: 1_000 };
    const reg = new RemoteMcpLifecycleRegistry(() => clock.now);
    reg.record({
      serverId: SERVER,
      state: "bridge_unreachable",
      reason: "health_unreachable",
      bridgeHop: "failed",
    });
    expect(reg.get(SERVER)).toMatchObject({
      consecutiveBridgeFailures: 1,
      nextAttemptAt: 31_000,
    });
    reg.record({ serverId: SERVER, state: "attached", bridgeHop: "succeeded" });
    expect(reg.get(SERVER)).toMatchObject({
      consecutiveBridgeFailures: 0,
      nextAttemptAt: 0,
    });
  });
});

describe("session ownership decides the orphan sweep", () => {
  const reg = new RemoteMcpLifecycleRegistry();
  const at = (state: (typeof REMOTE_MCP_ATTACH_STATES)[number], reason: RemoteMcpAttachReason | null) => {
    reg.record({ serverId: SERVER, state, reason });
    return reg.get(SERVER)!;
  };

  it("owns an attached and a reattaching session", () => {
    expect(ownsBridgeSession(at("attached", null))).toBe(true);
    expect(ownsBridgeSession(at("reattaching", "session_lost"))).toBe(true);
  });

  it("owns a catalog_changed session even though it is detached", () => {
    // Closing it would destroy the drift record and the acknowledge call that
    // resolves it — the sweep would turn "re-vet this" into "it came back new".
    expect(ownsBridgeSession(at("detached", "catalog_changed"))).toBe(true);
  });

  it("does NOT own a session behind a refused gate or an unreachable bridge", () => {
    expect(ownsBridgeSession(at("detached", "gate_refused"))).toBe(false);
    expect(ownsBridgeSession(at("bridge_unreachable", "health_unreachable"))).toBe(false);
  });
});

describe("the read-time credential view carries the attachment (the #1950 shape)", () => {
  const atlassian = providerDescriptor("atlassian");

  it("surfaces state + reason + remediation for an `mcp` track", () => {
    const lifecycle = new RemoteMcpLifecycleRegistry();
    lifecycle.record({ serverId: SERVER, state: "reattaching", reason: "session_lost" });

    const view = buildCredentialView(atlassian!, null, new Date(), lifecycle);
    expect(view.remoteMcp).toMatchObject({
      serverId: SERVER,
      state: "reattaching",
      reason: "session_lost",
      remediation: "wait",
    });
  });

  it("is null when nothing has attached — the shipping default, not an error", () => {
    const view = buildCredentialView(
      atlassian!,
      null,
      new Date(),
      new RemoteMcpLifecycleRegistry(),
    );
    expect(view.remoteMcp).toBeNull();
  });

  it("is null for a cloud track, which has no session concept", () => {
    const lifecycle = new RemoteMcpLifecycleRegistry();
    lifecycle.record({ serverId: SERVER, state: "attached" });
    const stripe = providerDescriptor("stripe");
    expect(stripe?.track).toBe("cloud");
    expect(buildCredentialView(stripe!, null, new Date(), lifecycle).remoteMcp).toBeNull();
  });
});
