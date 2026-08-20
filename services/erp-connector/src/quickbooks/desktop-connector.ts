/**
 * WARP-2108 — QuickBooks Desktop: the track where the practice's machine calls
 * US.
 *
 * ## The shape, and why it is inverted
 *
 * Every other connector in this package is a client: it opens something and
 * pulls. This one is a server. Intuit's **Web Connector** is a Windows service
 * the practice already has, and it *polls outward* — it asks our endpoint for
 * work, runs the qbXML we hand it against the local company file, and posts the
 * results back.
 *
 * That direction is the whole reason this track is worth building. Data flows
 * machine → box, so Droplet never opens a socket into the customer's finance
 * workstation, nothing leaves the LAN, and the agent doing the work is Intuit's
 * own — already installed, already trusted by the customer's IT. It is our
 * boundary posture handed to us by the vendor, for free: Intuit charges nothing
 * for the SDK, requires no app review, and takes no royalty.
 *
 * ## What that costs, and how it is paid
 *
 * A session happens when the Windows machine decides, on a schedule the
 * customer owns. So a read cannot mean "go and fetch": it serves the most
 * recent COMPLETED session's snapshot, and reports how old that is. This is the
 * same read-through-a-snapshot posture the export-drop track has, for the same
 * reason, and staleness is reported rather than hidden — the front desk
 * disabling the Web Connector is the expected failure, and it must never render
 * as "you owe nobody anything".
 *
 * A session is applied ATOMICALLY. Rows accumulate in a pending buffer and
 * replace the snapshot only when the session completes cleanly. A session that
 * dies halfway leaves the previous snapshot exactly as it was, because half a
 * payables ledger is worse than a slightly old one.
 *
 * ## This is inbound, and therefore attack surface
 *
 * No other connector in this package accepts a request. This one does, from a
 * machine on the practice LAN, and it is treated accordingly: per-connection
 * credentials compared in constant time, a session ticket that is unguessable
 * and single-use, and a strict cap on how much XML will be parsed. The qbXML
 * reader refuses DOCTYPE outright (see xml.ts) so entity attacks are structural
 * non-events rather than mitigations.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  ConnectorBlockedError,
  assertDatasetsServed,
  type Connector,
  type IntrospectionResult,
} from "../connector.js";
import { getReadQuery } from "../read-queries.js";
import { assertTargetAllowed, getWriteCommand } from "../write-commands.js";
import { computeSchemaFingerprint, type IntrospectedTable } from "../schema-map.js";
import { sortByKey } from "../api-dto.js";
import { CANONICAL_COLUMNS, type DatasetName } from "../export-drop/profiles.js";
import {
  buildRequest,
  parseResponse,
  QBXML_STEPS,
  QBXML_VERSION,
  type QbxmlStep,
} from "./qbxml.js";

/** Provider key for this track. */
export const QUICKBOOKS_DESKTOP_PROVIDER = "quickbooks-desktop";

/** The datasets a QuickBooks company file carries. No appointments — saying so
 *  is a capability, not a failure (see `assertDatasetsServed`). */
export const QBD_DATASETS: readonly string[] = ["invoice", "bill", "ap_summary"];

export const QBD_TRACK_REMEDIATION =
  "needs the QuickBooks Web Connector installed on the machine running QuickBooks " +
  "Desktop, loaded with this connection's .qwc file, and run at least once — the " +
  "practice's machine calls Droplet, so nothing here reaches out to it";

/** A completed session's results. Replaced atomically, never mutated in place. */
export interface QbdSnapshot {
  /** Epoch ms the session completed. */
  completedAt: number;
  rows: Readonly<Record<string, Record<string, unknown>[]>>;
}

/**
 * Where completed sessions land and reads are served from.
 *
 * Separate from the connector because their lifetimes differ: `erp.service`
 * builds and discards a connector per read, while a session is minutes long and
 * belongs to the box. A connector that owned the snapshot would throw away the
 * practice's data every time somebody asked a question.
 */
export class QbdSnapshotStore {
  private snapshot: QbdSnapshot | null = null;

  get current(): QbdSnapshot | null {
    return this.snapshot;
  }

  /** Publish a completed session. The only writer. */
  publish(snapshot: QbdSnapshot): void {
    this.snapshot = snapshot;
  }
}

