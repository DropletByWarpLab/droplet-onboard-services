/**
 * WARP-1094 — engine-version detection + catalog dialect (brief §3, §9.1;
 * corrected per EAGLESOFT-DIRECT-SQL-RESEARCH-2026-07-07 §2/§3 and review C-5).
 *
 * PURE, no I/O. The connector runs PRODUCT_VERSION_SQL at connect time and
 * feeds the result to parseEngineVersion, which decides which catalog-view
 * family to introspect with (see catalogQueriesFor in introspection.ts):
 *
 *   - SQL Anywhere 10+          → "modern" → SYS.SYSTAB / SYS.SYSTABCOL.
 *     (v10 renamed the catalog; the old SYSTABLE/SYSCOLUMN survive as compat
 *     views, but we use the current names.)
 *   - Adaptive Server Anywhere 7 → "legacy" → SYSTABLE / SYSCOLUMN only.
 *
 * The Eaglesoft ↔ engine map is version-dependent; feature-detect, never
 * presume. The prior "v16 common / v17 newer / v7 legacy" belief was WRONG —
 * SA10 is the workhorse across ES16–18. Reference map (research §2, Patterson
 * support a_id/15372):
 *
 *   dbsrv17 = SA17 → Eaglesoft 20 and above
 *   dbsrv16 = SA16 → Eaglesoft 18.10–19.10
 *   dbsrv10 = SA10 → Eaglesoft 16–18
 *   dbsrv7  = ASA7 → Eaglesoft 15 and below
 */

/** Read the running engine version. `PROPERTY('ProductVersion')` returns a
 *  dotted string like "17.0.11.6889". */
export const PRODUCT_VERSION_SQL = `SELECT PROPERTY('ProductVersion') AS product_version`;

export type CatalogDialect = "modern" | "legacy";

export interface EngineVersion {
  /** Raw PROPERTY('ProductVersion'), e.g. "17.0.11.6889". */
  raw: string;
  /** Major version integer, e.g. 17. */
  major: number;
  /** Which catalog-view family to introspect with. */
  dialect: CatalogDialect;
}

export class EngineVersionError extends Error {
  readonly code = "ENGINE_VERSION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "EngineVersionError";
  }
}

/** SQL Anywhere 10 renamed the system catalog to SYS.SYSTAB*; ASA 7 and
 *  earlier only have SYSTABLE/SYSCOLUMN. */
const MODERN_CATALOG_MIN_MAJOR = 10;

/**
 * Parse `PROPERTY('ProductVersion')` into a major version + catalog dialect.
 * Throws on an unparseable value — we never guess the catalog family, because
 * introspecting with the wrong view set fails silently on the exact legacy
 * installs it matters for (review C-5).
 */
export function parseEngineVersion(productVersion: string): EngineVersion {
  const raw = (productVersion ?? "").trim();
  const m = /^(\d+)/.exec(raw);
  if (!m) {
    throw new EngineVersionError(
      `could not parse a major version from ProductVersion "${productVersion}"`,
    );
  }
  const major = Number(m[1]);
  return {
    raw,
    major,
    dialect: major >= MODERN_CATALOG_MIN_MAJOR ? "modern" : "legacy",
  };
}

/**
 * Informational: the Eaglesoft release band for a SQL Anywhere engine major
 * (research §2). Human-readable only; not used for control flow.
 */
export function eaglesoftBandForEngine(major: number): string {
  if (major >= 17) return "Eaglesoft 20 and above";
  if (major === 16) return "Eaglesoft 18.10–19.10";
  if (major >= 10) return "Eaglesoft 16–18";
  if (major >= 7) return "Eaglesoft 15 and below";
  return "unknown / pre-ASA7";
}
