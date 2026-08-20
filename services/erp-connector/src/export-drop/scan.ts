/**
 * WARP-1964 — the scanner: read a drop directory, claim the files a vendor's
 * profiles recognise, and normalize them into one in-memory snapshot.
 *
 * Three properties this module exists to guarantee:
 *
 *  * **Nothing is read outside the drop root.** The root (and any subdirectory)
 *    is resolved through symlinks once and containment-checked. Inside the
 *    drop, symlinks are REFUSED outright rather than resolved and checked:
 *    resolving one proves only where it pointed at check time, and the read
 *    happens a whole pass later. Reads then go through a descriptor opened
 *    `O_NOFOLLOW` with the regular-file and size ceilings re-asserted on that
 *    handle, so the inode that was checked is the inode that is read.
 *  * **A file being written is never parsed.** Change notifications are not
 *    reliable over CIFS — the kernel does not see writes made by the Windows
 *    host — so this is a poll, and a poll can easily catch a half-flushed
 *    export. A file is eligible only once it has been quiet for a configured
 *    period; until then it is reported as pending, not as broken.
 *  * **Memory is bounded.** Per-file byte, per-file row, per-dataset row and
 *    per-directory file ceilings all skip with a diagnostic rather than letting
 *    a runaway export take the orchestrator down.
 *
 * Nothing here is persisted. The snapshot lives in memory for the life of the
 * connector, matching the read-through posture of the SQL and REST tracks — no
 * patient data is written to Droplet's database by this track.
 */
