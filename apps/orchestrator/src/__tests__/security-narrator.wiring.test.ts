/**
 * WARP-2979 (ADR-059 P4 §6.9.3, §6.15) — the incident narrator is wired,
 * where the spec puts it, and its health row reaches /security/health.
 *
 * A lost registration line reads "Not running" on the box's `summaries`
 * row, which nobody may look at for weeks; this pins it in CI too. Source
 * pins, as the link-job wiring test does: index.ts opens sockets and
 * connects to Postgres on import.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Normalised: a Windows checkout (core.autocrlf) has CRLF line ends.
const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8").replace(/\r\n/g, "\n");
const index = read("../index.ts");
const routes = read("../routes/security.ts");

describe("index.ts wires Droplet's incident narrator (WARP-2979 PR-2)", () => {
  it("imports registerSecurityNarratorJobs from the narrator and calls it once, with the cron runtime and prisma", () => {
    expect(index).toMatch(/import \{ registerSecurityNarratorJobs \} from "\.\/services\/security-narrator\.service\.js";/);
    expect(index.match(/registerSecurityNarratorJobs\(/g)).toHaveLength(1);
    expect(index).toMatch(/\n  registerSecurityNarratorJobs\(cronRuntime, prisma\);\n/);
  });

  it("right after the link job's registration, before the baseline job's — comments only between", () => {
    const links = index.indexOf("registerSecurityLinkJobs(cronRuntime");
    const narrator = index.indexOf("registerSecurityNarratorJobs(cronRuntime");
    const baselines = index.indexOf("registerSecurityBaselineJobs(cronRuntime");
    expect(links).toBeGreaterThan(0);
    expect(narrator).toBeGreaterThan(links);
    expect(baselines).toBeGreaterThan(narrator);
    const between = index.slice(index.indexOf("\n", links) + 1, narrator);
    expect(between.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"))).toEqual([]);
  });
});

describe("GET /security/health carries the summaries row (WARP-2979 PR-2)", () => {
  it("reads it from the narrator, never throwing, and hands it to buildSecurityHealth", () => {
    expect(routes).toMatch(/import \{ securitySummariesHealth \} from "\.\.\/services\/security-narrator\.service\.js";/);
    expect(routes).toMatch(/securitySummariesHealth\(prisma, now\)/);
    expect(routes).toMatch(/\n\s+summaries,\n/);
  });
});