/** Per-connection Web Connector credentials. The password is compared, never
 *  echoed; it is set by the operator in the Web Connector's own UI. */
export interface QbwcCredentials {
  username: string;
  password: string;
}

export interface QbwcSessionDeps {
  now?: () => number;
  /** Injected in tests so ticket values are deterministic. */
  newTicket?: () => string;
  /** Cap on one posted response, mirroring the export track's file ceiling. */
  maxResponseBytes?: number;
}

/** What `authenticate` returns to the Web Connector: [ticket, companyFileHint]. */
export type AuthenticateResult = [string, string];

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Constant-time string comparison that does not leak length through timing
 *  any more than it has to. Both sides are hashed to a fixed width by padding
 *  first, so `timingSafeEqual`'s equal-length requirement cannot itself become
 *  the oracle. */
function secretEquals(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const width = Math.max(ab.length, bb.length, 32);
  const pa = Buffer.alloc(width);
  const pb = Buffer.alloc(width);
  pa.set(ab);
  pb.set(bb);
  // Length equality is folded in explicitly so padding cannot make two
  // different-length secrets compare equal.
  return timingSafeEqual(pa, pb) && ab.length === bb.length;
}

/**
 * The Web Connector callback contract, as a state machine.
 *
 * The SOAP/HTTP envelope is the orchestrator's job — this package stays
 * transport-agnostic exactly as the SQL track does, so the same session logic
 * is testable without standing up a server. The method names mirror the
 * Programmer's Guide (`authenticate`, `sendRequestXML`, `receiveResponseXML`,
 * `connectionError`, `getLastError`, `closeConnection`) and their return
 * conventions, which the guide defines and this implementation does not invent:
 * an empty-string ticket rejects the session, and `receiveResponseXML` returns a
 * percentage where <100 means "more work" and 100 means "done".
 */
export class QbwcSession {
  private ticket: string | null = null;
  private stepIndex = 0;
  private pending: Record<string, Record<string, unknown>[]> = {};
  private lastError = "";
  /** Set when a session aborts. The ticket deliberately stays valid — see
   *  {@link QbwcSession.abort}. */
  private failed = false;
  private readonly now: () => number;
  private readonly newTicket: () => string;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly credentials: QbwcCredentials,
    private readonly store: QbdSnapshotStore,
    deps: QbwcSessionDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.newTicket = deps.newTicket ?? (() => randomBytes(24).toString("hex"));
    this.maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /**
   * Step 1. Wrong credentials return the guide's rejection form — an empty
   * ticket and "nvu" (no valid user) — rather than an exception, because the
   * Web Connector is a SOAP client that will show a user whatever we return and
   * an unhandled fault reads as "the server is broken" rather than "check the
   * password".
   */
  authenticate(username: string, password: string): AuthenticateResult {
    const ok =
      secretEquals(username, this.credentials.username) &&
      secretEquals(password, this.credentials.password);
    if (!ok) {
      this.lastError = "authentication failed";
      return ["", "nvu"];
    }
    // A fresh ticket per session, and any previous one is abandoned: a session
    // is not resumable and a leaked ticket must not outlive the run it belongs
    // to.
    this.ticket = this.newTicket();
    this.stepIndex = 0;
    this.pending = {};
    this.lastError = "";
    this.failed = false;
    // Empty company-file hint = "use the file currently open in QuickBooks",
    // which is what an integration reading one practice's books wants. Naming a
    // path would make us responsible for a filesystem we cannot see.
    return [this.ticket, ""];
  }

  /** Reject any call whose ticket is not the live one. Unknown tickets are not
   *  distinguished from stale ones — both mean "not this session". */
  private assertTicket(ticket: string): void {
    if (!this.ticket || !secretEquals(ticket, this.ticket)) {
      throw new Error("unknown or expired Web Connector session ticket");
    }
  }

  /** Step 2. The qbXML for the current step, or "" when the session is done. */
  sendRequestXML(ticket: string): string {
    this.assertTicket(ticket);
    // A failed session has no more work. Returning "" is the guide's "nothing
    // to do", which lets the Web Connector wind down through getLastError and
    // closeConnection instead of being handed another request to run.
    if (this.failed) return "";
    const step = QBXML_STEPS[this.stepIndex];
    if (!step) return "";
    return buildRequest(step, String(this.stepIndex + 1));
  }