import { constants as fsConstants } from "node:fs";
import { open, readdir, realpath, stat, lstat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { computeSchemaFingerprint, type IntrospectedTable } from "../schema-map.js";
import { decodeExportBytes, DelimitedLimitError, parseDelimited } from "./csv.js";
import {
  CANONICAL_COLUMNS,
  COLUMN_KIND,
  matchDataset,
  normalizeHeader,
  type DatasetName,
  type ExportProfile,
} from "./profiles.js";
import { normalizeText, parseExportTimestamp, parseMoney } from "./values.js";

/** Extensions we will open. Anything else in the folder (a PDF the front desk
 *  also prints, a lock file) is ignored without comment — it is not an error
 *  for a shared folder to contain other things. */
const READABLE_EXTENSIONS = [".csv", ".tsv", ".txt"] as const;

/** Why a file present in the drop was not turned into rows. Carries file names
 *  and column headers — never cell values, which is where PHI lives. */
export interface FileDiagnostic {
  file: string;
  reason:
    | "pending"
    | "unrecognized"
    | "ambiguous"
    | "too-large"
    | "too-many-rows"
    | "unreadable"
    | "malformed-rows"
    | "symlink";
  detail?: string;
  /** Present for `unrecognized`, which is the case an operator has to act on. */
  headers?: string[];
}

/** One dataset assembled from every file that fed it. */
export interface SnapshotDataset {
  dataset: DatasetName;
  vendorLabel: string;
  /** Files that contributed, oldest first. */
  sourceFiles: string[];
  /** Union of the source headers seen, original spelling, for diagnostics. */
  sourceHeaders: string[];
  /** Newest contributing file's mtime — "as of" for this dataset. */
  generatedAt: number;
  rows: Record<string, unknown>[];
  /**
   * Appointment rows whose time cell could not be parsed. They are excluded
   * from time-window results because they cannot be placed, and counted here
   * because silently dropping an appointment is the worst failure this track
   * could have.
   */
  unplacedRows: number;
  /**
   * Rows carrying MORE fields than the header row declares — the signature of a
   * value containing an unquoted delimiter. Every column after the offending
   * one is shifted, so the row's balances and ids belong to the wrong fields.
   * Skipped rather than read, and counted, because reading a shifted row is
   * silently wrong money and skipping it silently is silently missing money.
   */
  malformedRows: number;
}

/** The full result of one scan. */
export interface Snapshot {
  scannedAt: number;
  directory: string;
  datasets: Map<DatasetName, SnapshotDataset>;
  diagnostics: FileDiagnostic[];
  /** Fingerprint over the observed header signature — see {@link snapshotTables}. */
  fingerprint: string;
}

/** Bounds and clock for a scan. All have defaults; tests inject a fixed clock. */
export interface ScanLimits {
  now: number;
  quietPeriodMs: number;
  maxFileBytes: number;
  maxRowsPerFile: number;
  maxRowsPerDataset: number;
  maxFiles: number;
}

export const DEFAULT_SCAN_LIMITS: Omit<ScanLimits, "now"> = {
  // 30s of quiet. Long enough that a report writer flushing a large CSV over
  // SMB has finished; short enough that "export it again" during a site visit
  // does not feel broken.
  quietPeriodMs: 30_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxRowsPerFile: 200_000,
  maxRowsPerDataset: 500_000,
  maxFiles: 512,
};

/** Thrown when the configured drop location cannot be used at all. The
 *  connector turns this into a `ConnectorBlockedError`. */
export class DropRootError extends Error {
  readonly code = "EXPORT_DROP_ROOT";
  constructor(message: string) {
    super(message);
    this.name = "DropRootError";
  }
}

/** True when `candidate` is `root` or sits underneath it. Both must already be
 *  fully resolved; the `sep` suffix stops `/mnt/exports-evil` matching
 *  `/mnt/exports`. */
export function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Resolve the directory a connection reads from.
 *
 * `root` is operator configuration (`ERP_EXPORT_DROP_ROOT`), never request
 * input — a caller-supplied path here would be an arbitrary-file-read
 * primitive. `subdirectory` MAY come from the connection row, so it is
 * validated: relative only, no traversal segments, and the resolved result
 * must still sit inside the resolved root even after symlinks.
 */
export async function resolveDropDirectory(
  root: string,
  subdirectory?: string,
): Promise<string> {
  if (!root || root.trim() === "") {
    throw new DropRootError("no export drop root is configured");
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(resolve(root));
  } catch {
    throw new DropRootError(`export drop root "${root}" does not exist or is not readable`);
  }
  const rootStat = await stat(resolvedRoot);
  if (!rootStat.isDirectory()) {
    throw new DropRootError(`export drop root "${root}" is not a directory`);
  }

  const sub = subdirectory?.trim();
  if (!sub) return resolvedRoot;

  if (isAbsolute(sub) || sub.split(/[\\/]/).some((part) => part === ".." || part === "")) {
    throw new DropRootError(
      `export subdirectory "${sub}" must be a plain relative path inside the drop root`,
    );
  }

  let resolvedSub: string;
  try {
    resolvedSub = await realpath(join(resolvedRoot, sub));
  } catch {
    throw new DropRootError(`export subdirectory "${sub}" does not exist under the drop root`);
  }
  if (!isInsideRoot(resolvedRoot, resolvedSub)) {
    throw new DropRootError(`export subdirectory "${sub}" resolves outside the drop root`);
  }
  const subStat = await stat(resolvedSub);
  if (!subStat.isDirectory()) {
    throw new DropRootError(`export subdirectory "${sub}" is not a directory`);
  }
  return resolvedSub;
}

/** A file that passed every gate and is ready to parse. */
interface EligibleFile {
  name: string;
  path: string;
  mtimeMs: number;
}

/** Apply the path, extension, containment, size and quiet-period gates. */
async function collectEligibleFiles(
  directory: string,
  limits: ScanLimits,
  diagnostics: FileDiagnostic[],
): Promise<EligibleFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const eligible: EligibleFile[] = [];
  let considered = 0;

  for (const entry of entries) {
    if (considered >= limits.maxFiles) {
      diagnostics.push({
        file: entry.name,
        reason: "unreadable",
        detail: `directory holds more than the ${limits.maxFiles}-file ceiling; remaining files skipped`,
      });
      break;
    }

    const lower = entry.name.toLowerCase();
    if (!READABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
    considered += 1;

    const candidate = join(directory, entry.name);

    // `lstat`, never `stat`: a symlink is REFUSED outright rather than resolved
    // and containment-checked. Resolving one would only prove where it pointed
    // at check time — the read happens a whole pass later (every earlier file
    // is read and parsed first), and the directory entry belongs to whoever
    // writes to the practice's share. Refusing outright removes the race
    // instead of narrowing it, and an export drop has no legitimate use for a
    // symlink. `readExportBytes` re-asserts this at open time with O_NOFOLLOW.
    let info;
    try {
      info = await lstat(candidate);
    } catch {
      diagnostics.push({ file: entry.name, reason: "unreadable", detail: "cannot stat" });
      continue;
    }
    if (info.isSymbolicLink()) {
      diagnostics.push({
        file: entry.name,
        reason: "symlink",
        detail: "symlinks are not read from the drop directory",
      });
      continue;
    }
    if (!info.isFile()) continue;

    if (info.size > limits.maxFileBytes) {
      diagnostics.push({
        file: entry.name,
        reason: "too-large",
        detail: `${info.size} bytes exceeds the ${limits.maxFileBytes}-byte ceiling`,
      });
      continue;
    }

    if (limits.now - info.mtimeMs < limits.quietPeriodMs) {
      diagnostics.push({
        file: entry.name,
        reason: "pending",
        detail: "written too recently; will be read once it has been quiet",
      });
      continue;
    }

    eligible.push({ name: entry.name, path: candidate, mtimeMs: info.mtimeMs });
  }

  // Oldest first, so a re-export of the same day overwrites the earlier copy
  // when rows are merged by natural key.
  eligible.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return eligible;
}

/**
 * `O_NOFOLLOW` where the platform has it. Linux and macOS do; Windows does not
 * expose it, so it degrades to 0 there. The appliance is Linux — a developer
 * checkout on Windows loses this one defence and keeps every other.
 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Read a candidate export through a file DESCRIPTOR.
 *
 * The gates in `collectEligibleFiles` prove things about a path; this proves
 * them about the inode that is actually read, which is the only version that
 * survives a concurrent writer. `O_NOFOLLOW` makes a symlink swapped in after
 * the `lstat` fail the open (ELOOP) instead of being followed, and the size and
 * regular-file checks are re-asserted on the open handle rather than trusted
 * from the earlier pass.
 *
 * Without this, the window is not instruction-level: every earlier file in the
 * directory is read and parsed between a given file's check and its read.
 */
export async function readExportBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a regular file at open time");
    if (info.size > maxBytes) {
      throw new Error(`${info.size} bytes exceeds the ${maxBytes}-byte ceiling at open time`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * The columns whose values TOGETHER identify a row for dedup across re-exports.
 *
 * Dedup exists so yesterday's and today's copies of the same report, both
 * sitting in the drop, do not double every row. It is therefore only safe to
 * key on something that genuinely identifies a document.
 *
 * ⚠ For the practice datasets one column does: `appt_id` and `patient_id` are
 * primary keys in a PMS. **For the accounting datasets they are not.**
 * QuickBooks does not enforce uniqueness on invoice or bill reference numbers,
 * and the shipped profile maps `bill_id` onto the report's `Num` column — so
 * keying on it alone silently collapses two genuinely different bills that
 * happen to share a Ref No., and the earlier one's money disappears. A payables
 * total that is quietly too small is the worst failure this file can produce.
 *
 * So an accounting key is COMPOSITE: reference number plus counterparty, date
 * and amount. Two different documents differ in at least one of those; a true
 * re-export of the same document matches on all of them.
 */
const NATURAL_KEY: Readonly<Record<DatasetName, readonly string[]>> = {
  appointment: ["appt_id"],
  patient: ["patient_id"],
  account: ["account_id"],
  // WARP-2107 — accounting. See the ⚠ above for why these are composite.
  invoice: ["invoice_id", "customer_id", "issued_at", "amount"],
  bill: ["bill_id", "vendor_id", "issued_at", "amount"],
  // `ap_summary` is already one aggregated row per vendor, so the vendor IS the
  // identity: re-exporting must replace the vendor's row, not accumulate a
  // second one and double its balance.
  ap_summary: ["vendor_id"],
};

/**
 * The timestamp column a row cannot be USED without, per dataset.
 *
 * Only `appointment` has one: the schedule read is a time-window filter, so an
 * appointment whose time will not parse cannot be placed on a day and is
 * counted as unplaced rather than silently dropped into the wrong window.
 *
 * The accounting datasets deliberately have none. A bill whose `due_at` cell is
 * blank or unparseable is still a real bill with a real balance, and every
 * accounting read here aggregates or lists by balance — refusing the row would
 * understate what the business owes, which is the more dangerous error.
 */
const PLACEMENT_COLUMN: Readonly<Partial<Record<DatasetName, string>>> = {
  appointment: "appt_time",
};

/**
 * Project one source record onto the canonical row shape.
 *
 * Iterates the dataset's FULL canonical column list rather than the profile's
 * mappings, so a column the profile does not map is present-and-undefined
 * rather than absent. Every row of a dataset therefore has the same key set —
 * which is what a `SELECT` of six columns returns when one of them is NULL, and
 * what `api-dto.projectRow` produces for a field the API omitted. A consumer
 * must not be able to tell the three tracks apart by probing for a key.
 */
function projectRow(
  dataset: DatasetName,
  columns: Readonly<Record<string, string>>,
  headerIndex: Map<string, number>,
  record: readonly string[],
): { row: Record<string, unknown>; placed: boolean } {
  const row: Record<string, unknown> = {};
  let placed = true;

  for (const canonical of CANONICAL_COLUMNS[dataset]) {
    const header = columns[canonical];
    const idx = header === undefined ? undefined : headerIndex.get(normalizeHeader(header));
    const raw = idx === undefined ? undefined : record[idx];

    // WARP-2107: the parse kind travels with the column (COLUMN_KIND) instead
    // of being a list of special-cased names here. With money and dates now on
    // four datasets, a name-branch in this file would be a second list to keep
    // in step with the column list in profiles.ts — and the failure mode of
    // them disagreeing is an amount silently read as text, which serializes as
    // "1,234.56" and makes every aggregate over it wrong.
    switch (COLUMN_KIND[canonical]) {
      case "timestamp": {
        const iso = parseExportTimestamp(raw);
        // Only a mapped-but-unparseable cell counts as unplaced. `appt_time` is
        // a required mapping, so in practice this is always the parse failing.
        if (iso === undefined && header !== undefined && canonical === PLACEMENT_COLUMN[dataset]) {
          placed = false;
        }
        row[canonical] = iso;
        break;
      }
      case "money":
        row[canonical] = parseMoney(raw);
        break;
      default:
        row[canonical] = normalizeText(raw);
        break;
    }
  }

  return { row, placed };
}

/**
 * Synthesize the introspected-table view of a snapshot.
 *
 * The tables are the datasets and the columns are the **source headers actually
 * observed**, not the canonical names. That is what makes the reused
 * `computeSchemaFingerprint` mean the same thing here as on the SQL track: a
 * vendor changing a report's columns moves the hash exactly as a database
 * upgrade does, and the connection drift-locks rather than quietly serving a
 * shape nobody has checked.
 */
export function snapshotTables(datasets: Map<DatasetName, SnapshotDataset>): IntrospectedTable[] {
  return [...datasets.values()].map((ds) => ({
    name: ds.dataset,
    owner: "export",
    columns: [...new Set(ds.sourceHeaders.map(normalizeHeader))]
      .sort()
      .map((name) => ({ name, type: "text" })),
  }));
}

/**
 * Scan a resolved drop directory and build the snapshot.
 *
 * Files that cannot be used are reported, never thrown: one malformed export
 * must not hide the three good ones next to it. The connector decides what a
 * snapshot with no usable dataset means.
 */
export async function scanDropDirectory(
  directory: string,
  profiles: readonly ExportProfile[],
  limits: ScanLimits,
): Promise<Snapshot> {
  const diagnostics: FileDiagnostic[] = [];
  const files = await collectEligibleFiles(directory, limits, diagnostics);

  // dataset -> natural key -> row, so a later file replaces an earlier row.
  const merged = new Map<DatasetName, Map<string, Record<string, unknown>>>();
  const meta = new Map<
    DatasetName,
    {
      label: string;
      files: string[];
      headers: string[];
      generatedAt: number;
      unplaced: number;
      malformed: number;
    }
  >();

  for (const file of files) {
    let text: string;
    try {
      text = decodeExportBytes(await readExportBytes(file.path, limits.maxFileBytes));
    } catch (err) {
      diagnostics.push({
        file: file.name,
        reason: "unreadable",
        detail: (err as Error).message,
      });
      continue;
    }

    let table;
    try {
      table = parseDelimited(text, { maxRows: limits.maxRowsPerFile });
    } catch (err) {
      diagnostics.push({
        file: file.name,
        reason: err instanceof DelimitedLimitError ? "too-many-rows" : "unreadable",
        detail: (err as Error).message,
      });
      continue;
    }
    if (table.headers.length === 0) {
      diagnostics.push({ file: file.name, reason: "unrecognized", headers: [] });
      continue;
    }

    const match = matchDataset(table.headers, profiles);
    if (match.kind === "unrecognized") {
      diagnostics.push({ file: file.name, reason: "unrecognized", headers: table.headers });
      continue;
    }
    if (match.kind === "ambiguous") {
      diagnostics.push({
        file: file.name,
        reason: "ambiguous",
        detail: `headers match more than one profile (${match.datasets.join(", ")})`,
        headers: table.headers,
      });
      continue;
    }

    const { profile, dataset } = match.candidate;
    const headerIndex = new Map<string, number>();
    table.headers.forEach((h, i) => {
      const key = normalizeHeader(h);
      // First occurrence wins: a duplicated column in an export is a report
      // quirk, and silently taking the last one would change which column is
      // read depending on where the duplicate sits.
      if (!headerIndex.has(key)) headerIndex.set(key, i);
    });

    let bucket = merged.get(dataset.dataset);
    if (!bucket) {
      bucket = new Map();
      merged.set(dataset.dataset, bucket);
    }
    let info = meta.get(dataset.dataset);
    if (!info) {
      info = {
        label: profile.label,
        files: [],
        headers: [],
        generatedAt: 0,
        unplaced: 0,
        malformed: 0,
      };
      meta.set(dataset.dataset, info);
    }
    info.files.push(file.name);
    info.headers.push(...table.headers);
    info.generatedAt = Math.max(info.generatedAt, file.mtimeMs);

    const malformedBefore = info.malformed;
    let truncated = false;
    for (const [index, record] of table.rows.entries()) {
      if (bucket.size >= limits.maxRowsPerDataset) {
        truncated = true;
        break;
      }
      // A row with MORE fields than there are headers means a value contained
      // an unquoted delimiter, so every column past it is shifted. Reading it
      // would attribute one account's balance to another — the kind of wrong
      // that looks like data. A SHORT row is fine and stays supported: trailing
      // empty columns are legitimately omitted by plenty of report writers.
      if (record.length > table.headers.length) {
        info.malformed += 1;
        continue;
      }
      const { row, placed } = projectRow(dataset.dataset, dataset.columns, headerIndex, record);
      if (!placed) info.unplaced += 1;

      // Fall back to a per-row key when ANY part of the natural key is absent.
      // A PMS that only assigns an appointment id at check-in exports walk-ins
      // with the id cell blank; keying those on one shared value would collapse
      // them into a single row and silently drop the rest. `normalizeText`
      // yields undefined for a blank cell (never ""), so this covers both "the
      // profile maps no id column" and "the id cell is empty".
      //
      // Requiring EVERY part is deliberate: a partial composite would key two
      // different documents together precisely when the distinguishing column
      // is the missing one. Falling back duplicates a row; collapsing loses it.
      const parts: string[] = [];
      for (const column of NATURAL_KEY[dataset.dataset]) {
        const value = row[column];
        // Numbers count: `amount` is parsed money, not text, and it is one of
        // the columns that tells two same-numbered bills apart.
        if (typeof value === "string") parts.push(value);
        else if (typeof value === "number") parts.push(String(value));
        else {
          parts.length = 0;
          break;
        }
      }
      // A NUL cannot appear in a parsed cell, so no combination of values can
      // forge another row's key by containing the separator.
      const key = parts.length > 0 ? `k:${parts.join(" ")}` : `f:${file.name}#${index}`;
      bucket.set(key, row);
    }
    if (malformedBefore !== info.malformed) {
      diagnostics.push({
        file: file.name,
        reason: "malformed-rows",
        detail:
          `${info.malformed - malformedBefore} row(s) carried more fields than the header ` +
          `declares (an unquoted delimiter in a value) and were skipped rather than read shifted`,
      });
    }
    if (truncated) {
      diagnostics.push({
        file: file.name,
        reason: "too-many-rows",
        detail: `dataset "${dataset.dataset}" reached the ${limits.maxRowsPerDataset}-row ceiling; later rows skipped`,
      });
    }
  }

  const datasets = new Map<DatasetName, SnapshotDataset>();
  for (const [name, bucket] of merged) {
    const info = meta.get(name);
    if (!info) continue;
    datasets.set(name, {
      dataset: name,
      vendorLabel: info.label,
      sourceFiles: info.files,
      sourceHeaders: [...new Set(info.headers)],
      generatedAt: info.generatedAt,
      rows: [...bucket.values()],
      unplacedRows: info.unplaced,
      malformedRows: info.malformed,
    });
  }

  return {
    scannedAt: limits.now,
    directory,
    datasets,
    diagnostics,
    fingerprint: computeSchemaFingerprint(snapshotTables(datasets)),
  };
}
