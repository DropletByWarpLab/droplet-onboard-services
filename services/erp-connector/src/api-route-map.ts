/**
 * WARP-1294 — route-map indirection for the Patterson Eaglesoft REST API
 * (Innovation Connection; ASP.NET Web-API-2 over HTTPS :9888).
 *
 * The exact HTTP route templates + verbs + response field names are compiled
 * `[Route]`/DTO attributes inside `Patterson.Eaglesoft.Api.Server.dll` — they
 * are NOT part of the shipped XML doc, so they must be DISCOVERED at runtime
 * from the box's built-in `/help` page (or the Patterson SDK "API Method
 * Matrix" / "API Fields" docs). They are NEVER hardcoded as guesses.
 *
 * This module ships the KNOWN half — the controller + method name backing each
 * logical operation (from the reverse-engineered API surface) — with the
 * `verb` / `template` / `fields` left undiscovered, plus the validators the
 * connector uses to REFUSE an operation until its contract is resolved (an
 * honest `ConnectorBlockedError`, never a guessed request going out the wire).
 *
 * The op names are derived from the SQL track's READ_QUERIES / WRITE_COMMANDS
 * registries so this map can never silently drift out of sync with them.
 */
import { READ_QUERIES } from "./read-queries.js";
import { PRACTICE_DATASETS } from "./connector.js";
import { WRITE_COMMANDS } from "./write-commands.js";

export type HttpVerb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One logical operation's binding to the REST API. `controller` + `method` are
 * KNOWN (from the API surface). `verb` + `template` + `listPath` + `fields` are
 * the DISCOVERED contract (from `/help` or the SDK), absent until resolved.
 */
export interface RouteSpec {
  /** Web-API-2 controller, e.g. "Schedule". Known. */
  controller: string;
  /** Controller method backing this op, e.g. "GetAppointmentsByDateRange". Known. */
  method: string;
  /** HTTP verb — DISCOVERED (undefined until `/help` is read). */
  verb?: HttpVerb;
  /** Route template relative to the API base, e.g. "/api/schedule/range".
   *  DISCOVERED. Only `.local`/`.lan`/`.example` example hosts ever appear in
   *  source; a real office host is never baked (egress-gate contract). */
  template?: string;
  /** Dotted path to the array (reads) or object (writes) inside the JSON
   *  response. Empty/undefined = the response root. DISCOVERED. */
  listPath?: string;
  /** Canonical row key -> API JSON field name (dotted), so the DTO layer never
   *  guesses Patterson's field names. DISCOVERED from the "API Fields" doc. */
  fields?: Record<string, string>;
  /** Canonical request-param key -> API query-string name, so outgoing query
   *  params are never guessed either. DISCOVERED. Pass-through when absent. */
  params?: Record<string, string>;
}

/** The auth op additionally records where the session token lives in the
 *  response body (dotted path). */
export type AuthRouteSpec = RouteSpec & { tokenPath?: string };

export interface EaglesoftApiRouteMap {
  /** AuthenticationController.Authenticate(integrationKey, userId, password). */
  authenticate: AuthRouteSpec;
  /** Keyed by READ_QUERIES name. */
  reads: Record<string, RouteSpec>;
  /** Keyed by WRITE_COMMANDS name. */
  writes: Record<string, RouteSpec>;
}

/** Thrown when an operation is invoked before its route contract is discovered. */
export class RouteNotDiscoveredError extends Error {
  readonly code = "ROUTE_NOT_DISCOVERED";
  constructor(op: string) {
    super(
      `route contract for "${op}" is not discovered — needs the verb+template ` +
        `from a live Eaglesoft API /help page or the Patterson SDK method matrix ` +
        `(never hardcoded)`,
    );
    this.name = "RouteNotDiscoveredError";
  }
}

/**
 * The KNOWN controller+method for each logical op. `verb`/`template`/`fields`
 * are intentionally undefined — discovered at `connect()` time. Shipping these
 * lets onboarding pre-populate the map and lets the connector name exactly
 * which endpoints it still needs, WITHOUT ever guessing a path or verb.
 */
