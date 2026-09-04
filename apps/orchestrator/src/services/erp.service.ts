/**
 * erp.service — the ERP read + write-request control plane (WARP-1137,
 * EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF §11, §13, §14).
 *
 * The orchestrator half: the dashboard's `/api/erp/*` calls land here and this
 * calls the `erp-connector`. The two tracks are in different states, and the
 * difference is worth knowing before reading further:
 *
 *  • "eaglesoft-api" (Patterson REST) — LIVE. Given a configured row (encrypted
 *    credentials, a discovered route map, a CA to trust), reads reach a real
 *    box and return real rows. Proven end to end in erp-api-live.test.ts.
 *  • "eaglesoft" (direct SAP SQL Anywhere) — still entirely stubbed. Every
 *    method throws `ConnectorBlockedError` because no driver exists yet
 *    (WARP-1095+, gated on the SAP client + a copy DB).
 *
 * HONEST DEGRADATION: a blocked connector NEVER fabricates PHI. Reads return
 * `{ connected: false, reason: "ERP_NOT_CONNECTED", <empty> }`; a write that
 * can't apply is recorded `FAILED`, never a fake `APPLIED`. That path now
 * covers the REST track's real failure modes too — missing or undecryptable
 * credentials, an undiscovered route map, a certificate that doesn't verify,
 * an unreachable box — each of which lands in exactly the same honest state
 * rather than a half-working connection.
 *
 * HARD RULES honored here:
 *  • Explicit-enum write-request lifecycle — every transition is an explicit
 *    `WriteStatus` value, never derived from absence (invariant 7 / WARP-218).
 *  • A write is staged, then human-confirmed, then applied (brief §11.1). Intent
 *    (`createWriteRequest`) touches nothing in Eaglesoft.
 *  • RBAC / PHI minimum-necessary (§14): reads gated to PHI roles, writes to
 *    owner/admin. Every read AND every write transition writes an append-only
 *    `ErpAuditLog` row whose `scope` carries only non-PHI tokens (table, count,
 *    internal ids) — never names/DOB/notes.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ConnectorBlockedError,
  DatasetNotServedError,
  WRITE_COMMANDS,
  exportProviders,
  scheduleDayBounds,
  type Connector,
} from "@droplet/erp-connector";
import { cloudProviderIds, providerDescriptor } from "@droplet/shared-types";
import { createLogger } from "../lib/logger.js";
// WARP-2610 — the SAME `code` reader the persisted-status classifier uses, so
// the two cannot disagree about what a connector error means.
import { CONNECTOR_BLOCKED_CODE, connectorErrorCode } from "./cloud-connection-state.js";
import { ErpError } from "./erp-error.js";
import {
  apiMaterialFromRow,
  cloudMaterialFromRow,
  connectorForProvider,
  loadOperatorExportProfiles,
  setCloudTokenWriter,
  EAGLESOFT_API_PROVIDER,
  EAGLESOFT_PROVIDER,
} from "./erp-provider.js";

const logger = createLogger("erp-service");

/** Roles allowed to view PHI (schedule/patients/AR/recall) — minimum-necessary.
 *  Clinical staff only. NOT the household-default `family` role: roleFromGroups
 *  assigns `family` to any un-grouped account, so admitting it here would make
 *  patient PHI readable by default (fail-open). Non-clinical roles get the lock.
 *
 *  WARP-1530 (ADR-032 §8 O-2) deliberately does NOT add `family` to this set.
 *  A family person reaches PHI only by arriving with a RESOLVED
 *  `AccessRoleConnectorGrant` (`ErpUser.connectorLevel`), which the route gate
 *  reads from the effective-access resolver. Keeping the tier set narrow means
 *  the fail-open case — a future route registered without the gate — still
 *  cannot hand patient data to the household default. */
const PHI_READ_ROLES = new Set(["owner", "admin"]);
/** Roles that may hold a connector grant at all — O-2's "family-and-up". */
const GRANTABLE_PHI_READ_ROLES = new Set(["family"]);
/** Roles allowed to stage/confirm a write back into Eaglesoft. Admin-tier only
 *  — O-2 leaves this exactly as it was; a connector grant never widens it. */
const WRITE_ROLES = new Set(["owner", "admin"]);
/** The registered write-command names — the validation allow-list (brief §11.3). */
const WRITE_COMMAND_NAMES = new Set(WRITE_COMMANDS.map((c) => c.name));
/**
 * Roles that may read a cloud business dataset (WARP-2497).
 *
 * Admin-tier, matching `WRITE_ROLES` rather than the PHI ladder's
 * family-and-up: revenue, pipeline and campaign data is not something a
 * household member on a shared box should reach by typing a question, and
 * there is no connector-grant axis for the cloud providers yet to widen it
 * with. When one lands (the §5.4 connectors axis already models per-provider
 * grants) this is the single set to relax.
 */
const CLOUD_DATASET_READ_ROLES = new Set(["owner", "admin"]);

