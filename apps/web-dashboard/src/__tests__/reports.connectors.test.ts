/**
 * WARP-1994 — connector presentation pins.
 *
 * Two rules here carry real weight: all seven statuses stay distinct, and
 * problems sort first. Collapsing DEGRADED into ERROR loses "fix this" vs
 * "this is broken"; collapsing DISABLED into NOT_CONFIGURED loses "you turned
 * it off" vs "you never set it up". And a broken connector sorted
 * alphabetically behind three healthy ones is a connector nobody notices.
 */
import { describe, it, expect } from "vitest";
import {
  PILL,
  providerMark,
  providerName,
  relativeSince,
  statusLine,
  statusWeight,
} from "@/app/reports/connectors";
import type { IntegrationStatusName } from "@/app/reports/api";

const ALL: IntegrationStatusName[] = [
  "NOT_CONFIGURED",
  "PROVISIONING",
  "CONNECTED",
  "CAPABILITY_LIMITED",
  "DEGRADED",
  "DRIFT_LOCKED",
  "NEEDS_RECONNECT",
  "ERROR",
  "DISABLED",
];

const NOW = new Date("2026-08-14T09:41:00.000Z");

describe("PILL — all nine statuses stay distinct", () => {
  it("covers every status", () => {
    for (const s of ALL) expect(PILL[s]).toBeDefined();
    // WARP-2458 added the eighth, WARP-2623 the ninth. Mutation: add a member
    // to the union and not to PILL → red, because `Record<IntegrationStatusName,
    // …>` and this count disagree.
    expect(Object.keys(PILL)).toHaveLength(9);
  });

  it("gives each status its own label — none collapsed into another", () => {
    const labels = ALL.map((s) => PILL[s].label);
    expect(new Set(labels).size).toBe(9);
  });

  it("uses the brief's exact copy", () => {
    expect(PILL.CONNECTED.label).toBe("Connected");
    expect(PILL.DEGRADED.label).toBe("Needs attention");
    expect(PILL.DRIFT_LOCKED.label).toBe("Locked — schema changed");
    expect(PILL.ERROR.label).toBe("Can't connect");
    expect(PILL.PROVISIONING.label).toBe("Setting up");
    expect(PILL.DISABLED.label).toBe("Turned off");
    expect(PILL.NOT_CONFIGURED.label).toBe("Not connected");
    // Names the ACTION, not the symptom: the one thing the owner can do
    // about a revoked credential is go and paste a new one.
    expect(PILL.NEEDS_RECONNECT.label).toBe("Paste a new key");
    // WARP-2623 — the connection WORKS. Mutation: reuse "Can't connect" here
    // → red, and a syncing Basic-plan store is drawn as a broken one.
    expect(PILL.CAPABILITY_LIMITED.label).toBe("Connected · limited");
    expect(PILL.CAPABILITY_LIMITED.tone).not.toBe("bad");
  });

  it("pairs every pill with an icon — status is never colour alone", () => {
    for (const s of ALL) expect(PILL[s].icon).toBeTruthy();
  });
});

describe("statusWeight — problems first", () => {
  it("orders the four problem states ahead of everything healthy", () => {
    // NEEDS_RECONNECT joins the problems (WARP-2458): a revoked credential is
    // something the owner must act on, so burying it below CONNECTED rows is
    // exactly the "hunt for the broken one" this ordering exists to prevent.
    const problems = ["ERROR", "DRIFT_LOCKED", "NEEDS_RECONNECT", "DEGRADED"] as const;
    const rest = ["CONNECTED", "PROVISIONING", "DISABLED", "NOT_CONFIGURED"] as const;
    for (const p of problems) {
      for (const r of rest) {
        expect(statusWeight(p)).toBeLessThan(statusWeight(r));
      }
    }
  });

  it("puts ERROR ahead of every other problem", () => {
    expect(statusWeight("ERROR")).toBeLessThan(statusWeight("DRIFT_LOCKED"));
    expect(statusWeight("ERROR")).toBeLessThan(statusWeight("DEGRADED"));
    expect(statusWeight("ERROR")).toBeLessThan(statusWeight("NEEDS_RECONNECT"));
    // A throttle clears itself; a revoked credential waits for a person. The
    // one that needs a human sorts first. Mutation: swap the two weights → red.
    expect(statusWeight("NEEDS_RECONNECT")).toBeLessThan(statusWeight("DEGRADED"));
  });

  it("sorts CAPABILITY_LIMITED below the problems and above CONNECTED", () => {
    // WARP-2623 — it is not a problem (nothing is broken and no retry helps),
    // but it is the one healthy state still carrying a fact the owner has not
    // seen. Mutation: give it CONNECTED's weight → the second assertion goes
    // red and a limited connector hides among the fully healthy ones.
    expect(statusWeight("DEGRADED")).toBeLessThan(statusWeight("CAPABILITY_LIMITED"));
    expect(statusWeight("CAPABILITY_LIMITED")).toBeLessThan(statusWeight("CONNECTED"));
  });

  it("sorts an unknown status WITH the problems, not last", () => {
    // A status a newer box invented is something we can't classify — worth a
    // look, not a burial at the bottom of the list.
    const unknown = statusWeight("SOMETHING_NEW" as IntegrationStatusName);
    expect(unknown).toBeLessThan(statusWeight("CONNECTED"));
  });
});

