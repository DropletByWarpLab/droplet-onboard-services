/**
 * WARP-3510 / WARP-3506 — Camera.adoption and "Camera.name is the Frigate key",
 * the DB-less half.
 *
 * Vitest mocks `@prisma/client` (see ./setup.ts), so these suites read
 * schema.prisma and the two migration files. What the SQL actually DOES to rows
 * (the backfill, the rename, the collision rule, idempotence) is proven against
 * a real Postgres by camera-adoption.pg.test.ts.
 *
 *   20261003120000_warp_3510_camera_adoption
 *     the explicit CANDIDATE | ADOPTED state, backfilled from enabled /
 *     autoDiscovered, never inferred from them afterwards (CLAUDE.md "no
 *     guessing").
 *   20261003120100_warp_3506_camera_name_is_frigate_key
 *     one DO block that rewrites Camera.name (and the denormalised
 *     CameraPin.cameraName) to toFrigateKey(name), leaving a colliding row alone
 *     instead of aborting the deploy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { MIGRATIONS_DIR, readSchema } from "./helpers/test-paths.js";

const ADOPTION_SUFFIX = "_warp_3510_camera_adoption";
const FRIGATE_KEY_SUFFIX = "_warp_3506_camera_name_is_frigate_key";

/**
 * The newest folder on stage when these two were written (the WARP-3474
 * cleanup). Both new folders must sort after it, so a box that applied
 * everything up to it runs them last. A frozen constant, like the WARP-3474 guard
 * in migration-names.guard.test.ts: "after every folder in the directory" would
 * turn red the day the next migration lands.
 */
const STAGE_NEWEST = "20261003000000_warp_3474_remove_security_doors_modules";

function migrationFolders(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((name) => statSync(path.join(MIGRATIONS_DIR, name)).isDirectory());
}

/** The one folder ending in `suffix`; a missing or doubled folder fails here, by name. */
function folderEndingWith(suffix: string): string {
  const matches = migrationFolders().filter((name) => name.endsWith(suffix));
  expect(matches, `exactly one migration folder must end in ${suffix}`).toHaveLength(1);
  return matches[0]!;
}

function migrationSql(suffix: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, folderEndingWith(suffix), "migration.sql"), "utf8");
}

/**
 * The SQL with every `--` comment removed. The headers talk about DELETE, the
 * UPDATE rule and the expression they describe; an assertion about what the
 * file DOES must not be satisfied (or failed) by its own prose. No string
 * literal in either file contains `--`.
 */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Whitespace-free, so a layout change does not read as a semantic one. */
function squash(sql: string): string {
  return sql.replace(/\s+/g, "");
}