  /**
   * Step 3. Ingest one response and report progress.
   *
   * A parse or status failure aborts the whole session by returning a negative
   * value (the guide's error convention) and leaves the previous snapshot
   * untouched. Ingesting a partial ledger would be the worst outcome available
   * here: a confidently-wrong, smaller number for what the practice owes.
   */
  receiveResponseXML(ticket: string, response: string): number {
    this.assertTicket(ticket);
    if (response.length > this.maxResponseBytes) {
      this.lastError = `response exceeds the ${this.maxResponseBytes}-byte ceiling`;
      this.abort();
      return -1;
    }
    const step = QBXML_STEPS[this.stepIndex];
    if (!step) return 100;

    try {
      this.pending[datasetFor(step)] = parseResponse(step, response);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.abort();
      return -1;
    }

    this.stepIndex += 1;
    if (this.stepIndex >= QBXML_STEPS.length) {
      this.commit();
      return 100;
    }
    // The guide wants a percentage strictly under 100 to be asked again.
    return Math.floor((this.stepIndex / QBXML_STEPS.length) * 99);
  }

  /** The Web Connector's error hook; also called when a user cancels. */
  connectionError(ticket: string, hresult: string, message: string): string {
    this.assertTicket(ticket);
    this.lastError = `${hresult}: ${message}`;
    this.abort();
    return "done";
  }

  getLastError(ticket: string): string {
    this.assertTicket(ticket);
    return this.lastError;
  }

  closeConnection(ticket: string): string {
    this.assertTicket(ticket);
    // The only place a ticket is retired. One session, one ticket, no resume.
    this.ticket = null;
    this.failed = false;
    return "OK";
  }

  /**
   * Throw the half-built session away. The store is deliberately untouched —
   * that is the atomicity property: a run that dies halfway leaves the previous
   * snapshot exactly as it was, because half a payables ledger is a
   * confidently-wrong, smaller number for what a practice owes.
   *
   * The TICKET deliberately survives. The Web Connector calls `getLastError`
   * AFTER we return a failure, precisely to find out what went wrong, and then
   * `closeConnection` to wind down — clearing the ticket here made both of
   * those throw, so the operator saw a generic SOAP fault instead of the reason.
   * The session is dead either way; it just stays addressable long enough to
   * explain itself.
   */
  private abort(): void {
    this.pending = {};
    this.stepIndex = 0;
    this.failed = true;
  }

  /** Publish atomically, derive the aggregate, then clear the buffer. */
  private commit(): void {
    const bills = this.pending.bill ?? [];
    // Aggregated from the bills this same session returned rather than from a
    // separate query: one source cannot disagree with itself, and two can.
    const byVendor = new Map<string, number>();
    for (const row of bills) {
      const balance = row.balance;
      if (typeof balance !== "number" || balance === 0) continue;
      const vendor = typeof row.vendor_id === "string" ? row.vendor_id : "(unknown vendor)";
      byVendor.set(vendor, (byVendor.get(vendor) ?? 0) + balance);
    }
    let total = 0;
    for (const v of byVendor.values()) total += v;

    this.store.publish({
      completedAt: this.now(),
      rows: {
        ...this.pending,
        ap_summary: [{ vendor_count: byVendor.size, total_balance: total }],
      },
    });
    this.pending = {};
    this.stepIndex = 0;
  }
}

/** The dataset one qbXML step populates. */
function datasetFor(step: QbxmlStep): string {
  return step === "invoice" ? "invoice" : "bill";
}

export interface QuickBooksDesktopConfig {
  /**
   * How old the last completed session may be before the data is reported
   * stale. Defaults to 26 hours for the same reason the export track does: the
   * expected cadence is roughly daily, and a 24-hour threshold would flap into
   * "stale" every morning shortly before the Web Connector next runs.
   */
  staleAfterMinutes?: number;
}

export interface QuickBooksDesktopDeps {
  now?: () => number;
}

export interface QbdStatus {
  ok: boolean;
  stale: boolean;
  lastSessionAt: string | null;
  ageMinutes: number | null;
  datasets: { dataset: string; rowCount: number }[];
}

const DEFAULT_STALE_AFTER_MINUTES = 26 * 60;

export class QuickBooksDesktopConnector implements Connector {
  readonly provider = QUICKBOOKS_DESKTOP_PROVIDER;
  readonly servesDatasets = QBD_DATASETS;