export interface ErpUser {
  id: string;
  role: string;
  /**
   * WARP-1530 — the person's RESOLVED connector reach for this provider, as
   * the effective-access resolver computed it
   * (`min(roleConnectorGrant, connection.writeEnabled ? read_write : read)`).
   * Set by the route's O-2 gate; `null`/absent means "no grant", which is
   * every caller that predates RBAC v2. Read-side only: writes stay
   * admin-tier, so this never widens `assertCanWrite`.
   */
  connectorLevel?: "read" | "read_write" | null;
  /**
   * WARP-1579 — the RAW role connector grant for this provider, BEFORE the
   * `min()` against `connection.writeEnabled`. Set by the route's write gate.
   *
   * `connectorLevel` cannot stand in for it: `read` there is ambiguous
   * between a read-only ROLE (a 403) and a write-disabled CONNECTION (today's
   * honest 409 `WRITE_NOT_ENABLED`).
   *
   * `null`/absent = **no role grant narrows this person** — every caller that
   * predates RBAC v2 and every role-less admin. Absence is NOT a denial; only
   * an explicit `read` refuses. This never WIDENS `assertCanWrite` either:
   * the admin-tier floor above it is unchanged.
   */
  connectorGrantLevel?: "read" | "read_write" | null;
}

export interface ScheduleResult {
  connected: boolean;
  reason?: string;
  capability?: CapabilityLimit;
  date: string;
  items: unknown[];
}
export interface PatientsResult {
  connected: boolean;
  reason?: string;
  capability?: CapabilityLimit;
  items: unknown[];
}
export interface PatientResult {
  connected: boolean;
  reason?: string;
  capability?: CapabilityLimit;
  patient: unknown | null;
}
export interface ArSummaryResult {
  connected: boolean;
  reason?: string;
  capability?: CapabilityLimit;
  totalBalance: number | null;
  accountCount: number | null;
}
export interface RecallResult {
  connected: boolean;
  reason?: string;
  capability?: CapabilityLimit;
  items: unknown[];
}

export interface CreateWriteRequestInput {
  command: string;
  params: Record<string, unknown>;
}

type ErpPrisma = Pick<
  PrismaClient,
  "integrationConnection" | "erpWriteRequest" | "erpAuditLog"
>;
type ConnRow = NonNullable<
  Awaited<ReturnType<ErpPrisma["integrationConnection"]["findFirst"]>>
>;
type WriteRequestRow = Awaited<
  ReturnType<ErpPrisma["erpWriteRequest"]["findUnique"]>
>;

/** Dependency seam so tests inject a stubbed connector. */
export interface ErpServiceDeps {
  connectorFor?: (conn: ConnRow) => Connector;
}

function defaultConnectorFor(conn: ConnRow): Connector {
  // Dual-track: build the connector for the row's persisted provider
  // ("eaglesoft" → SQL Anywhere, "eaglesoft-api" → Patterson REST API).
  //
  // `apiMaterialFromRow` decrypts the stored credentials, validates the stored
  // route map, and hands over the CA to trust. Any of those being absent or
  // undecryptable resolves to undefined, which leaves the connector blocked and
  // routes to the honest ERP_NOT_CONNECTED path — never a half-configured
  // connection that authenticates with empty strings.
  // WARP-2137 — `cloudMaterialFromRow` does the same for the ADR-041 cloud
  // tracks: it validates `providerConfig` structurally and decrypts
  // `providerTokensEnc` (AAD-bound to the row id). Same contract — anything
  // absent, malformed, or sealed against another row resolves to undefined and
  // the connector stays blocked.
  return connectorForProvider({
    provider: conn.provider,
    host: conn.host ?? "",
    port: conn.port ?? undefined,
    databaseName: conn.databaseName ?? undefined,
    secretRef: conn.secretRef ?? undefined,
    ...apiMaterialFromRow(conn),
    ...cloudMaterialFromRow(conn),
  });
}

/**
 * The cloud-track states that are outcomes, not faults (WARP-2137 finding #1),
 * keyed on the connector error's `code` rather than its class (WARP-2610).
 *
 * Returned with `connected: true`, which is the point: the connection is intact
 * and correctly configured. Collapsing either into ERROR — or into
 * ERP_NOT_CONNECTED — would tell the owner to go re-check a connection that has
 * nothing wrong with it, and would hide the one thing they can actually act on.
 *
 *  • QUOTA_EXHAUSTED — this period's metered allowance is spent. Nothing is
 *    broken, no data is lost, and reads resume next period. There is no user
 *    action, so presenting it as a failure would be a lie that costs a support
 *    call.
 *  • REAUTHORIZE_REQUIRED — the grant is dead (refresh token lapsed, consent
 *    withdrawn, vendor enablement pulled). Retrying can NEVER fix it; only a
 *    person re-consenting can. The opposite of the above, and the reason they
 *    are two states rather than one "degraded".
 *
 * ## Why `code` and not `instanceof` (WARP-2610)
 *
 * This was three `instanceof` checks naming QuickBooks Online's two classes and
 * Dentrix Ascend's one. Every other vendor's identically-meaning error fell
 * through to the generic ERROR branch: Stripe, HubSpot, Mailchimp and Shopify
 * each export their OWN `…ReauthorizationRequiredError` — a package cannot
 * re-export four classes of one name — so the list was a per-vendor registry
 * that nobody was told to update, and it had fallen four vendors behind.
 *
 * Every ADR-041 connector error carries a `readonly code`, and the tracks
 * already agree on the strings. Keying on the code means this function holds no
 * vendor knowledge, and `cloud-connection-state.ts` — which classifies the same
 * errors into the persisted status — reads the same field with the same helper.
 * A sixth vendor is classified the day it lands, with no edit here.
 *
 * `USER_DOES_NOT_HAVE_PERMISSIONS` (HubSpot: the private app's creator lost
 * super admin) is reauth-class for the same reason
 * `INTEGRATION_STATUS_BY_HEALTH_FAILURE_CODE` calls it NEEDS_RECONNECT — the
 * portal refuses every call until a current super admin re-creates the app and
 * the new token is pasted here. One vocabulary across both classifiers.
 *
 * ## Why a `Map` and not an object literal
 *
 * A bare `obj[code]` walks the prototype chain, and `code` is a string that
 * arrived from a connector. `READ_REASON_BY_CODE["constructor"]` would answer
 * with `Object` — truthy, so the branch below is taken, and not a reason. The
 * read then returns `connected: true` with a FUNCTION in `reason`, which
 * `JSON.stringify` drops on the way out of `routes/erp.ts`, leaving the owner's
 * browser holding `{ connected: true, rows: [] }`: the empty success ADR-041
 * forbids and this very ticket exists to remove, minted by an error whose code
 * happened to be an ordinary-looking word.
 *
 * A `Map` has no inherited keys to find, so the hazard cannot be reintroduced
 * by a later edit the way an `Object.hasOwn` guard at the call site could be.
 * It also reads like `CAPABILITY_LIMITED_CODES` below — one lookup vocabulary
 * for the two tables this classifier consults.
 */
