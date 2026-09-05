/**
 * WARP-2731 (ADR-048) — the assumption that lets two languages write one table.
 *
 * `FileIndexStatus` is owned by `services/file-indexer/db.py`. Filing writes
 * five columns on it from TypeScript — `extractStatus`, `extractClaimedAt`,
 * `extractAttempts`, `extractReason`, `extractedAt`, plus the watermark and
 * fingerprint. That is only safe because `set_index_status` names its columns
 * explicitly in BOTH the INSERT list and the `ON CONFLICT … DO UPDATE SET`
 * arm, and none of the names it writes is one of ours.
 *
 * 🔴 THAT IS AN ASSUMPTION ABOUT A FILE IN ANOTHER LANGUAGE, IN ANOTHER IMAGE,
 * ON ANOTHER RELEASE CADENCE. Nothing about the two repositories' build makes
 * it hold. If somebody adds `"extractStatus" = 'pending'` to that DO UPDATE
 * arm — an entirely reasonable-looking way to "re-arm indexing" — then every
 * metadata-only touch resets a claim mid-extraction, the whole corpus re-reads
 * on the next `chown -R`, and the first symptom is a model-hours bill and a
 * duplicate-proposal pile. Nothing would go red.
 *
 * So the assumption is a TEST. This file reads the Python source and asserts
 * the shape it depends on. It is a grep, and a grep is a weak instrument — but
 * a weak instrument aimed at the exact statement is worth more here than a
 * strong one aimed at nothing, because the alternative is a comment.
 *
 * MUTATIONS THIS CATCHES:
 *   - add any `extract*` column to `set_index_status`'s INSERT or UPDATE
 *   - replace the explicit column list with `SELECT *`-style interpolation
 *   - delete `updatedAt = NOW()` from the conflict arm (the re-arm signal)
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DB_PY = join(process.cwd(), "..", "..", "services", "file-indexer", "db.py");

/** The columns filing owns. Listed here rather than derived so that adding one
 *  without extending this guard is a visible omission in the diff. */
const ORCHESTRATOR_OWNED = [
  "extractStatus",
  "extractClaimedAt",
  "extractAttempts",
  "extractReason",
  "extractedAt",
  "extractedFromUpdatedAt",
  "extractFingerprint",
] as const;

/** The body of `set_index_status`, from its `def` to the next top-level `def`. */
function setIndexStatusSource(): string {
  const src = readFileSync(DB_PY, "utf8");
  const start = src.indexOf("def set_index_status(");
  expect(start, "set_index_status has been renamed or removed").toBeGreaterThan(-1);
  const after = src.indexOf("\ndef ", start + 1);
  return after === -1 ? src.slice(start) : src.slice(start, after);
}

describe("🔴 the file-indexer is not a second writer to filing's columns", () => {
  it("finds db.py where it expects to — the guard cannot pass vacuously", () => {
    // Without this the whole file would go green the day the service moves,
    // which is the same class of bug as a mutation run that reports success
    // unconditionally.
    expect(existsSync(DB_PY), `db.py not found at ${DB_PY}`).toBe(true);
    const body = setIndexStatusSource();
    expect(body.length).toBeGreaterThan(200);
    // 🔴 The vacuity check. The assertions below are all `includes(...) ===
    // false`, which passes for free against an empty string, the wrong slice
    // of the file, or a renamed function. So prove the grep can SEE a column
    // that really is written there — `extractorCapability` is in the same
    // INSERT and the same DO UPDATE arm the guard is reading.
    expect(body).toContain("extractorCapability");
  });

  it("MUTATION: add an extract* column to set_index_status — a touch resets a live claim", () => {
    const body = setIndexStatusSource();
    for (const column of ORCHESTRATOR_OWNED) {
      expect(body.includes(column), `db.py set_index_status writes "${column}"`).toBe(false);
    }
  });

  it("still names its columns explicitly, in both arms", () => {
    // The safety comes from the explicit list. An interpolated column set, or
    // a `DO UPDATE SET` built from a dict, would make the assertion above
    // true today and meaningless tomorrow.
    const body = setIndexStatusSource();
    expect(body).toMatch(/INSERT INTO "FileIndexStatus"/);
    expect(body).toMatch(/ON CONFLICT \("userId", "path"\)/);
    expect(body).toMatch(/DO UPDATE SET/);
    // Every assignment in the conflict arm is a literal `"col" = ...` pair.
    const arm = body.slice(body.indexOf("DO UPDATE SET"));
    const assignments = arm.match(/"[A-Za-z]+"\s*=/g) ?? [];
    expect(assignments.length).toBeGreaterThanOrEqual(4);
  });

  it("MUTATION: drop `updatedAt = NOW()` — nothing ever re-arms", () => {
    // The other half of the contract, and the one filing depends on to notice
    // a changed file at all: `extractedFromUpdatedAt < updatedAt` is the
    // entire re-index signal, computed orchestrator-side precisely so no
    // Python change is needed. Remove this and filing reads every document
    // exactly once, forever, with no error anywhere.
    expect(setIndexStatusSource()).toMatch(/"updatedAt"\s*=\s*NOW\(\)/);
  });

  it("the delete path removes the row rather than blanking it", () => {
    // Filing's purge arm (WARP-2731) keys on the ABSENCE of a
    // `FileIndexStatus` row to decide a proposal has outlived its source. A
    // Python change to soft-delete instead would leave every proposal alive
    // forever, holding names and amounts for a file that is gone.
    const src = readFileSync(DB_PY, "utf8");
    const start = src.indexOf("def delete_index_status(");
    expect(start, "delete_index_status has been renamed or removed").toBeGreaterThan(-1);
    const after = src.indexOf("\ndef ", start + 1);
    const body = after === -1 ? src.slice(start) : src.slice(start, after);
    expect(body).toMatch(/DELETE FROM "FileIndexStatus"/);
  });
});