export const KNOWN_ROUTE_SKELETON: EaglesoftApiRouteMap = {
  authenticate: { controller: "Authentication", method: "Authenticate", tokenPath: "token" },
  reads: {
    get_schedule_today: { controller: "Schedule", method: "GetAppointmentsByDateRange" },
    find_patient: { controller: "Patient", method: "GetPatientByName" },
    get_patient: { controller: "Patient", method: "GetPatientById" },
    get_ar_summary: { controller: "Account", method: "GetAgedBalanceByResponsibleParty" },
    get_recall_due: { controller: "Patient", method: "GetRecallList" },
  },
  writes: {
    reschedule_appointment: { controller: "Schedule", method: "UpdateAppointment" },
  },
};

/**
 * The op names that MUST have a route slot — derived from the shared registries
 * so the skeleton cannot drift from the read/write contracts.
 *
 * WARP-2107 scoped the read half to the datasets THIS track serves. The
 * registry is shared across every provider, so once it grew accounting reads
 * (`get_open_bills` and friends) "every registered read" stopped meaning
 * "every read Patterson could answer" — Eaglesoft has no accounts-payable
 * ledger, and demanding a Patterson route slot for one would be demanding a
 * route that cannot exist.
 *
 * The filter is on the same declared capability the connector enforces at
 * runtime (`PRACTICE_DATASETS`), so the skeleton and the connector cannot
 * disagree about what this track is for.
 */
export function requiredRouteOps(): { reads: readonly string[]; writes: readonly string[] } {
  return {
    reads: READ_QUERIES.filter((q) =>
      q.dependsOnTables.every((t) => PRACTICE_DATASETS.includes(t)),
    ).map((q) => q.name),
    writes: WRITE_COMMANDS.map((c) => c.name),
  };
}

/** A route spec that carries a usable, DISCOVERED request contract. */
export type DiscoveredRoute = RouteSpec & { verb: HttpVerb; template: string };

/** True when a spec has both a verb and a template (i.e. is callable). */
export function isRouteDiscovered(spec: RouteSpec | undefined): spec is DiscoveredRoute {
  return !!spec && !!spec.verb && !!spec.template;
}

function resolve(spec: RouteSpec | undefined, op: string): DiscoveredRoute {
  if (!isRouteDiscovered(spec)) throw new RouteNotDiscoveredError(op);
  return spec;
}

/** Resolve the auth route; throws RouteNotDiscoveredError if undiscovered. */
export function resolveAuthRoute(map: EaglesoftApiRouteMap): DiscoveredRoute & { tokenPath?: string } {
  return resolve(map.authenticate, "authenticate");
}

/** Resolve a read op's route by name; throws if undiscovered. */
export function resolveReadRoute(map: EaglesoftApiRouteMap, name: string): DiscoveredRoute {
  return resolve(map.reads[name], `read:${name}`);
}

/** Resolve a write op's route by name; throws if undiscovered. */
export function resolveWriteRoute(map: EaglesoftApiRouteMap, name: string): DiscoveredRoute {
  return resolve(map.writes[name], `write:${name}`);
}

/**
 * A stable content hash over the discovered route map's shape (controllers +
 * methods + verbs + templates for every op). Stands in for the SQL track's
 * schema fingerprint so the drift-freeze semantics stay coherent on the API
 * track: an Eaglesoft API upgrade that moves routes changes this hash.
 */
export function routeMapFingerprint(map: EaglesoftApiRouteMap): string {
  const parts: string[] = [];
  const push = (op: string, s: RouteSpec | undefined) => {
    parts.push(`${op}:${s?.controller ?? ""}.${s?.method ?? ""}:${s?.verb ?? ""}:${s?.template ?? ""}`);
  };
  push("auth", map.authenticate);
  for (const name of Object.keys(map.reads).sort()) push(`r:${name}`, map.reads[name]);
  for (const name of Object.keys(map.writes).sort()) push(`w:${name}`, map.writes[name]);
  return fnv1a64Hex(parts.join("|"));
}

/** Small dependency-free 64-bit FNV-1a hex digest (no crypto import needed for
 *  a non-security fingerprint). */
function fnv1a64Hex(input: string): string {
  // 64-bit FNV-1a using BigInt.
  const prime = 1099511628211n;
  const mask = (1n << 64n) - 1n;
  let hash = 14695981039346656037n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