const READ_REASON_BY_CODE: ReadonlyMap<string, "QUOTA_EXHAUSTED" | "REAUTHORIZE_REQUIRED"> =
  new Map([
    ["QUOTA_EXHAUSTED", "QUOTA_EXHAUSTED"],
    ["REAUTHORIZE_REQUIRED", "REAUTHORIZE_REQUIRED"],
    ["USER_DOES_NOT_HAVE_PERMISSIONS", "REAUTHORIZE_REQUIRED"],
  ]);

/**
 * The codes that mean "this connection works and exactly one dataset is
 * refused" (WARP-2610).
 *
 * A THIRD rendering, not a variant of either state above, because the owner
 * action is different again: nothing about the credential or the box changes
 * this, and nothing about waiting does either. Only the vendor-side plan,
 * scope or permission does — and the connector's own message names which.
 *
 * Rendering these as `connected: false, reason: "ERROR"` (which is what they
 * did) is the defect: a Basic-plan Shopify store reads orders, products and
 * inventory perfectly and withholds only customer identities, and a Mailchimp
 * account on a plan without a resource is otherwise entirely healthy. The owner
 * was sent to fix a credential with nothing wrong with it, and the one fact
 * they could act on — the plan — never reached them.
 *
 * It is still emphatically NOT an empty success: ADR-041's hard rule is that a
 * withheld dataset renders THIS, never `[]`, which reads as "you have no
 * customers".
 *
 *  • CAPABILITY_MISSING — Mailchimp: the account's plan or permissions do not
 *    grant the resource.
 *  • CAPABILITY_NOT_AVAILABLE — HubSpot: the portal's tier does not include the
 *    object.
 *  • SCOPE_MISSING — Shopify (PR #1945): the app was never granted a scope this
 *    read needs. The merchant ticks it in the Dev Dashboard.
 *  • PROTECTED_CUSTOMER_DATA_DENIED — Shopify (PR #1945): protected customer
 *    data withheld, either as an explicit vendor error or as a silent
 *    redaction. The connector's `capability_limited` state, named here.
 *
 * Listed rather than pattern-matched on the substring "CAPABILITY": a code is
 * capability-class because somebody decided it is, and a `startsWith` would
 * silently enrol whatever a future vendor happens to name that way.
 */
const CAPABILITY_LIMITED_CODES: ReadonlySet<string> = new Set([
  "CAPABILITY_MISSING",
  "CAPABILITY_NOT_AVAILABLE",
  "SCOPE_MISSING",
  "PROTECTED_CUSTOMER_DATA_DENIED",
]);

/** What a CAPABILITY_LIMITED answer carries beyond the reason: which dataset
 *  the vendor withheld, and the connector's own text for what would grant it.
 *  Both come off the thrown error — this module never composes vendor copy. */
export interface CapabilityLimit {
  dataset: string;
  remediation: string;
}

/**
 * Pull the withheld dataset + remediation off a capability-class error.
 *
 * `dataset` is the field the connector already names it with — Shopify's scope
 * error says `dataset`, Mailchimp's and HubSpot's say `resource` — falling back
 * to the read that was refused, so the caller is never handed an empty string.
 *
 * `remediation` prefers an explicit `remediation` field and otherwise takes the
 * message, which every capability error builds to be read by an owner. Neither
 * field can carry a credential: each of these classes documents that it reports
 * only the rejection CLASS, never the offered value (rule 19).
 */
