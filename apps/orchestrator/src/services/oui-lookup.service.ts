/**
 * WARP-81: IEEE OUI vendor lookup.
 *
 * Loads the bundled `data/oui.csv` snapshot once at startup into an
 * in-memory Map keyed by the 6-hex-char OUI prefix (e.g. "F81EDF"),
 * pointing at the organization name. The lookup is best-effort: if the
 * CSV is missing or malformed the service still starts — `lookup()`
 * just returns null for every call and a warning is logged.
 *
 * The CSV is expected in the IEEE raw 4-column shape:
 *   Registry,Assignment,Organization Name,Organization Address
 * (see `scripts/fetch-oui.sh`). Only columns 2 and 3 are used here.
 */

import { readFileSync, existsSync } from "node:fs";
import pino from "pino";

const log = pino({ name: "oui-lookup" });

export interface OuiLookup {
  lookup(mac: string): string | null;
}

export function createOuiLookup(csvPath: string): OuiLookup {
  const table = new Map<string, string>();

  if (!existsSync(csvPath)) {
    log.warn({ csvPath }, "oui.csv missing — vendor lookup disabled");
    return { lookup: () => null };
  }

  try {
    const content = readFileSync(csvPath, "utf8");
    const lines = content.split(/\r?\n/);
    // Skip header row (index 0); malformed or short rows are silently skipped.
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i];
      if (!row) continue;
      const parts = row.split(",");
      if (parts.length < 3) continue;
      const prefix = parts[1].trim().toUpperCase();
      const name = parts[2].trim();
      if (prefix.length === 6 && name) {
        table.set(prefix, name);
      }
    }
    log.info({ entries: table.size }, "OUI registry loaded");
  } catch (err) {
    log.warn({ err }, "oui.csv load failed — vendor lookup disabled");
  }

  return {
    lookup(mac: string): string | null {
      if (typeof mac !== "string" || mac.length === 0) return null;
      const prefix = mac.replace(/[:\-.]/g, "").slice(0, 6).toUpperCase();
      return table.get(prefix) ?? null;
    },
  };
}
