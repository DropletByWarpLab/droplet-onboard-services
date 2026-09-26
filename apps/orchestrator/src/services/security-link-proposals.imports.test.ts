/**
 * WARP-2979 (ADR-059 P4 §6.6) — what Droplet's linking can never reach, pinned
 * on its source.
 *
 * The job counts and writes links. It must not be ABLE to change the mode,
 * the hours, who is told about alerts, what counts as expected, camera grants,
 * access roles or any device: so it imports nothing from those modules, and
 * its own Prisma writes touch only `securityZoneLink` and `securityZone` (the
 * version CAS, `updateMany` with `version: {increment: 1}` and nothing else).
 * Its audits go through `auditSecuritySystemInTx` only (the system actor,
 * never `ai`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "security-link-proposals.service.ts"), "utf8");
const LIB = readFileSync(resolve(__dirname, "../lib/security-cooccurrence.ts"), "utf8");

const importsOf = (src: string) => [...src.matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]!);

describe("security-link-proposals imports nothing that can change what it must never change", () => {
  it("imports exactly the allowed modules", () => {
    expect(importsOf(SRC).sort()).toEqual(
      [
        "node:crypto",
        "@prisma/client",
        "./cron-runtime.service.js",
        "./security-events.service.js",
        "./security-ai-settings.js",
        "./security-audit.js",
        "../lib/security-cooccurrence.js",
        "../lib/prisma-tx.js",
        "../lib/security-hours.js",
        "../lib/zoned-time.js",
        "../lib/logger.js",
      ].sort(),
    );
  });

  it("nothing from mode, hours writes, alert routing, suppressions, camera grants, access roles or device control", () => {
    const forbidden =
      /security-mode|security-alerts|alert-routing|suppression|camera-access|camera-grant|access-catalog|effective-access|feature-gate|matter|device-control|smart-home|security-incidents|security-baselines/;
    for (const src of [SRC, LIB]) for (const m of importsOf(src)) expect(m).not.toMatch(forbidden);
    // security-hours is imported for its clock COPY only.
    expect(SRC).toMatch(/import \{ siteDayClockCopy \} from "\.\.\/lib\/security-hours\.js";/);
    // The arithmetic is pure: no Prisma, no clock.
    for (const m of importsOf(LIB)) expect(m).toMatch(/^\.\/security-(stats|link-evidence)\.js$/);
  });

  it("its Prisma writes touch only securityZoneLink and the area's version", () => {
    const writes = [...SRC.matchAll(/\b(?:tx|prisma)\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(writes.length).toBeGreaterThan(0);
    expect(new Set(writes)).toEqual(new Set(["securityZone.updateMany", "securityZoneLink.createMany", "securityZoneLink.updateMany"]));
    // The area write is the version CAS and nothing else.
    const area = SRC.slice(SRC.indexOf("tx.securityZone.updateMany("), SRC.indexOf("tx.securityZone.updateMany(") + 220);
    expect(area).toMatch(/data: \{ version: \{ increment: 1 \} \}/);
    expect(area).toMatch(/state: "active"/);
    // Raw SQL would dodge the pin.
    expect(SRC).not.toMatch(/\$executeRaw|\$queryRaw/);
  });

  it("every link update is guarded on Droplet's own row, and audits go as the system actor only", () => {
    expect(SRC).toMatch(/const dropletGuard = \(id: string, state: "proposed"\) => \(\{ id, state, origin: "droplet" as const, stateSetBy: "droplet" as const \}\);/);
    const updates = [...SRC.matchAll(/securityZoneLink\.updateMany\(\{\s*where: (\w+)\(/g)].map((m) => m[1]);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(new Set(updates)).toEqual(new Set(["dropletGuard"]));
    expect(SRC).toMatch(/auditSecuritySystemInTx\(tx, a\)/);
    expect(SRC).not.toMatch(/auditSecurityInTx\(|auditSecuritySystem\(|type: "ai"/);
  });
});
