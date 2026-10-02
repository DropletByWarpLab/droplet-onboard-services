/**
 * WARP-2979 (ADR-059 P4 §6.3, §6.15) — the link-proposal job is wired, where
 * the spec puts it.
 *
 * A lost registration line reads "Not running" on the box's `links` health
 * row, which nobody may look at for weeks; this pins it in CI too. A source
 * pin, as the m365 and brain-pass wiring tests do: index.ts opens sockets and
 * connects to Postgres on import.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Normalised: a Windows checkout (core.autocrlf) has CRLF line ends.
const index = readFileSync(resolve(__dirname, "../index.ts"), "utf8").replace(/\r\n/g, "\n");

describe("index.ts wires Droplet's link proposals (WARP-2979)", () => {
  it("imports registerSecurityLinkJobs from the proposal service and calls it once, with the cron runtime, prisma and the lock names", () => {
    expect(index).toMatch(/import \{ registerSecurityLinkJobs \} from "\.\/services\/security-link-proposals\.service\.js";/);
    expect(index.match(/registerSecurityLinkJobs\(/g)).toHaveLength(1);
    // P4 PR-4: the started lock adapter's list names lock candidates — a function, read at each tick.
    expect(index).toMatch(/\n  registerSecurityLinkJobs\(cronRuntime, prisma, \{ knownLocks: \(\) => securityLocks\.knownLocks\(\) \}\);\n/);
    expect(index.indexOf("const securityLocks = startSecurityLockAdapter(")).toBeGreaterThan(0);
    expect(index.indexOf("const securityLocks = startSecurityLockAdapter(")).toBeLessThan(index.indexOf("registerSecurityLinkJobs(cronRuntime"));
  });

  it("right after the incident engine's registration, before the baseline job's", () => {
    const incidents = index.indexOf("registerSecurityIncidentJobs(cronRuntime");
    const links = index.indexOf("registerSecurityLinkJobs(cronRuntime");
    const baselines = index.indexOf("registerSecurityBaselineJobs(cronRuntime");
    expect(incidents).toBeGreaterThan(0);
    expect(links).toBeGreaterThan(incidents);
    expect(baselines).toBeGreaterThan(links);
    // Nothing but the incident call's own arguments and a comment between the two.
    const between = index.slice(index.indexOf("});", incidents) + 3, links);
    expect(between.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"))).toEqual([]);
  });
});