  private readonly now: () => number;
  private readonly staleAfterMs: number;

  constructor(
    private readonly store: QbdSnapshotStore,
    config: QuickBooksDesktopConfig = {},
    deps: QuickBooksDesktopDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.staleAfterMs = (config.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES) * 60_000;
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(detail ? `${op} (${detail})` : op, QBD_TRACK_REMEDIATION);
  }

  /** The snapshot, or a blocked error saying no session has completed. Note the
   *  remediation is actionable — run the Web Connector — which is exactly what
   *  distinguishes it from a capability gap. */
  private require(op: string): QbdSnapshot {
    const snap = this.store.current;
    if (!snap) throw this.blocked(op, "no Web Connector session has completed yet");
    return snap;
  }

  async connect(): Promise<void> {
    this.require("connect");
  }

  async close(): Promise<void> {
    // Nothing to drain: the snapshot belongs to the store, which outlives any
    // one connector by design.
  }

  /**
   * `ok` means "a session has completed and we hold its results". It
   * deliberately does NOT go false on stale data: a 30-hour-old snapshot is
   * old, not broken, and collapsing those two facts would either hide the age
   * or throw away readable data. `status()` reports the age; the caller labels
   * it.
   */
  async health(): Promise<{ ok: boolean; stale: boolean }> {
    const s = await this.status();
    if (!s.ok) throw this.blocked("health", "no Web Connector session has completed yet");
    return { ok: s.ok, stale: s.stale };
  }

  async status(): Promise<QbdStatus> {
    const snap = this.store.current;
    if (!snap) {
      return { ok: false, stale: true, lastSessionAt: null, ageMinutes: null, datasets: [] };
    }
    const ageMs = this.now() - snap.completedAt;
    return {
      ok: true,
      stale: ageMs > this.staleAfterMs,
      lastSessionAt: new Date(snap.completedAt).toISOString(),
      ageMinutes: Math.max(0, Math.round(ageMs / 60_000)),
      datasets: Object.entries(snap.rows).map(([dataset, rows]) => ({
        dataset,
        rowCount: rows.length,
      })),
    };
  }

  private tables(): IntrospectedTable[] {
    return QBD_DATASETS.map((dataset) => ({
      name: dataset,
      owner: "qbd",
      columns: CANONICAL_COLUMNS[dataset as DatasetName].map((name) => ({ name, type: "text" })),
    }));
  }

  async introspect(): Promise<IntrospectionResult> {
    const tables = this.tables();
    // The qbXML spec version is pinned into the fingerprint for the same reason
    // the QBO track pins its minor version: a spec change can move field shapes
    // without touching our canonical column list, and a fingerprint blind to
    // that reports "no drift" across a real one.
    return { tables, fingerprint: `${computeSchemaFingerprint(tables)}:qbxml${QBXML_VERSION}` };
  }

  async runRead(name: string, _params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    const op = `runRead:${name}`;
    const snap = this.require(op);

    // Same predicate as every other accounting track: a part-paid document is
    // still money, and a balance we could not read is money we cannot account
    // for and must stay visible rather than be quietly dropped.
    const isOpen = (row: Record<string, unknown>) =>
      typeof row.balance !== "number" || row.balance !== 0;

    switch (name) {
      case "get_open_invoices": {
        const rows = (snap.rows.invoice ?? []).filter(isOpen);
        return sortByKey(sortByKey(rows, "invoice_id"), "due_at");
      }
      case "get_open_bills": {
        const rows = (snap.rows.bill ?? []).filter(isOpen);
        return sortByKey(sortByKey(rows, "bill_id"), "due_at");
      }
      case "get_ap_summary":
        return snap.rows.ap_summary ?? [{ vendor_count: 0, total_balance: 0 }];
      default:
        throw this.blocked(op, "read is not served by the QuickBooks Desktop track");
    }
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // qbXML can write, and this track deliberately does not. A write would have
    // to travel back through a session the practice's machine initiates on its
    // own schedule — so "confirmed" and "applied" could be hours apart, which
    // no confirmation flow we have models honestly.
    throw this.blocked(
      `applyWrite:${name}`,
      "the QuickBooks Desktop track is read-only — a write would apply whenever the " +
        "practice's Web Connector next runs, which no confirmation flow models",
    );
  }
}