describe("Camera.adoption schema (WARP-3510)", () => {
  it("declares the CameraAdoption enum with exactly CANDIDATE and ADOPTED", () => {
    const block = readSchema().match(/enum CameraAdoption \{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    const members = block![1]!
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"));
    expect(members).toEqual(["CANDIDATE", "ADOPTED"]);
  });

  it("is a required enum column on Camera defaulting to CANDIDATE", () => {
    const block = readSchema().match(/model Camera \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\n\s+adoption\s+CameraAdoption\s+@default\(CANDIDATE\)/);
    expect(block![0]).not.toMatch(/\n\s+adoption\s+CameraAdoption\?/);
  });

  it("keeps the two unique keys the rename migration's collision rules lean on", () => {
    const camera = readSchema().match(/model Camera \{[\s\S]*?\n\}/)![0];
    expect(camera).toMatch(/\n\s+name\s+String\s+@unique/);
    const pin = readSchema().match(/model CameraPin \{[\s\S]*?\n\}/)![0];
    // A plain, required string column: no FK and no relation, so a rename of the
    // camera cannot reach it by itself and the migration has to move it.
    expect(pin).toMatch(/\n\s+cameraName\s+String(?![?\w])/);
    expect(pin).not.toMatch(/@relation/);
    expect(pin).toMatch(/@@unique\(\[userId, cameraName\]\)/);
  });
});

describe("migration warp_3510_camera_adoption", () => {
  const sql = migrationSql(ADOPTION_SUFFIX);
  const statements = code(sql);

  it("creates the enum through the duplicate_object idiom, so a re-run is a no-op", () => {
    expect(statements).toMatch(
      /DO \$\$ BEGIN\s+CREATE TYPE "CameraAdoption" AS ENUM \('CANDIDATE', 'ADOPTED'\);\s*EXCEPTION\s+WHEN duplicate_object THEN null;\s*END \$\$;/,
    );
  });

  it("adds the column IF NOT EXISTS, NOT NULL, defaulting to CANDIDATE", () => {
    expect(statements).toMatch(
      /ALTER TABLE "Camera"\s+ADD COLUMN IF NOT EXISTS "adoption" "CameraAdoption" NOT NULL DEFAULT 'CANDIDATE';/,
    );
  });

  it("backfills with ONE standalone UPDATE: enabled, or not auto-discovered, means ADOPTED", () => {
    // Standalone on purpose: camera-adoption.pg.test.ts lifts this statement out
    // of the file with a regex and re-runs it, which only works if it is the one
    // line-leading UPDATE and sits outside a DO block.
    const updates = statements.match(/^UPDATE\b[^;]*;/gm) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/^UPDATE "Camera"\s+SET "adoption" = 'ADOPTED'\s+WHERE "adoption" = 'CANDIDATE'/);
    expect(updates[0]).toMatch(/"enabled" = true OR "autoDiscovered" = false/);
    expect(updates[0]).not.toContain("$$");
    // It never demotes: ADOPTED is only ever the SET side.
    expect(statements).not.toMatch(/SET "adoption" = 'CANDIDATE'/);
  });

  it("states the rule and the idempotence argument in its header", () => {
    const header = sql
      .split("\n")
      .filter((l) => l.startsWith("--"))
      .join("\n");
    expect(header).toMatch(/enabled = false` AND `autoDiscovered = true/);
    expect(header).toMatch(/Idempotent/);
  });
});

describe("migration warp_3506_camera_name_is_frigate_key", () => {
  const sql = migrationSql(FRIGATE_KEY_SUFFIX);
  const statements = code(sql);
  const flat = squash(statements);

  it("is a single DO block, so one statement runs the whole file", () => {
    const body = statements.trim();
    expect(body.startsWith("DO $$")).toBe(true);
    expect(body.endsWith("END $$;")).toBe(true);
    // Exactly one dollar-quoted body: nothing before the opening `DO $$` and
    // nothing after the closing `END $$;`.
    expect(body.match(/\$\$/g)).toHaveLength(2);
  });

  it("computes the key the way toFrigateKey does, once", () => {
    // toFrigateKey: toLowerCase, then [^a-z0-9_] -> `_`, then strip leading and
    // trailing `_`. The two extra steps make Postgres produce the SAME string
    // for the characters where JS and Postgres count differently: a character
    // outside the BMP is two UTF-16 units in JS (so `__`), and U+0130 / U+212A
    // lower-case to ASCII in JS but per the DB locale in Postgres.
    const expression = squash(`
      trim(both '_' from
        regexp_replace(
          regexp_replace(
            lower(replace(replace("name", chr(304), 'i_'), chr(8490), 'k')),
            '[\\U00010000-\\U0010FFFF]', '__', 'g'),
          '[^a-z0-9_]', '_', 'g'))
    `);
    expect(flat).toContain(expression);
    expect(flat.split(expression)).toHaveLength(2); // exactly one occurrence
    // The headline contract, independent of the extra steps.
    expect(flat).toContain(`trim(both'_'from`);
    expect(flat).toContain(`'[^a-z0-9_]','_','g'`);
    expect(flat).toContain("lower(");
  });

  it("walks the rows ADOPTED first, then oldest first, and only the ones that are not already their key", () => {
    // An adopted camera outranks age when two names collapse to one key, as it
    // does in a discovery merge. Migration 1 (the adoption column) runs first.
    expect(flat).toContain(`WHEREk."name"<>k."canon"ORDERBY(k."adoption"='ADOPTED')DESC,k."createdAt"ASC,k."id"ASC`);
  });

  it("leaves a row alone when its key has no characters left, or another row already owns it", () => {
    expect(statements).toMatch(/IF r\.canon = '' THEN\s+RAISE WARNING[\s\S]*?CONTINUE;\s+END IF;/);
    expect(statements).toMatch(
      /SELECT o\."id" INTO owner_id\s+FROM "Camera" o\s+WHERE o\."name" = r\.canon AND o\."id" <> r\.id\s+LIMIT 1;\s+IF FOUND THEN\s+RAISE WARNING[\s\S]*?CONTINUE;\s+END IF;/,
    );
    // The collision WARNING names the row, its old name, the key and the owner.
    expect(statements).toMatch(/RAISE WARNING '[^']*camera % \(name %\)[^']*key %[^']*camera %[^']*',\s*r\.id, r\.name, r\.canon, owner_id;/);
  });

  it("reports and carries on: a WARNING for every skip (visible in the server log), and never a RAISE EXCEPTION", () => {
    // WARNING, not NOTICE: Postgres' default log_min_messages keeps NOTICEs out
    // of the server log, and `prisma migrate deploy` relays neither.
    expect(statements.match(/RAISE WARNING/g)!.length).toBe(3);
    expect(statements).not.toMatch(/RAISE\s+EXCEPTION/i);
    // A concurrent writer that claims a key mid-migration is a skip, not an abort.
    expect(statements).toMatch(/EXCEPTION\s+WHEN unique_violation THEN/);
  });

  it("renames the row and moves the denormalised CameraPin names, skipping a pin the user already has", () => {
    expect(statements).toMatch(/UPDATE "Camera" SET "name" = r\.canon WHERE "id" = r\.id;/);
    expect(statements).toMatch(
      /UPDATE "CameraPin" p\s+SET "cameraName" = r\.canon\s+WHERE p\."cameraName" = r\.name\s+AND NOT EXISTS \(\s+SELECT 1\s+FROM "CameraPin" q\s+WHERE q\."userId" = p\."userId" AND q\."cameraName" = r\.canon\s+\);/,
    );
  });

  it("deletes, drops and truncates nothing, and does not touch displayName", () => {
    expect(statements).not.toMatch(/\b(DELETE|DROP|TRUNCATE)\b/i);
    expect(statements).not.toMatch(/displayName/);
  });

  it("states the collision rule and what points at a camera by name, in its header", () => {
    const header = sql
      .split("\n")
      .filter((l) => l.startsWith("--"))
      .join("\n");
    expect(header).toMatch(/Warp_Lab_Office/);
    expect(header).toMatch(/oldest first/);
    expect(header).toMatch(/CameraPin/);
    expect(header).toMatch(/Idempotent/);
  });
});

describe("migration order", () => {
  it("each folder exists exactly once", () => {
    const folders = migrationFolders();
    expect(folders.filter((f) => f.endsWith(ADOPTION_SUFFIX))).toHaveLength(1);
    expect(folders.filter((f) => f.endsWith(FRIGATE_KEY_SUFFIX))).toHaveLength(1);
  });

  it("both sort after stage's newest folder, and the adoption folder sorts before the key folder", () => {
    // The stamps are the apply order: stage's newest, then the adoption state,
    // then the key rewrite. A box that already ran everything up to stage's
    // newest runs exactly these two, in this order.
    expect(migrationFolders()).toContain(STAGE_NEWEST);
    const adoption = folderEndingWith(ADOPTION_SUFFIX);
    const frigateKey = folderEndingWith(FRIGATE_KEY_SUFFIX);
    expect(adoption > STAGE_NEWEST).toBe(true);
    expect(frigateKey > STAGE_NEWEST).toBe(true);
    expect(adoption < frigateKey).toBe(true);
  });
});
