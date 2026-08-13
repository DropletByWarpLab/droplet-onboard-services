/**
 * WARP-1964 — `ExportDropConnector`: the THIRD ERP transport.
 *
 * Reads the report files a practice exports from its own practice-management
 * system, from a read-only share on the practice LAN, and serves the same named
 * reads as the other two tracks. Implements the same `Connector` interface,
 * validates against the same read/write registries, and throws the same
 * `ConnectorBlockedError`, so the orchestrator, the error taxonomy and the
 * dashboard read contract are unchanged.
 *
 * ## Why a third track
 *
 * The direct-SQL track is gated on Patterson's EULA §5(a) treatment of
 * direct-database connections (WARP-1294 records the official API as the
 * sanctioned replacement), and on SAP's licence-governed, account-walled client
 * that an operator must vendor per deployment. The REST track needs vendor
 * enrolment and a route contract discovered from a live box. Both are the right
 * long-term answers and neither unblocks on our schedule.
 *
 * An export drop needs neither, and its posture is different in kind: it never
 * opens a connection to the practice's database. It reads files the practice
 * produced and owns, from a share the practice controls.
 *
 * (The SQL sidecar is also x86_64-only, since SAP ships no aarch64 client —
 * true, documented, and not a factor on the x86 shape that ships today.)
 *
 * ## What this track is, precisely
 *
 * A one-way copy. That single fact gives it two properties the other tracks
 * have to work for:
 *
 *  * **Writes are impossible, permanently.** `applyWrite` performs the same
 *    registry and forbidden-target validation as the other tracks — so a
 *    caller's bug surfaces identically — and then always throws. This is not a
 *    deferred slice like the REST track's write path; there is no channel back
 *    through a file someone exported. Enabling writes for a practice means
 *    connecting the SQL or REST track, and the remediation text says so.
 *  * **No patient data is persisted.** The snapshot is in memory for the life
 *    of the connector. `ErpEntityCache` exists in the schema but has no
 *    application code behind it and its "PHI is encrypted at rest" docstring is
 *    unimplemented; this track deliberately does not become that model's first
 *    writer.
 *
 * ## Running in-process
 *
 * Unlike the SQL track there is no sidecar. The sidecar exists because a native
 * ODBC driver cannot live in the orchestrator image, not as a general rule —
 * the REST track already runs in-process for the same reason. Reading a
 * delimited file needs no driver, so a sidecar here would add a network hop and
 * a container to guard nothing.
 */
import {
  ConnectorBlockedError,
  type Connector,
  type IntrospectionResult,
} from "../connector.js";
import { getReadQuery } from "../read-queries.js";
import { assertTargetAllowed, getWriteCommand } from "../write-commands.js";
import { sortByKey } from "../api-dto.js";
import {
  GENERIC_VENDOR,
  knownVendors,
  profilesForVendor,
  type DatasetName,
  type ExportProfile,
} from "./profiles.js";
import {
  DEFAULT_SCAN_LIMITS,
  DropRootError,
  resolveDropDirectory,
  scanDropDirectory,
  snapshotTables,
  type FileDiagnostic,
  type ScanLimits,
  type Snapshot,
} from "./scan.js";

/** Suffix that marks a provider key as belonging to this track. */
export const EXPORT_PROVIDER_SUFFIX = "-export";

/**
 * What the export-drop track is waiting on — the counterpart to
 * `SQL_TRACK_REMEDIATION` and `API_TRACK_REMEDIATION`. Kept deliberately
 * different from both: an installer triaging this track must not be sent
 * looking for a SAP client or a Patterson enrolment, neither of which has any
 * bearing on whether a folder has files in it.
 */
export const EXPORT_DROP_TRACK_REMEDIATION =
  "needs ERP_EXPORT_DROP_ROOT pointing at a readable export folder on the practice " +
  "LAN, and at least one exported report whose column headers match a profile for " +
  "this vendor (an operator profile can map any product — see docs/integrations/export-drop.md)";

/** Provider key for a vendor on this track, e.g. `eaglesoft-export`. */
export function exportProviderFor(vendor: string): string {
  return `${vendor}${EXPORT_PROVIDER_SUFFIX}`;
}

/** The vendor a provider key names, or `null` when it is not an export-drop key. */
export function vendorFromExportProvider(provider: string): string | null {
  if (!provider.endsWith(EXPORT_PROVIDER_SUFFIX)) return null;
  const vendor = provider.slice(0, -EXPORT_PROVIDER_SUFFIX.length);
  return vendor === "" ? null : vendor;
}

