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

/**
 * Minimal RFC 4180-aware row parser. The IEEE registry legitimately
 * quotes vendor names containing commas (e.g. `"Cisco Systems, Inc"`)
 * and escapes embedded quotes by doubling them (`""`). We only need
 * columns 2 and 3, so a tiny hand-rolled parser beats pulling in a
 * full CSV library.
 */
function parseRow(row: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"' && row[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      cur += ch;
    } else {
      if (ch === '"' && cur.length === 0) {
        inQuotes = true;
        continue;
      }
      if (ch === ",") {
        fields.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
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
      const parts = parseRow(row);
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
