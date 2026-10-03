/**
 * WARP-3504 (ADR-068) — the bounded on-disk buffer behind the telemetry
 * sender, plus the two things the owner's page needs to survive a restart:
 * the last payload of each kind that the portal accepted, and the running
 * send counters the daily ActivityRow summarises.
 *
 * ONE file (`state.json`, mode 0600, written by rename so a power cut never
 * leaves half a file). What it holds is only what already passed the strict
 * schemas: built `*.v1` JSON bodies waiting for the portal, and the last
 * accepted ones. Never a token, never a raw log line.
 *
 * Bounds: at most {@link SPOOL_MAX_ENTRIES} waiting bodies and
 * {@link SPOOL_MAX_BYTES} of them. Over either, the OLDEST are dropped first
 * and counted, so an outage costs history, never the box. A directory that
 * cannot be written degrades to memory only (one warning), never to an error
 * in the sender.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { TELEMETRY_KINDS, type TelemetryKind } from "./contract.js";

export const SPOOL_MAX_ENTRIES = 600;
export const SPOOL_MAX_BYTES = 8 * 1024 * 1024;

export interface SpoolEntry {
  kind: TelemetryKind;
  /** The validated JSON body, exactly as it will be POSTed. */
  body: string;
  queuedAt: number;
}

export interface SentRow {
  at: string;
  body: string;
}

export interface TelemetryStats {
  since: string;
  heartbeats: number;
  events: number;
  logRecords: number;
  bytes: number;
  /** token.refused episodes: HQ would not issue a token. */
  refused: number;
  /** Bodies the portal answered 4xx (dropped, never retried). */
  rejected: number;
  /** Bodies dropped from a full buffer. */
  dropped: number;
}

interface Persisted {
  v: 1;
  spool: SpoolEntry[];
  lastSent: Partial<Record<TelemetryKind, SentRow>>;
  stats: TelemetryStats;
}

const emptyStats = (now: number): TelemetryStats => ({
  since: new Date(now).toISOString(),
  heartbeats: 0,
  events: 0,
  logRecords: 0,
  bytes: 0,
  refused: 0,
  rejected: 0,
  dropped: 0,
});

const isKind = (k: unknown): k is TelemetryKind => (TELEMETRY_KINDS as readonly unknown[]).includes(k);

export class TelemetryStore {
  private spool: SpoolEntry[] = [];
  private lastSent: Partial<Record<TelemetryKind, SentRow>> = {};
  private stats: TelemetryStats;
  private dirty = false;
  private bytes = 0;
  private warned = false;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
    private readonly warn: (msg: string) => void = () => undefined,
  ) {
    this.stats = emptyStats(now());
  }

  /** Read the file if there is one. A missing or damaged file is an empty store. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return;
    }
    try {
      const p = JSON.parse(raw) as Partial<Persisted>;
      this.spool = (Array.isArray(p.spool) ? p.spool : []).filter(
        (e) => isKind(e?.kind) && typeof e.body === "string" && typeof e.queuedAt === "number",
      );
      this.bytes = this.spool.reduce((n, e) => n + e.body.length, 0);
      for (const k of TELEMETRY_KINDS) {
        const row = p.lastSent?.[k];
        if (row && typeof row.at === "string" && typeof row.body === "string") this.lastSent[k] = row;
      }
      if (p.stats && typeof p.stats.since === "string") this.stats = { ...emptyStats(this.now()), ...p.stats };
    } catch {
      this.warn("telemetry state file is damaged; starting empty");
    }
  }

  enqueue(kind: TelemetryKind, body: string): void {
    this.spool.push({ kind, body, queuedAt: this.now() });
    this.bytes += body.length;
    while (this.spool.length > SPOOL_MAX_ENTRIES || this.bytes > SPOOL_MAX_BYTES) {
      const gone = this.spool.shift();
      if (!gone) break;
      this.bytes -= gone.body.length;
      this.stats.dropped += 1;
    }
    this.dirty = true;
  }

  peek(): SpoolEntry | undefined {
    return this.spool[0];
  }

  /** Remove the head: it was delivered, or it can never be. */
  shift(): void {
    const gone = this.spool.shift();
    if (gone) this.bytes -= gone.body.length;
    this.dirty = true;
  }

  recordSent(kind: TelemetryKind, body: string, units: number): void {
    this.lastSent[kind] = { at: new Date(this.now()).toISOString(), body };
    this.stats.bytes += body.length;
    if (kind === "heartbeat") this.stats.heartbeats += 1;
    else if (kind === "events") this.stats.events += units;
    else this.stats.logRecords += units;
    this.dirty = true;
  }

  count(kind: TelemetryKind): number {
    return this.spool.reduce((n, e) => n + (e.kind === kind ? 1 : 0), 0);
  }

  last(kind: TelemetryKind): SentRow | null {
    return this.lastSent[kind] ?? null;
  }

  bump(field: "refused" | "rejected"): void {
    this.stats[field] += 1;
    this.dirty = true;
  }

  get droppedTotal(): number {
    return this.stats.dropped;
  }

  /** The counters so far; starts the next summary period. */
  takeStats(): TelemetryStats {
    const out = this.stats;
    this.stats = emptyStats(this.now());
    this.dirty = true;
    return out;
  }

  async persist(): Promise<void> {
    if (!this.dirty) return;
    const data: Persisted = { v: 1, spool: this.spool, lastSent: this.lastSent, stats: this.stats };
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await rename(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.warn(`telemetry state cannot be written (${(err as NodeJS.ErrnoException).code ?? "error"}); buffering in memory only`);
      }
    }
  }
}
