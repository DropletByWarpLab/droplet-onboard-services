/**
 * WARP-2730 (ADR-048) — the one settings row, and the scope it defines.
 *
 * `AutoFilingSetting` is a singleton by primary key (`id = "singleton"`), the
 * same shape the box uses elsewhere for "there is exactly one of these". A
 * MISSING row means filing has never been enabled, and this module returns the
 * off-defaults rather than creating one: a settings row that appears because
 * something read it is a consent record nobody gave.
 *
 * 🔴 SCOPE. Two allow-lists come out of here and both fail CLOSED:
 *
 *   permittedOwnerIds  whose indexed content the worker may read. The enabling
 *                      owner's Nextcloud username plus `__household__`, and
 *                      nothing else — departments wait for WARP-2026. Empty
 *                      when there is no enabling owner, which reads nothing.
 *   folders            which paths are in scope at all. When the owner has set
 *                      one, a file outside it is `not_needed/out_of_scope` and
 *                      is never read. This is the real blast-radius control on
 *                      a practice box (decision D2) — the PHI screen is the
 *                      backstop, the folder list is the fence.
 */
import type { PrismaClient, AutoFilingSetting } from "@prisma/client";

import { DEFAULT_PATH_DENYLIST } from "./phi-screen.js";

/** The legacy shared index owner. Mirrors `HOUSEHOLD_INDEX_USER` in
 *  `routes/files.ts`; kept as its own constant rather than imported so a
 *  service does not depend on a route module. */
export const HOUSEHOLD_INDEX_USER = "__household__";

export const SETTING_ID = "singleton";

export interface ResolvedFilingSettings {
  mode: AutoFilingSetting["mode"];
  level: AutoFilingSetting["level"];
  vertical: AutoFilingSetting["vertical"];
  enabledById: string | null;
  enabledAt: Date | null;
  /** Path prefixes in scope. Empty = everything the owner can see. */
  folders: string[];
  pathDenylist: string[];
  hourlyApplyCap: number;
  dailyCreateCap: number;
}

const OFF_DEFAULTS: ResolvedFilingSettings = {
  mode: "off",
  level: "links_only",
  vertical: "general",
  enabledById: null,
  enabledAt: null,
  folders: [],
  pathDenylist: [...DEFAULT_PATH_DENYLIST],
  hourlyApplyCap: 0,
  dailyCreateCap: 0,
};

/** A `Json` column holding a list of strings, read defensively: it is a Json
 *  column and therefore can hold anything, including what an older version of
 *  this code wrote. A malformed value is treated as absent, never as a crash
 *  and never as a wildcard. */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return out.length > 0 ? out.map((s) => s.trim()) : null;
}

export async function readFilingSettings(
  prisma: PrismaClient,
): Promise<ResolvedFilingSettings> {
  const row = await prisma.autoFilingSetting.findUnique({ where: { id: SETTING_ID } });
  if (!row) return { ...OFF_DEFAULTS };

  return {
    mode: row.mode,
    level: row.level,
    vertical: row.vertical,
    enabledById: row.enabledById,
    enabledAt: row.enabledAt,
    folders: stringList(row.folders) ?? [],
    // An owner who empties the denylist gets the DEFAULTS back, not nothing.
    // "I cleared the box" must not silently mean "look in Patients/".
    pathDenylist: stringList(row.pathDenylist) ?? [...DEFAULT_PATH_DENYLIST],
    hourlyApplyCap: row.hourlyApplyCap,
    dailyCreateCap: row.dailyCreateCap,
  };
}

/**
 * Whose indexed content the worker may read.
 *
 * Returns an EMPTY array when filing has no enabling owner or that owner is
 * gone — and `readFileContent` reads nothing for an empty array. The tempting
 * alternative, "no restriction when we cannot work one out", is how a scope
 * check becomes a comment.
 */
export async function permittedOwnerIds(
  prisma: PrismaClient,
  settings: ResolvedFilingSettings,
): Promise<string[]> {
  if (!settings.enabledById) return [];
  const user = await prisma.user.findUnique({
    where: { id: settings.enabledById },
    select: { username: true },
  });
  if (!user?.username) return [];
  return [user.username, HOUSEHOLD_INDEX_USER];
}

/**
 * Is this path in scope?
 *
 * Prefix match on a folder boundary, so `/Customers` covers
 * `/Customers/acme.pdf` but never `/CustomersOld/…`. No folder list means
 * everything the owner can see, which is the default a general-business box
 * gets and the setting a practice box is told to narrow.
 */
export function isInScope(storedPath: string, folders: readonly string[]): boolean {
  if (folders.length === 0) return true;
  const p = storedPath.toLowerCase();
  return folders.some((f) => {
    const prefix = f.toLowerCase().replace(/\/+$/, "");
    return prefix.length === 0 || p === prefix || p.startsWith(`${prefix}/`);
  });
}