function capabilityLimitFrom(err: unknown, readName: string): CapabilityLimit {
  const e = (err ?? {}) as { dataset?: unknown; resource?: unknown; remediation?: unknown };
  const named = typeof e.dataset === "string" ? e.dataset : e.resource;
  return {
    dataset: typeof named === "string" && named.length > 0 ? named : readName,
    remediation:
      typeof e.remediation === "string" && e.remediation.length > 0
        ? e.remediation
        : err instanceof Error
          ? err.message
          : String(err),
  };
}

/** Every ADR-041 guard throws its own class for this — five classes, one code
 *  — because one package cannot export five `UnsafeBaseUrlError`s. */
const UNSAFE_BASE_URL_CODE = "UNSAFE_BASE_URL";

/**
 * Classify an error thrown while BUILDING a connector.
 *
 * A refused base URL is a configuration mistake on the row, not a transport
 * fault — the box never dialled anything. It degrades to ERP_NOT_CONNECTED so
 * the owner is told the connection needs fixing, and it is logged at error
 * level because, unlike a spent quota, somebody does have to act.
 *
 * WARP-2610 — on `code`, not on the class, for the same reason as above: this
 * named `UnsafeBaseUrlError` (QuickBooks Online) and `UnsafeAscendBaseUrlError`
 * only, so the Stripe, HubSpot, Mailchimp and Shopify guards reported a refused
 * host as a generic ERROR instead of a connection that needs fixing.
 */
function reasonForConnectorError(err: unknown, phase: string): string {
  const code = connectorErrorCode(err);
  if (code === CONNECTOR_BLOCKED_CODE) return "ERP_NOT_CONNECTED";
  if (code === UNSAFE_BASE_URL_CODE) {
    logger.error({ err, phase }, "erp connection names a destination we refuse to dial");
    return "ERP_NOT_CONNECTED";
  }
  logger.error({ err, phase }, "erp connector construction failed");
  return "ERROR";
}

/**
 * The cloud datasets the assistant may read, and the NAMED read query each one
 * runs (WARP-2497).
 *
 * ## Why a map and not an inversion of `READ_QUERIES`
 *
 * `dependsOnTables` would let this be derived, and for twenty of the
 * twenty-three names the derivation is unambiguous. It is not for `patient`,
 * which three queries depend on (`find_patient`, `get_patient`,
 * `get_recall_due`), so a generic inversion has to pick a winner — and picking
 * one silently is precisely the "guessing state" this codebase forbids. An
 * explicit table also makes the exposure decision reviewable: what the
 * assistant can read from a cloud account is this list, not "whatever the
 * registry happens to contain after the next connector lands".
 *
 * ## Why these ten
 *
 * They are exactly the datasets the three shipped cloud tracks declare in
 * `servesDatasets` (Stripe `invoice`/`charge`, HubSpot's five, Mailchimp's
 * three). The practice-management datasets are deliberately ABSENT: those are
 * PHI, they are reached through the dedicated `/erp/*` routes under
 * `erpConnectorReadGate`'s O-2 grant machinery, and routing them through a
 * chat tool would move a PHI decision into a keyword regex.
 *
 * The tool's own `enum` in `@droplet/tools-core` mirrors these keys, and
 * `cloud-dataset-tool.e2e.test.ts` asserts the two agree — a dataset added
 * here and not there is registered-but-unreachable, which is the bug class
 * `TOOL_ROUTES` exists to prevent.
 */
export const CLOUD_DATASET_READS: Readonly<Record<string, string>> = {
  // payments / accounting — Stripe
  charge: "get_recent_charges",
  invoice: "get_open_invoices",
  // CRM — HubSpot
  contact: "find_contact",
  company: "get_company",
  deal: "get_deals_by_stage",
  ticket: "get_tickets_by_status",
  engagement: "get_engagements",
  // marketing — Mailchimp
  campaign: "get_campaign_performance",
  audience_member: "get_audience_members",
  ecommerce_order: "get_ecommerce_orders",
};

/** The result of a cloud dataset read. `connected` and `reason` carry the same
 *  honest-degradation contract as every other read on this service: a
 *  capability gap reports `connected: true` with a reason, never an empty
 *  success that reads as "you have no charges". */
export interface DatasetQueryResult {
  connected: boolean;
  reason?: string;
  /** Present only with `reason: "CAPABILITY_LIMITED"` (WARP-2610). */
  capability?: CapabilityLimit;
  dataset: string;
  /** The provider the rows came from, or null when nothing is configured.
   *  Named so the assistant can attribute an answer to an account. */
  provider: string | null;
  rows: unknown[];
}

export interface ErpService {
  queryDataset(
    input: { dataset: string; params: Record<string, unknown> },
    user: ErpUser,
  ): Promise<DatasetQueryResult>;
  getSchedule(input: { date: string }, user: ErpUser): Promise<ScheduleResult>;
  searchPatients(input: { query: string }, user: ErpUser): Promise<PatientsResult>;
  getPatient(patientId: string, user: ErpUser): Promise<PatientResult>;
  getArSummary(user: ErpUser): Promise<ArSummaryResult>;
  getRecallDue(user: ErpUser): Promise<RecallResult>;
  createWriteRequest(
    input: CreateWriteRequestInput,
    user: ErpUser,
  ): Promise<NonNullable<WriteRequestRow>>;
  confirmWriteRequest(
    id: string,
    user: ErpUser,
  ): Promise<NonNullable<WriteRequestRow>>;
  getWriteRequest(
    id: string,
    user: ErpUser,
  ): Promise<NonNullable<WriteRequestRow>>;
}