describe("providerName / providerMark", () => {
  it("names the three tracks so they are tellable apart", () => {
    expect(providerName("eaglesoft")).toBe("Eaglesoft (direct SQL)");
    expect(providerName("eaglesoft-api")).toBe("Eaglesoft API");
    expect(providerName("eaglesoft-export")).toBe("Eaglesoft (export)");
  });

  it("title-cases an unknown provider rather than dropping it", () => {
    expect(providerName("new_vendor")).toBe("New Vendor");
  });

  it("marks a provider from its vendor, not its track", () => {
    expect(providerMark("eaglesoft-export")).toBe("EA");
    expect(providerMark("dentrix-export")).toBe("DE");
  });
});

describe("relativeSince", () => {
  it("returns null for a connector that has never synced", () => {
    expect(relativeSince(null, NOW)).toBeNull();
  });

  it("formats the usual spans", () => {
    expect(relativeSince("2026-08-14T09:39:00.000Z", NOW)).toBe("2 min ago");
    expect(relativeSince("2026-08-14T06:41:00.000Z", NOW)).toBe("3 h ago");
    expect(relativeSince("2026-08-11T09:41:00.000Z", NOW)).toBe("3 days ago");
    expect(relativeSince("2026-08-13T09:41:00.000Z", NOW)).toBe("1 day ago");
  });

  it("reads a future timestamp as 'just now' rather than a negative duration", () => {
    // Clock skew between the box and the browser is real; "-3 min ago" is not
    // a thing a user should ever see.
    expect(relativeSince("2026-08-14T09:44:00.000Z", NOW)).toBe("just now");
  });

  it("returns null for an unparseable timestamp", () => {
    expect(relativeSince("not-a-date", NOW)).toBeNull();
  });
});

describe("statusLine — never invents a sync that didn't happen", () => {
  const line = (over: Partial<Parameters<typeof statusLine>[0]>) =>
    statusLine(
      { status: "CONNECTED", writeEnabled: false, lastSyncedAt: null, ...over },
      NOW,
    );

  it("says never connected for an unconfigured provider", () => {
    expect(line({ status: "NOT_CONFIGURED" })).toBe("Never connected");
  });

  it("says never synced rather than fabricating a time", () => {
    // The failure this pins: a row reading "Synced just now" because the
    // formatter fell back to `new Date()` on a null timestamp.
    expect(line({ status: "CONNECTED", lastSyncedAt: null })).toBe("Connected · never synced");
  });

  it("reports the sync time and the access posture when it has one", () => {
    expect(line({ lastSyncedAt: "2026-08-14T09:39:00.000Z" })).toBe(
      "Synced 2 min ago · read-only",
    );
  });

  it("names read-write when writes are on", () => {
    expect(line({ lastSyncedAt: "2026-08-14T09:39:00.000Z", writeEnabled: true })).toBe(
      "Synced 2 min ago · read-write",
    );
  });

  it("does not claim a pending first sync has happened", () => {
    expect(line({ status: "PROVISIONING" })).toBe("Setting up · first sync pending");
  });

  it("keeps a disabled connector's last-known sync visible", () => {
    expect(line({ status: "DISABLED", lastSyncedAt: "2026-08-11T09:41:00.000Z" })).toBe(
      "Turned off · last synced 3 days ago",
    );
  });
});
