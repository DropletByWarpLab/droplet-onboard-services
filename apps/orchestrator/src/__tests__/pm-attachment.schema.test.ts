/**
 * WARP-1505 — schema + migration + wiring assertions for PM attachments.
 *
 * Vitest mocks @prisma/client (see ./setup.ts), so these tests guard the
 * migration SQL, schema.prisma and the places the feature is plugged in
 * directly — the same pattern as pm-work-item-relation.schema.test.ts. The
 * BEHAVIOUR of the CHECK and the cascades is proven against a real Postgres in
 * pm-attachment.pg.test.ts; this file proves they are still SHIPPED and that the
 * sweep the schema's comments promise is actually registered (the P13 class:
 * "a cron promised in a comment and not wired in index.ts").
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR, readPackageFile, readSchema } from "./helpers/test-paths.js";

const SCHEMA = readSchema();

const DIR = (() => {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.includes("warp_1505_pm_attachments"));
  expect(dirs, "must ship a migration directory for WARP-1505").toHaveLength(1);
  return dirs[0];
})();
const SQL = readFileSync(join(MIGRATIONS_DIR, DIR, "migration.sql"), "utf8");

describe("the WARP-1505 migration", () => {
  it("uses the timestamp the Work Suite reserved for WS-3, so ordering is stable across branches", () => {
    expect(DIR).toBe("20261004030000_warp_1505_pm_attachments");
  });

  it("creates PmAttachmentStatus with exactly the four states", () => {
    expect(
      /CREATE TYPE "PmAttachmentStatus" AS ENUM \('UPLOADING', 'READY', 'FAILED', 'DELETED'\)/.test(SQL),
    ).toBe(true);
  });

  it("adds commentId, sha256 and status to the existing table — additive only", () => {
    expect(/ALTER TABLE "PmAttachment"\s+ADD COLUMN "commentId" TEXT,/.test(SQL)).toBe(true);
    expect(/ADD COLUMN "sha256" TEXT NOT NULL DEFAULT ''/.test(SQL)).toBe(true);
    expect(/ADD COLUMN "status" "PmAttachmentStatus" NOT NULL DEFAULT 'UPLOADING'/.test(SQL)).toBe(true);
    expect(/\bDROP (TABLE|COLUMN)\b/i.test(SQL), "an additive migration drops nothing").toBe(false);
  });

  it("drops the throwaway sha256 default, so the database matches schema.prisma (the drift gate)", () => {
    expect(/ALTER TABLE "PmAttachment" ALTER COLUMN "sha256" DROP DEFAULT/.test(SQL)).toBe(true);
    const add = SQL.indexOf('ADD COLUMN "sha256"');
    const drop = SQL.indexOf('ALTER COLUMN "sha256" DROP DEFAULT');
    expect(drop).toBeGreaterThan(add);
  });

  it("marks any pre-existing row FAILED — it never had bytes on a volume — rather than READY", () => {
    expect(/UPDATE "PmAttachment" SET "status" = 'FAILED'/.test(SQL)).toBe(true);
    expect(/UPDATE "PmAttachment" SET "status" = 'READY'/.test(SQL)).toBe(false);
  });

  it("cascades the comment FK and indexes it — an unindexed cascading FK is the WARP-845 hazard", () => {
    expect(
      /ADD CONSTRAINT "PmAttachment_commentId_fkey" FOREIGN KEY \("commentId"\) REFERENCES "PmComment"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/.test(
        SQL,
      ),
    ).toBe(true);
    expect(/CREATE INDEX "PmAttachment_commentId_idx" ON "PmAttachment"\("commentId"\)/.test(SQL)).toBe(true);
    expect(/CREATE INDEX "PmAttachment_status_createdAt_idx" ON "PmAttachment"\("status", "createdAt"\)/.test(SQL)).toBe(
      true,
    );
  });

  it("holds 'a READY row has a real digest' with a CHECK", () => {
    expect(
      /ADD CONSTRAINT "PmAttachment_ready_has_sha256"\s+CHECK \("status" <> 'READY' OR "sha256" ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(
        SQL,
      ),
    ).toBe(true);
  });

  it("extends PmActivityVerb with attachment_added / attachment_removed, idempotently", () => {
    for (const verb of ["attachment_added", "attachment_removed"]) {
      expect(new RegExp(`ALTER TYPE "PmActivityVerb" ADD VALUE '${verb}'`).test(SQL)).toBe(true);
      expect(new RegExp(`enumlabel = '${verb}'`).test(SQL), `${verb} must sit behind the pg_enum guard`).toBe(true);
    }
  });

  it("never USES a verb it added in the same transaction (Postgres refuses to)", () => {
    expect(/'attachment_added'::"PmActivityVerb"/.test(SQL)).toBe(false);
    expect(/'attachment_removed'::"PmActivityVerb"/.test(SQL)).toBe(false);
    // ...whereas the status values are fine to use: that enum was CREATEd here.
    expect(SQL.indexOf("CREATE TYPE")).toBeLessThan(SQL.indexOf("UPDATE \"PmAttachment\""));
  });
});

describe("schema.prisma carries the same shape", () => {
  const model = (name: string): string => {
    const m = new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`).exec(SCHEMA);
    expect(m, `model ${name}`).not.toBeNull();
    return m![0];
  };

  it("declares PmAttachmentStatus with the four states, in lifecycle order", () => {
    const m = /enum PmAttachmentStatus \{([\s\S]*?)\}/.exec(SCHEMA);
    expect(m).not.toBeNull();
    expect(m![1].split("\n").map((l) => l.trim()).filter(Boolean)).toEqual(["UPLOADING", "READY", "FAILED", "DELETED"]);
  });

  it("PmAttachment has the new columns, with the declared defaults and FK behaviour", () => {
    const att = model("PmAttachment");
    expect(att).toMatch(/commentId\s+String\?/);
    expect(att).toMatch(/comment\s+PmComment\?\s+@relation\(fields: \[commentId\], references: \[id\], onDelete: Cascade\)/);
    expect(att).toMatch(/sha256\s+String\n/); // no default: the migration drops it
    expect(att).toMatch(/status\s+PmAttachmentStatus\s+@default\(UPLOADING\)/);
    expect(att).toMatch(/storageKey\s+String\s+@unique/);
    expect(att).toMatch(/@@index\(\[commentId\]\)/);
    expect(att).toMatch(/@@index\(\[status, createdAt\]\)/);
    // the work item FK still cascades: deleting an item must not be blocked by its files
    expect(att).toMatch(/workItem\s+PmWorkItem\s+@relation\(fields: \[workItemId\], references: \[id\], onDelete: Cascade\)/);
  });

  it("PmComment carries the back-relation", () => {
    expect(model("PmComment")).toMatch(/attachments\s+PmAttachment\[\]/);
  });

  it("PmActivityVerb declares both verbs", () => {
    const m = /enum PmActivityVerb \{([\s\S]*?)\n\}/.exec(SCHEMA);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("attachment_added");
    expect(m![1]).toContain("attachment_removed");
  });
});

describe("the feature is wired in (a promised sweep that is not registered is a lie)", () => {
  const indexSrc = readPackageFile("src", "index.ts");
  const appSrc = readPackageFile("src", "app.ts");

  it("app.ts mounts the attachments router under /api, next to the other PM routers", () => {
    expect(appSrc).toMatch(/import \{ createPmAttachmentsRouter \} from "\.\/routes\/pm\/attachments\.js"/);
    expect(appSrc).toMatch(/app\.use\("\/api", createPmAttachmentsRouter\(prisma\)\)/);
  });

  it("index.ts registers the sweep on cron-runtime with its OWN lockKey", () => {
    expect(indexSrc).toMatch(/import \{ sweepAttachments \} from "\.\/services\/pm\/pm-attachments\.service\.js"/);
    const at = indexSrc.indexOf("sweepAttachments(prisma)");
    expect(at, "the sweep must be called from a registered handler").toBeGreaterThan(-1);
    const registration = indexSrc.slice(indexSrc.lastIndexOf("cronRuntime.scheduleInterval", at), at + 600);
    expect(registration).toMatch(/lockKey: "droplet:pm-attachment-sweep"/);
    // one registration per key — a copy-pasted key would make two jobs share a lock
    expect(indexSrc.match(/"droplet:pm-attachment-sweep"/g)).toHaveLength(1);
  });

  it("the sweep is not a `while (true)` loop (CLAUDE.md coding standards)", () => {
    const svc = readPackageFile("src", "services", "pm", "pm-attachments.service.ts");
    expect(svc).not.toMatch(/while\s*\(\s*true\s*\)/);
  });

  it("config declares both variables with container defaults, never a host path", () => {
    const cfg = readPackageFile("src", "config.ts");
    expect(cfg).toMatch(/PM_ATTACHMENTS_DIR: z\s*\.string\(\)\s*\.min\(1\)[\s\S]*?\.default\("\/data\/pm-attachments"\)/);
    expect(cfg).toMatch(/PM_ATTACHMENT_MAX_BYTES: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.default\(25 \* 1024 \* 1024\)/);
  });
});