export function createErpService(
  prisma: ErpPrisma,
  deps: ErpServiceDeps = {},
): ErpService {
  const connectorFor = deps.connectorFor ?? defaultConnectorFor;

  // WARP-2137 — give the provider factory a way to write rotated tokens back.
  // Intuit issues a NEW refresh token on every refresh and invalidates the old
  // one, so a connector that refreshes without persisting strands the
  // connection at the NEXT refresh — hours later, looking unrelated to the
  // read that actually caused it.
  //
  // Registered here rather than imported into erp-provider so that module keeps
  // its single job (build a connector) and takes no Prisma dependency. The
  // write is `updateMany` scoped to the row id: a connection deleted between
  // the refresh and this write matches nothing and is a no-op, rather than
  // recreating a token row for a connection the owner just disconnected.
  setCloudTokenWriter(async (connectionId, blob) => {
    await prisma.integrationConnection.updateMany({
      where: { id: connectionId },
      data: { providerTokensEnc: blob },
    });
  });

  function rowForProvider(provider: string): Promise<ConnRow | null> {
    return prisma.integrationConnection.findFirst({
      where: { provider },
    }) as Promise<ConnRow | null>;
  }

  /**
   * The ERP connection this service acts on, across BOTH tracks.
   *
   * Two single-provider lookups rather than one `provider: { in: [...] }`
   * query, because the shape stays a plain string — which keeps this readable
   * and keeps the query trivially indexable on `@@index([provider, status])`.
   *
   * Precedence: a CONNECTED row wins. Otherwise SQL first, then API. That
   * ordering means a deployment with only one row resolves exactly as it did
   * before this existed, while a box that has since been wired up on the REST
   * track is no longer shadowed by a stale, permanently-blocked SQL row.
   */
  async function eaglesoftRow(): Promise<ConnRow | null> {
    const sql = await rowForProvider(EAGLESOFT_PROVIDER);
    if (sql?.status === "CONNECTED") return sql;
    const api = await rowForProvider(EAGLESOFT_API_PROVIDER);
    if (api?.status === "CONNECTED") return api;
    // WARP-1964 — the export-drop track. Its provider keys are `<vendor>-export`
    // and the vendor set is open (an operator profile can add one), so this is
    // the one lookup that cannot be a single-provider equality: it is scoped to
    // the enumerated key list, which keeps `@@index([provider, status])` usable.
    const drop = await rowForExportProviders();
    if (drop?.status === "CONNECTED") return drop;
    // No connected row anywhere: fall back to whichever exists, preserving the
    // historical API-before-SQL ordering and appending export-drop after it.
    return api ?? drop ?? sql;
  }

  /**
   * The cloud connection that can answer for `dataset` (WARP-2497).
   *
   * Resolved through the provider REGISTRY rather than a hardcoded provider
   * list, so a fourth cloud track becomes readable by declaring its datasets
   * in its descriptor — there is no site here to forget. The descriptor is
   * reconciled against the connector's own `servesDatasets` by
   * `erp-provider.descriptor.test.ts`, so "the descriptor says so" and "the
   * track will actually serve it" cannot drift apart.
   *
   * A CONNECTED row wins, exactly as `eaglesoftRow()` decides. Otherwise the
   * first configured row is returned so the caller degrades with that row's
   * real reason (PROVISIONING, NEEDS_RECONNECT) instead of the flat
   * NOT_CONFIGURED that a null would produce — "reconnect Stripe" and "you
   * have no Stripe" are different sentences and the owner can only act on one.
   */
  async function cloudRowForDataset(dataset: string): Promise<ConnRow | null> {
    const providers = cloudProviderIds().filter((id) =>
      (providerDescriptor(id)?.datasets ?? []).includes(dataset as never),
    );
    if (providers.length === 0) return null;
    const connected = (await prisma.integrationConnection.findFirst({
      where: { provider: { in: providers as string[] }, status: "CONNECTED" },
    })) as ConnRow | null;
    if (connected) return connected;
    return (await prisma.integrationConnection.findFirst({
      where: { provider: { in: providers as string[] } },
    })) as ConnRow | null;
  }

  /** The export-drop connection row, preferring a CONNECTED one. */
  async function rowForExportProviders(): Promise<ConnRow | null> {
    const providers = exportProviders(loadOperatorExportProfiles().profiles);
    if (providers.length === 0) return null;
    const connected = (await prisma.integrationConnection.findFirst({
      where: { provider: { in: providers }, status: "CONNECTED" },
    })) as ConnRow | null;
    if (connected) return connected;
    return (await prisma.integrationConnection.findFirst({
      where: { provider: { in: providers } },
    })) as ConnRow | null;
  }

  function assertCanReadPhi(user: ErpUser): void {
    if (PHI_READ_ROLES.has(user.role)) return;
    // O-2: family-and-up WITH a grant. The tier check and the grant check are
    // both required — a grant on a guest is not reach, and a family tier
    // without one is today's denial.
    if (GRANTABLE_PHI_READ_ROLES.has(user.role) && user.connectorLevel) return;
    throw ErpError.forbidden();
  }
  function assertCanWrite(user: ErpUser): void {
    if (!WRITE_ROLES.has(user.role)) throw ErpError.forbidden();
    // WARP-1579 — the tier is necessary, not sufficient. An Admin-based role
    // may hold a deliberately READ-ONLY connector grant, and a grant level the
    // enforcement ignores is a false statement in the admin UI.
    //
    // SCOPE, honestly: this is a second line under `erpConnectorWriteGate`,
    // not an independent one. `connectorGrantLevel` is populated BY that gate,
    // so a future route registered WITHOUT it arrives here with the field
    // absent and this check cannot fire — the gate is the enforcement point,
    // and a new write route must register it. What this does catch is the
    // gate being kept but its refusal weakened, and any future caller that
    // resolves the grant itself and threads it in. (`assertCanReadPhi` has the
    // same shape and the same limit — `connectorLevel` likewise comes from the
    // read gate.) Kept because it costs nothing and pins the level's meaning
    // at the layer that owns the write.
    //
    // Only an EXPLICIT `read` refuses. Absent = nothing narrows (today's
    // world). Owner is never narrowed (§3's one bypass) — `assertCanReadPhi`
    // admits owner unconditionally too, and an owner locked out of their own
    // ERP by a stray grant row would be worse than the bug being fixed.
    if (user.role !== "owner" && user.connectorGrantLevel === "read") {
      throw ErpError.forbidden(
        "forbidden: this role's connector grant for the ERP integration is read-only",
      );
    }
  }

  /** Append-only audit (§14). `scope` MUST be PHI-free — tokens/ids only. */
  async function audit(
    conn: ConnRow | null,
    actor: string,
    action: string,
    scope: Prisma.InputJsonValue,
  ): Promise<void> {
    await prisma.erpAuditLog.create({
      data: {
        connectionId: conn?.id ?? EAGLESOFT_PROVIDER,
        actor,
        action,
        entity: "erp",
        scope,
      },
    });
  }

  /** Attempt a named read; degrade honestly when the connector is blocked. */
  async function runReadOrBlocked(
    conn: ConnRow | null,
    name: string,
    params: Record<string, unknown>,
  ): Promise<{
    connected: boolean;
    reason?: string;
    /** Present only alongside `reason: "CAPABILITY_LIMITED"` (WARP-2610). */
    capability?: CapabilityLimit;
    rows: unknown[];
  }> {
    if (!conn) return { connected: false, reason: "NOT_CONFIGURED", rows: [] };
    // WARP-2137 — construction is INSIDE the try. It can throw: a cloud row
    // naming a base URL we refuse to send a token to throws UnsafeBaseUrlError,
    // an Ascend row with no Organization-ID (or an unusable pageSize) throws
    // ConnectorBlockedError at construction, and a QuickBooks row with no
    // company id is refused by the factory. Built outside, every one of those
    // escaped this handler as an unhandled 500 rather than degrading honestly.
    let connector: Connector;
    try {
      connector = connectorFor(conn);
    } catch (err) {
      return { connected: false, reason: reasonForConnectorError(err, "construct"), rows: [] };
    }
    try {
      // Establish the session BEFORE reading. The REST track runs the
      // Authenticate handshake here and pins the route-map fingerprint; the SQL
      // track opens its pooled connection. Omitting this was invisible while
      // every track was stubbed — the read threw "blocked" either way — but a
      // box that is actually reachable needs a session first.
      //
      // One handshake per read, because the connector is built and closed per
      // call. Correct, and honest about cost: if that round-trip shows up under
      // real load, the fix is a pooled/cached session in the connector, not a
      // token cached out here where nothing would notice it expiring.
      await connector.connect();
      const rows = await connector.runRead(name, params);
      return { connected: true, rows };
    } catch (err) {
      // WARP-2107 — a capability gap is NOT a fault, and must not be reported
      // as one. This connection works perfectly and will never have that data:
      // a QuickBooks company has no appointments, a Dentrix export has no
      // vendor bills. Nothing an installer does changes that, so it gets its
      // own reason rather than the generic ERROR, and it is deliberately NOT
      // logged at error level — an operator chasing red logs would find a
      // healthy connection answering a question it was never asked to.
      //
      // `connected` stays TRUE here, which is the whole point: the alternative
      // (false + rows: []) is indistinguishable from "no invoices", which is a
      // confident false statement about money.
      if (err instanceof DatasetNotServedError) {
        return { connected: true, reason: "DATASET_NOT_SERVED", rows: [] };
      }
      const code = connectorErrorCode(err);
      if (code === CONNECTOR_BLOCKED_CODE) {
        return { connected: false, reason: "ERP_NOT_CONNECTED", rows: [] };
      }
      // WARP-2610 — a capability gap is the THIRD rendering, and the one this
      // ticket exists for: the connection is healthy, one dataset is refused,
      // and neither re-pasting a credential nor waiting changes it. Reported
      // with the connector's own remediation so the owner is told the thing
      // they can act on (the plan, the scope) rather than sent to fix a
      // working connection. Never `[]` — ADR-041's hard rule.
      if (code !== undefined && CAPABILITY_LIMITED_CODES.has(code)) {
        const capability = capabilityLimitFrom(err, name);
        // Not error level, for the same reason DATASET_NOT_SERVED is not.
        logger.info(
          { query: name, reason: "CAPABILITY_LIMITED", code, dataset: capability.dataset },
          "erp read stopped by a vendor capability limit",
        );
        return { connected: true, reason: "CAPABILITY_LIMITED", capability, rows: [] };
      }
      // WARP-2137 — the two cloud-track outcomes that are NOT faults and must
      // not collapse into the generic ERROR branch. Each needs its own
      // owner-facing state, because the actions they call for are opposite:
      // one resolves itself next period, the other never resolves without a
      // person.
      const cloudReason = code === undefined ? undefined : READ_REASON_BY_CODE.get(code);
      if (cloudReason) {
        // Deliberately not logged at error level, for the same reason
        // DATASET_NOT_SERVED is not: an operator scanning red logs would find a
        // connection that is working exactly as designed.
        logger.info({ query: name, reason: cloudReason }, "erp read stopped by connection state");
        return { connected: true, reason: cloudReason, rows: [] };
      }
      logger.error({ err, query: name }, "erp read failed");
      return { connected: false, reason: "ERROR", rows: [] };
    } finally {
      await connector.close().catch(() => {});
    }
  }

  return {
    async getSchedule({ date }, user) {
      assertCanReadPhi(user);
      const conn = await eaglesoftRow();
      const r = await runReadOrBlocked(conn, "get_schedule_today", scheduleDayBounds(date));
      await audit(conn, user.id, "read:schedule", { date });
      return {
        connected: r.connected,
        reason: r.reason,
        capability: r.capability,
        date,
        items: r.rows,
      };
    },

    async searchPatients({ query }, user) {
      assertCanReadPhi(user);
      // Reject empty/too-short terms so the query builder can never emit a
      // match-all LIKE '%' that dumps the whole patient table (PHI over-fetch).
      const term = query.trim();
      if (term.length < 2) {
        throw ErpError.validation("patient search term must be at least 2 characters");
      }
      const conn = await eaglesoftRow();
      const r = await runReadOrBlocked(conn, "find_patient", { query: term });
      // The raw search term can contain a name → keep it OUT of the audit scope
      // (redaction contract, review D-1). Length only.
      await audit(conn, user.id, "read:patients", { termLength: term.length });
      return { connected: r.connected, reason: r.reason, capability: r.capability, items: r.rows };
    },

    async getPatient(patientId, user) {
      assertCanReadPhi(user);
      const conn = await eaglesoftRow();
      const r = await runReadOrBlocked(conn, "get_patient", { patientId });
      // patientId is an internal key (not a name/DOB) → allowed in scope (§14).
      await audit(conn, user.id, "read:patient", { patientId });
      const patient = r.connected && r.rows.length > 0 ? r.rows[0] : null;
      return { connected: r.connected, reason: r.reason, capability: r.capability, patient };
    },

    async getArSummary(user) {
      assertCanReadPhi(user);
      const conn = await eaglesoftRow();
      const r = await runReadOrBlocked(conn, "get_ar_summary", {});
      await audit(conn, user.id, "read:ar-summary", {});
      const row =
        r.connected && r.rows.length > 0
          ? (r.rows[0] as { total_balance?: number; account_count?: number })
          : null;
      return {
        connected: r.connected,
        reason: r.reason,
        capability: r.capability,
        totalBalance: row?.total_balance ?? null,
        accountCount: row?.account_count ?? null,
      };
    },

    async queryDataset({ dataset, params }, user) {
      // NOT `assertCanReadPhi`. These are business records — money, pipeline,
      // campaigns — and the PHI ladder is about patients. Reusing it would
      // have been the easy line to write and would have made a Stripe charge
      // inherit a dental patient's access rules, which is neither stricter nor
      // looser in a way anyone could reason about, just wrong.
      if (!CLOUD_DATASET_READ_ROLES.has(user.role)) throw ErpError.forbidden();

      // An unrecognised dataset is a VALIDATION error, not an empty result.
      // The tool advertises a closed enum, so anything else means the model
      // invented a name — and answering "no rows" to "how many refunds did we
      // issue" when `refund` is simply not wired would be a confident false
      // statement about money.
      const readName = CLOUD_DATASET_READS[dataset];
      if (!readName) throw ErpError.validation(`unknown dataset "${dataset}"`);

      const conn = await cloudRowForDataset(dataset);
      const r = await runReadOrBlocked(conn, readName, params);
      // Audit the SHAPE, never the values. `params` can carry a customer name
      // or an email address (`find_contact`'s `query`), and §14's rule is that
      // an audit row proves an access happened without becoming a second copy
      // of the data. Keys only — asserted in erp.service.dataset.test.ts.
      await audit(conn, user.id, `read:dataset:${dataset}`, {
        dataset,
        read: readName,
        paramKeys: Object.keys(params).sort(),
      });
      return {
        connected: r.connected,
        reason: r.reason,
        // WARP-2610 — the withheld resource + the connector's remediation, so
        // the caller (and the chat tool that forwards this body verbatim) can
        // say WHICH dataset the plan or scope withholds and what would grant
        // it. Absent for every other reason; `undefined` never reaches JSON.
        capability: r.capability,
        dataset,
        provider: conn?.provider ?? null,
        rows: r.rows,
      };
    },

    async getRecallDue(user) {
      assertCanReadPhi(user);
      const conn = await eaglesoftRow();
      const r = await runReadOrBlocked(conn, "get_recall_due", {});
      await audit(conn, user.id, "read:recall-due", {});
      return { connected: r.connected, reason: r.reason, capability: r.capability, items: r.rows };
    },

    async createWriteRequest({ command, params }, user) {
      assertCanWrite(user);
      const conn = await eaglesoftRow();
      if (!conn) throw ErpError.notConfigured(EAGLESOFT_PROVIDER);
      // Per-practice opt-in gate FIRST (invariant 1): a valid command with
      // writes off is still refused.
      if (!conn.writeEnabled) throw ErpError.writeNotEnabled();
      if (!WRITE_COMMAND_NAMES.has(command)) {
        throw ErpError.validation(`unknown write command "${command}"`);
      }
      // Stage the intent only — nothing touches Eaglesoft until a human
      // confirms (brief §11.1 step 1). The connector is not even built here.
      const row = await prisma.erpWriteRequest.create({
        data: {
          connectionId: conn.id,
          command,
          params: params as Prisma.InputJsonValue,
          status: "PENDING_CONFIRMATION",
          requestedBy: user.id,
        },
      });
      await audit(conn, user.id, "write:request", {
        command,
        requestId: row.id,
      });
      return row;
    },

    async confirmWriteRequest(id, user) {
      assertCanWrite(user);
      const existing = await prisma.erpWriteRequest.findUnique({ where: { id } });
      if (!existing) throw ErpError.notFound("write request");
      // No double-apply: only a still-pending request can be confirmed.
      if (existing.status !== "PENDING_CONFIRMATION") {
        throw ErpError.invalidState(existing.status, "confirm");
      }

      const conn = await eaglesoftRow();
      // Re-check the connection + the per-practice write kill-switch at APPLY
      // time (invariant 1) — the request may have been staged before writes
      // were turned off, or the connection removed. Guard BEFORE the APPLYING
      // transition so neither case can strand the request (clean 409 instead).
      if (!conn) throw ErpError.notConfigured(EAGLESOFT_PROVIDER);
      if (!conn.writeEnabled) throw ErpError.writeNotEnabled();
      // Human confirmation recorded (brief §11.1 step 2). Move to APPLYING.
      await prisma.erpWriteRequest.update({
        where: { id },
        data: { status: "APPLYING", confirmedBy: user.id },
      });
      await audit(conn, user.id, "write:confirm", {
        requestId: id,
        command: existing.command,
      });

      // Apply inside the connector's own transaction (brief §11.1 step 3). The
      // connector manages its connection; in this slice applyWrite is stubbed
      // and rejects blocked → we record FAILED, never a fake APPLIED.
      let status: "APPLIED" | "FAILED" = "FAILED";
      let discrepancy: Prisma.InputJsonValue | null = null;

      // WARP-2137 — same construction hazard as the read path, with a worse
      // consequence here: built outside the try, a misconfigured cloud row
      // threw out of `confirmWriteRequest` entirely, so the request row never
      // reached a terminal status and the caller got a 500 instead of the
      // FAILED it is designed to record. A connector that cannot be built is
      // just an apply that did not happen.
      let connector: Connector | null = null;
      try {
        connector = connectorFor(conn as ConnRow);
      } catch (err) {
        if (err instanceof ConnectorBlockedError) {
          logger.info(
            { requestId: id },
            "write apply blocked at construction — recorded FAILED, never fake APPLIED",
          );
        } else {
          // Not a discrepancy in the data sense; the apply never started. The
          // message is kept because an operator debugging a refused base URL
          // needs to see which row named it.
          reasonForConnectorError(err, "confirm-write");
          discrepancy = {
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }

      if (connector) {
        try {
          // Same reason as the read path: the connector needs a live session
          // before it can apply anything.
          await connector.connect();
          await connector.applyWrite(
            existing.command,
            existing.params as Record<string, unknown>,
          );
          // A verify-read (brief §11.1 step 4) lands with the live path; a clean
          // apply maps to APPLIED here.
          status = "APPLIED";
        } catch (err) {
          if (err instanceof ConnectorBlockedError) {
            logger.info(
              { requestId: id },
              "write apply blocked (DB-independent slice) — recorded FAILED, never fake APPLIED",
            );
          } else {
            logger.error({ err, requestId: id }, "write apply failed");
            discrepancy = {
              message: err instanceof Error ? err.message : String(err),
            };
          }
        } finally {
          await connector.close().catch(() => {});
        }
      }

      const updated = await prisma.erpWriteRequest.update({
        where: { id },
        data: {
          status,
          confirmedBy: user.id,
          discrepancy: discrepancy === null ? Prisma.JsonNull : discrepancy,
        },
      });
      await audit(conn, user.id, "write:apply-result", {
        requestId: id,
        status,
      });
      return updated;
    },

    async getWriteRequest(id, user) {
      assertCanWrite(user);
      const row = await prisma.erpWriteRequest.findUnique({ where: { id } });
      if (!row) throw ErpError.notFound("write request");
      return row;
    },
  };
}