/** Every provider key this track serves, for provider validation at connect. */
export function exportProviders(extra: readonly ExportProfile[] = []): string[] {
  return knownVendors(extra).map(exportProviderFor);
}

/**
 * Connection config. Note what is NOT here: a filesystem path from the caller.
 * The root is operator configuration; accepting one over HTTP would hand any
 * connection-editing caller an arbitrary-file read inside the orchestrator.
 */
export interface ExportDropConfig {
  /** Vendor key — the built-in profile set to match against. */
  vendor: string;
  /** Operator-configured drop root (`ERP_EXPORT_DROP_ROOT`). */
  root: string;
  /** Optional per-practice subdirectory inside the root. Validated for containment. */
  subdirectory?: string;
  /**
   * How old the newest export may be before the data is reported stale.
   * Defaults to 26 hours: the expected cadence is a once-a-day export, so a
   * 24-hour threshold would flap into "stale" every morning shortly before the
   * front desk runs it. Staleness is reported, never used to hide data.
   */
  staleAfterMinutes?: number;
}

export interface ExportDropDeps {
  /** Injectable clock; tests pin it so the quiet-period gate is deterministic. */
  now?: () => number;
  /** Operator-supplied profiles (see `parseProfileJson`). */
  profiles?: readonly ExportProfile[];
  /** Override scan bounds. */
  limits?: Partial<Omit<ScanLimits, "now">>;
  /**
   * Floor between automatic rescans triggered by a read.
   *
   * Note what this does NOT do in the current wiring: `erp.service.ts` builds,
   * connects and closes a connector per read call (see its "one handshake per
   * read" comment), so each read already gets a fresh scan and this floor never
   * engages. It matters only for a caller that HOLDS a connector across reads —
   * a scheduled refresh, which is a follow-up. Documented rather than removed
   * so the number is not mistaken for a cache that is doing work.
   */
  minRefreshMs?: number;
  /**
   * A configuration problem the caller found while assembling `profiles` — a
   * malformed operator-profile file, typically. Reported ahead of everything
   * else, so a JSON typo says so instead of surfacing as the misleading "no
   * profile is registered for this vendor".
   */
  configError?: string;
}

/** Per-dataset freshness, for the caller's "as of" label. */
export interface DatasetStatus {
  dataset: DatasetName;
  sourceFiles: string[];
  generatedAt: string;
  ageMinutes: number;
  rowCount: number;
  unplacedRows: number;
  /** Rows skipped because they carried more fields than the header declares —
   *  an unquoted delimiter in a value, which shifts every later column. */
  malformedRows: number;
}

/** The connector's own status view — richer than `health()`'s `{ok}`. */
export interface ExportDropStatus {
  ok: boolean;
  stale: boolean;
  directory: string | null;
  scannedAt: string | null;
  fingerprint: string | null;
  datasets: DatasetStatus[];
  diagnostics: FileDiagnostic[];
  /** True when every profile in force is a built-in that nobody has confirmed
   *  against a real export from this product. */
  usingUnverifiedProfiles: boolean;
}

const DEFAULT_STALE_AFTER_MINUTES = 26 * 60;
const DEFAULT_MIN_REFRESH_MS = 60_000;

export class ExportDropConnector implements Connector {
  readonly provider: string;

  private readonly profiles: ExportProfile[];
  private readonly now: () => number;
  private readonly limits: Omit<ScanLimits, "now">;
  private readonly minRefreshMs: number;
  private readonly staleAfterMs: number;
  private readonly configError?: string;

  private directory: string | null = null;
  private snapshot: Snapshot | null = null;

  constructor(
    private readonly config: ExportDropConfig,
    deps: ExportDropDeps = {},
  ) {
    this.provider = exportProviderFor(config.vendor);
    this.profiles = profilesForVendor(config.vendor, deps.profiles ?? []);
    this.now = deps.now ?? (() => Date.now());
    this.limits = { ...DEFAULT_SCAN_LIMITS, ...deps.limits };
    this.minRefreshMs = deps.minRefreshMs ?? DEFAULT_MIN_REFRESH_MS;
    this.staleAfterMs =
      (config.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES) * 60_000;
    this.configError = deps.configError;
  }

  /** Wrap a scan-layer failure in the shared blocked-error contract. */
  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(
      detail ? `${op} (${detail})` : op,
      EXPORT_DROP_TRACK_REMEDIATION,
    );
  }

  /**
   * Rescan the drop directory. Public so a scheduler can drive it; also called
   * by `connect` and, subject to `minRefreshMs`, by reads. Idempotent.
   *
   * Cost is one pass over the drop directory: stat every candidate, then read
   * and parse the ones that are eligible. Bounded by the scan limits, so the
   * worst case is `maxFiles` files of `maxFileBytes` each. With the orchestrator
   * building a connector per read, that pass happens once per read — the same
   * shape as the other two tracks paying a handshake per read, and the same
   * answer if it ever shows up under load: hold the connector, don't cache
   * outside it.
   */
  async refresh(): Promise<Snapshot> {
    let dir = this.directory;
    if (!dir) {
      try {
        dir = await resolveDropDirectory(this.config.root, this.config.subdirectory);
      } catch (err) {
        this.snapshot = null;
        throw err instanceof DropRootError
          ? this.blocked("refresh", err.message)
          : this.blocked("refresh", (err as Error).message);
      }
      this.directory = dir;
    }

    try {
      this.snapshot = await scanDropDirectory(dir, this.profiles, {
        ...this.limits,
        now: this.now(),
      });
      return this.snapshot;
    } catch (err) {
      // The directory went away between resolve and read (share unmounted).
      this.directory = null;
      this.snapshot = null;
      throw this.blocked("refresh", (err as Error).message);
    }
  }

  /** The current snapshot, rescanning first if it has aged past the floor. */
  private async currentSnapshot(op: string): Promise<Snapshot> {
    // Held in a local because `refresh()` clears `this.snapshot` when a rescan
    // fails. Reading the field again in the catch below would hand back null
    // typed as a Snapshot — the narrowing above does not survive the call.
    const held = this.snapshot;
    if (!held) throw this.blocked(op, "connect required first");
    if (this.now() - held.scannedAt >= this.minRefreshMs) {
      try {
        return await this.refresh();
      } catch {
        // A failed rescan must not throw away data we already hold — the share
        // blipping should degrade to "serving the last good snapshot", which
        // `status()` reports honestly, not to an empty schedule.
        this.snapshot = held;
        return held;
      }
    }
    return held;
  }

  async connect(): Promise<void> {
    if (this.configError) throw this.blocked("connect", this.configError);
    if (this.profiles.length === 0) {
      const hint =
        this.config.vendor === GENERIC_VENDOR
          ? `vendor "${GENERIC_VENDOR}" has no built-in profiles — supply one via ERP_EXPORT_DROP_PROFILES`
          : `no profile is registered for vendor "${this.config.vendor}"`;
      throw this.blocked("connect", hint);
    }

    const snapshot = await this.refresh();
    if (snapshot.datasets.size === 0) {
      // The single most useful error an installer can get on a first visit:
      // name the files that were there and the headers they had, so the right
      // profile can be written in minutes. Headers are column names, never cell
      // values — no PHI crosses into this message.
      const unrecognized = snapshot.diagnostics.filter((d) => d.reason === "unrecognized");
      const pending = snapshot.diagnostics.filter((d) => d.reason === "pending");
      let detail = `no exported report in ${snapshot.directory} matched a "${this.config.vendor}" profile`;
      if (unrecognized.length > 0) {
        const sample = unrecognized
          .slice(0, 3)
          .map((d) => `${d.file} [${(d.headers ?? []).join(" | ")}]`)
          .join("; ");
        detail += `; saw ${sample}`;
      } else if (pending.length > 0) {
        detail += `; ${pending.length} file(s) still being written`;
      }
      this.snapshot = null;
      throw this.blocked("connect", detail);
    }
  }

  async close(): Promise<void> {
    this.directory = null;
    this.snapshot = null;
  }

  /**
   * Transport health. `ok` means "the drop is readable and holds at least one
   * dataset we can serve" — it deliberately does NOT go false on stale data.
   * A 30-hour-old export is old, not broken, and collapsing those two facts
   * would either hide the age or throw away readable data. `status()` reports
   * the age; the caller labels it.
   */
  async health(): Promise<{ ok: boolean; stale: boolean }> {
    const snapshot = await this.currentSnapshot("health");
    const status = this.statusFor(snapshot);
    return { ok: status.ok, stale: status.stale };
  }

  async introspect(): Promise<IntrospectionResult> {
    const snapshot = await this.currentSnapshot("introspect");
    return {
      tables: snapshotTables(snapshot.datasets),
      fingerprint: snapshot.fingerprint,
    };
  }

  /** Rich status for the caller — freshness, diagnostics, profile provenance. */
  async status(): Promise<ExportDropStatus> {
    if (!this.snapshot) {
      return {
        ok: false,
        stale: true,
        directory: this.directory,
        scannedAt: null,
        fingerprint: null,
        datasets: [],
        diagnostics: [],
        usingUnverifiedProfiles: this.profiles.every((p) => !p.verified),
      };
    }
    return this.statusFor(await this.currentSnapshot("status"));
  }

  private statusFor(snapshot: Snapshot): ExportDropStatus {
    const now = this.now();
    const datasets: DatasetStatus[] = [...snapshot.datasets.values()].map((ds) => ({
      dataset: ds.dataset,
      sourceFiles: ds.sourceFiles,
      generatedAt: new Date(ds.generatedAt).toISOString(),
      ageMinutes: Math.max(0, Math.round((now - ds.generatedAt) / 60_000)),
      rowCount: ds.rows.length,
      unplacedRows: ds.unplacedRows,
      malformedRows: ds.malformedRows,
    }));
    const newest = datasets.reduce(
      (min, d) => Math.min(min, d.ageMinutes),
      Number.POSITIVE_INFINITY,
    );
    return {
      ok: snapshot.datasets.size > 0,
      stale: datasets.length === 0 || newest * 60_000 > this.staleAfterMs,
      directory: snapshot.directory,
      scannedAt: new Date(snapshot.scannedAt).toISOString(),
      fingerprint: snapshot.fingerprint,
      datasets,
      diagnostics: snapshot.diagnostics,
      usingUnverifiedProfiles: this.profiles.every((p) => !p.verified),
    };
  }

  /** Rows for a dataset, or a blocked error naming the report that is missing. */
  private rowsFor(snapshot: Snapshot, dataset: DatasetName, op: string): Record<string, unknown>[] {
    const ds = snapshot.datasets.get(dataset);
    if (!ds) {
      // Deliberately not an empty array: "the practice does not export that
      // report" and "there are no matching records" are different answers, and
      // returning [] would state the second when the first is true.
      throw this.blocked(op, `no "${dataset}" dataset in the export drop`);
    }
    return ds.rows;
  }

  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    // Validate the query name against the shared registry FIRST, so an unknown
    // name is an UnknownReadQueryError regardless of connection state — the
    // same ordering both other tracks use.
    getReadQuery(name);
    const snapshot = await this.currentSnapshot(`runRead:${name}`);
    const op = `runRead:${name}`;

    switch (name) {
      case "get_schedule_today": {
        const from = String(params.from ?? "");
        const to = String(params.to ?? "");
        const rows = this.rowsFor(snapshot, "appointment", op).filter((row) => {
          const t = row.appt_time;
          return typeof t === "string" && t >= from && t < to;
        });
        return sortByKey(rows, "appt_time");
      }

      case "find_patient": {
        // A LITERAL prefix match. `escapeLike` exists on the SQL track so a
        // search term of "%" cannot turn a name lookup into a full-table scan
        // (a PHI minimum-necessary violation); the file domain gets the same
        // property by never treating the term as a pattern at all.
        const term = String(params.query ?? "").trim().toLowerCase();
        const rows = this.rowsFor(snapshot, "patient", op).filter((row) => {
          const last = row.last_name;
          return typeof last === "string" && last.toLowerCase().startsWith(term);
        });
        return sortByKey(sortByKey(rows, "first_name"), "last_name");
      }

      case "get_patient": {
        const id = String(params.patientId ?? "");
        return this.rowsFor(snapshot, "patient", op).filter((row) => row.patient_id === id);
      }

      case "get_recall_due": {
        const rows = this.rowsFor(snapshot, "patient", op);
        return sortByKey(sortByKey(rows, "first_name"), "last_name");
      }

      case "get_ar_summary": {
        const rows = this.rowsFor(snapshot, "account", op);
        // Reproduces the SQL aggregate — and `api-dto.aggregateArSummary`'s
        // client-side equivalent — exactly: COUNT over rows, SUM over the
        // finite balances, and never the raw ledger rows.
        let total = 0;
        for (const row of rows) {
          const n = Number(row.balance);
          if (Number.isFinite(n)) total += n;
        }
        return [{ account_count: rows.length, total_balance: total }];
      }

      default:
        // Unreachable while every registered read is handled above; a new
        // registry entry lands here rather than silently returning nothing.
        throw this.blocked(op, "read is not served by the export-drop track");
    }
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Same validation order as both other tracks, so a caller bug produces the
    // same typed error here as anywhere else...
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // ...and then this track always refuses. An export is a one-way copy of
    // what the practice printed; there is nothing to write back through. This
    // is a property of the transport, not a slice we have yet to build.
    throw this.blocked(
      `applyWrite:${name}`,
      "the export-drop track is read-only by construction — writes need the direct-SQL or REST track",
    );
  }
}
