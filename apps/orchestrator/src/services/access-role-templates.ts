/**
 * WARP-2738 / ADR-032 (RBAC v2) — the ROLE TEMPLATE catalogue.
 *
 * ADR-032 shipped the engine and nothing to start from: a custom role is an
 * AccessRole row whose `startingPoint` is one of the three assignable tiers
 * plus grant rows on four axes, and an operator opening the Access panel got
 * an empty list and a blank builder. These eight templates are the starting
 * points — each one instantiates a REAL, fully editable AccessRole through
 * the existing guarded write path (POST /api/access/roles), and is an
 * ordinary row the moment it lands.
 *
 * WHY CODE AND NOT ROWS
 *
 *   1. There is nowhere to put them. `__tests__/access-role.schema.test.ts`
 *      asserts the RBAC migration SQL contains no INSERT / UPDATE / DROP /
 *      DELETE, so a template cannot be a seeded row without breaking the one
 *      test that keeps the schema migration data-free. Seeding at boot
 *      instead would be worse: the row is then something an operator can edit
 *      or delete and a later boot silently re-creates or does not.
 *
 *   2. A template is not a role. A seeded row would show up in the roles
 *      list, count people, be assignable, and need archive semantics — eight
 *      pieces of live configuration nobody chose. A template is a BUTTON that
 *      produces a role; it holds no id, no people and no history.
 *
 *   3. Every value here is a claim ABOUT the catalogue in `access-catalog.ts`
 *      (which levels a tier may hold), the registry in
 *      `../modules/module-registry.js` (which modules require which, which
 *      tool domains a module claims) and the tools-core domain vocabulary.
 *      Code-resident means those claims are type-checked and unit-tested in
 *      the same commit as the catalogue they describe — `access-role-
 *      templates.test.ts` runs every template through the SAME clamps the
 *      server applies at write time, so a floor change or a new ModuleId goes
 *      red here instead of shipping a preset that quietly clamps down. A row
 *      in Postgres has no such check.
 *
 * WHAT A TEMPLATE MUST GET RIGHT
 *
 * A role WITH grants resolves to chat@act plus ONLY its explicit grants —
 * `fullCatalogFeatures(tier)` runs exclusively on the `accessRoleId === null`
 * branch of effective-access.service.ts. Templates are therefore ADDITIVE
 * FROM ZERO: anything not enumerated below is not held. A missing grant is a
 * missing capability, not an inherited one.
 *
 * Four constraints the server applies to whatever we send, all of them SILENT
 * (they clamp, they do not refuse — routes/access.ts keeps that contract on
 * every axis), which is why the test file re-runs them rather than trusting
 * this table to be right:
 *
 *   • `clampLevel(startingPoint, moduleId, level)` — a level above the tier's
 *     §9 ceiling is clamped DOWN. `money` offers no `act` and floors `manage`
 *     at admin; `managed_switch` likewise; `network` floors both writes at
 *     admin; `team_chat` offers no `manage`. Over-asking stores a smaller
 *     grant than the card advertises, so no template over-asks.
 *   • `MODULE_REQUIRES` (one edge today: docs → files) is applied per-person
 *     at resolve time. A template granting `docs` without `files` loses docs.
 *   • `tierReachableDomains(tier)` — family and guest lose `team_chat` as a
 *     TOOL domain entirely (both its tools are `requiresWrite`), so no
 *     family/guest template carries that tool grant even though all of them
 *     grant the team_chat FEATURE.
 *   • `mayOperateLocks` is ANDed away unless a `smart_home` feature grant
 *     rides in the same payload.
 *
 * TOOL LEVELS ARE TIER-DEPENDENT, AND THAT IS WHY THEY DIFFER HERE.
 * `tool-access.service.ts` only reads `level === "use"` inside
 * `tierKeepsWriteTools`, which admits owner and admin ONLY. On a family- or
 * guest-based role `use` and `view` are the same grant, so those templates ask
 * for `view` — the honest value — and the three admin-based ones ask for `use`
 * where the person is expected to act.
 *
 * NO CONNECTOR GRANTS, ANYWHERE. Provider slugs (`quickbooks`, `stripe`, an
 * on-prem practice-management vendor) are box-specific; a template naming one
 * this box has not configured would store dead config that the roles list then
 * advertises as reach. The operator adds connector access after creating, in
 * the builder, against the providers actually connected. This also sidesteps
 * `clampConnectorLevel`'s guest rule, which drops the row entirely.
 *
 * NO USAGE CAPS, ANYWHERE. `llmDailyMessageCap` is stored and rendered but not
 * enforced (routes/llm.ts, D-7), so a template shipping one would advertise a
 * limit the box does not keep. All three usage fields stay null; the operator
 * sets them deliberately or not at all.
 */
import type { ToolDomain } from "@droplet/tools-core";
import type { AssignableRole } from "./role-mutation-guard.service.js";
import type {
  ConnectorLevel,
  FeatureLevel,
  GateableModuleId,
  ToolLevel,
} from "./access-catalog.js";

/** The grantable tool-domain vocabulary as a TYPE — the tools-core union minus
 *  `erp`, mirroring GRANTABLE_TOOL_DOMAINS (connector reach is the connectors
 *  axis, never a tool grant). Derived, never restated. */
export type GrantableToolDomain = Exclude<ToolDomain, "erp">;

export interface RoleTemplateFeatureGrant {
  readonly moduleId: GateableModuleId;
  readonly level: FeatureLevel;
}

export interface RoleTemplateToolGrant {
  readonly domain: GrantableToolDomain;
  readonly level: ToolLevel;
}

export interface RoleTemplateConnectorGrant {
  readonly provider: string;
  readonly level: ConnectorLevel;
}

/**
 * One starting point. The field set is deliberately the AccessRole payload's
 * field set (minus the server-derived slug/id/createdBy) so
 * {@link roleTemplateCreatePayload} is a rename-free projection and a new
 * payload field cannot be forgotten here.
 */
export interface RoleTemplate {
  /** Stable kebab-case identifier. Referenced by the dashboard and written
   *  into the creation activity's `refs`, so it is an API surface: rename a
   *  template's `name` freely, never its `id`. */
  readonly id: string;
  /** Becomes AccessRole.name (≤ 80 chars; the server derives the slug). */
  readonly name: string;
  /** Becomes AccessRole.description (≤ 500 chars). Written for the operator
   *  choosing between templates — it says what the profile is FOR and, where
   *  a grant is a policy choice rather than a tier limit, says so. */
  readonly description: string;
  readonly startingPoint: AssignableRole;
  readonly featureGrants: readonly RoleTemplateFeatureGrant[];
  readonly toolGrants: readonly RoleTemplateToolGrant[];
  /** Always empty — see the file header. Kept as a field rather than dropped
   *  so the shape stays the payload's shape and the test can pin the decision. */
  readonly connectorGrants: readonly RoleTemplateConnectorGrant[];
  readonly cloudModelsAllowed: boolean;
  readonly mayOperateLocks: boolean;
  /** BigInt as a decimal string — the WARP-455 wire convention the create
   *  route parses with `BigInt(...)`. Null on every template. */
  readonly storageQuotaBytes: string | null;
  readonly maxUploadSizeMb: number | null;
  readonly llmDailyMessageCap: number | null;
}

/**
 * The catalogue, in presentation order.
 *
 * `as const satisfies` rather than a plain annotation: the literal types are
 * what give {@link RoleTemplateId} a real union (BUSINESS_TYPES gets its id
 * union free from a Prisma enum; these ids have no enum behind them), while
 * `satisfies` still type-checks every module id, domain and level against the
 * live vocabularies.
 */
export const ROLE_TEMPLATES = [
  {
    id: "front-desk",
    name: "Front Desk",
    description:
      "Reception and front-of-house: the appointment book, the customer record, the shared inbox, the phone and the reference library. Broad reach across the day, and nothing that touches the ledger, the cameras or the network. Family-based, so the assistant answers with read-only tools no matter how the tool grants are set.",
    startingPoint: "family",
    featureGrants: [
      { moduleId: "files", level: "act" },
      { moduleId: "docs", level: "act" },
      { moduleId: "calendar", level: "manage" },
      { moduleId: "contacts", level: "act" },
      { moduleId: "crm", level: "act" },
      { moduleId: "email", level: "act" },
      { moduleId: "knowledge", level: "view" },
      { moduleId: "team_chat", level: "act" },
      { moduleId: "voice", level: "act" },
    ],
    toolGrants: [
      { domain: "files", level: "view" },
      { domain: "calendar", level: "view" },
      { domain: "reminders", level: "view" },
      { domain: "notifications", level: "view" },
      { domain: "email", level: "view" },
      { domain: "crm", level: "view" },
      { domain: "memory", level: "view" },
    ],
    connectorGrants: [],
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
  },
  {
    id: "clinical-staff",
    name: "Clinical Staff",
    description:
      "The hands-on team — hygienists, technicians, assistants. The schedule, the reference library, room-to-room messages and the voice assistant, plus read access to shared files and documents. Nothing financial, nothing commercial, no cameras and no network. Family-based, so the assistant answers with read-only tools.",
    startingPoint: "family",
    featureGrants: [
      { moduleId: "files", level: "view" },
      { moduleId: "docs", level: "view" },
      { moduleId: "calendar", level: "act" },
      { moduleId: "contacts", level: "view" },
      { moduleId: "knowledge", level: "act" },
      { moduleId: "team_chat", level: "act" },
      { moduleId: "voice", level: "act" },
    ],
    toolGrants: [
      { domain: "files", level: "view" },
      { domain: "calendar", level: "view" },
      { domain: "reminders", level: "view" },
      { domain: "notifications", level: "view" },
      { domain: "memory", level: "view" },
    ],
    connectorGrants: [],
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
  },
  {
    id: "office-manager",
    name: "Office Manager",
    description:
      "Runs the practice end to end, and the only non-owner profile that holds Money at manage — a level the catalogue floors at the admin tier. Cameras and Network sit at view ON PURPOSE: an admin-based role could hold manage on both, so that is a policy choice, not a limit, and you can raise it if this person also runs the hardware. Admin is also the only base whose assistant gets write tools at all.",
    startingPoint: "admin",
    featureGrants: [
      { moduleId: "files", level: "manage" },
      { moduleId: "docs", level: "manage" },
      { moduleId: "email", level: "manage" },
      { moduleId: "calendar", level: "manage" },
      { moduleId: "contacts", level: "manage" },
      { moduleId: "crm", level: "manage" },
      { moduleId: "money", level: "manage" },
      { moduleId: "projects", level: "manage" },
      { moduleId: "knowledge", level: "manage" },
      { moduleId: "voice", level: "manage" },
      { moduleId: "cameras", level: "view" },
      { moduleId: "network", level: "view" },
      { moduleId: "team_chat", level: "act" },
    ],
    toolGrants: [
      { domain: "files", level: "use" },
      { domain: "email", level: "use" },
      { domain: "calendar", level: "use" },
      { domain: "reminders", level: "use" },
      { domain: "notifications", level: "use" },
      { domain: "crm", level: "use" },
      { domain: "pm", level: "use" },
      { domain: "memory", level: "use" },
      { domain: "money", level: "use" },
      { domain: "team_chat", level: "use" },
      { domain: "business", level: "use" },
      { domain: "data", level: "use" },
    ],
    connectorGrants: [],
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
  },
  {
    id: "bookkeeper",
    name: "Bookkeeper",
    description:
      "The books, not the practice. Money at manage — which the catalogue floors at admin, so this profile has to be admin-based — plus the files and documents the ledger work runs on, and read-only sight of customers and the calendar for context. No cameras, no network, no devices. Add the ledger connector after creating: provider access is per-box and no template can guess it.",
    startingPoint: "admin",
    featureGrants: [
      { moduleId: "money", level: "manage" },
      { moduleId: "files", level: "act" },
      { moduleId: "docs", level: "act" },
      { moduleId: "crm", level: "view" },
      { moduleId: "contacts", level: "view" },
      { moduleId: "calendar", level: "view" },
      { moduleId: "team_chat", level: "act" },
    ],
    toolGrants: [
      { domain: "money", level: "use" },
      { domain: "files", level: "view" },
      { domain: "crm", level: "view" },
      { domain: "business", level: "view" },
      { domain: "data", level: "view" },
    ],
    connectorGrants: [],
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
  },
  {
    id: "it-facilities",
    name: "IT & Facilities",
    description:
      "The only profile that touches the router, the switch, the cameras and the locks — all four floor at or need the admin tier. Lock operation is ON, which the server accepts only because Devices is granted in the same payload; remove Devices later and locks switch themselves off. Deliberately thin on the business side: files at view, no mailbox, no ledger, no customer record.",
    startingPoint: "admin",
    featureGrants: [
      { moduleId: "network", level: "manage" },
      { moduleId: "managed_switch", level: "manage" },
      { moduleId: "cameras", level: "manage" },
      { moduleId: "smart_home", level: "manage" },
      { moduleId: "files", level: "view" },
      { moduleId: "voice", level: "view" },
      { moduleId: "team_chat", level: "act" },
    ],
    toolGrants: [
      { domain: "network", level: "use" },
      { domain: "switch", level: "use" },
      { domain: "cameras", level: "use" },
      { domain: "smart-home", level: "use" },
      { domain: "files", level: "view" },
      { domain: "system", level: "use" },
      { domain: "data", level: "view" },
    ],
    connectorGrants: [],
    cloudModelsAllowed: false,
    mayOperateLocks: true,
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
  },
  {
    id: "marketing-outreach",
    name: "Marketing & Outreach",
    description:
      "Campaigns, recalls and the pipeline: customers, contacts, the outbound mailbox, the shared drive, documents and the calendar. Commercial reach without the ledger, the cameras or the network. Family-based, so the assistant answers with read-only tools — drafting happens in the surfaces, not through the model.",
    startingPoint: "family",
    featureGrants: [
      { moduleId: "crm", level: "act" },
      { moduleId: "contacts", level: "act" },
      { moduleId: "email", level: "act" },
      { moduleId: "files", level: "act" },
      { moduleId: "docs", level: "act" },
      { moduleId: "calendar", level: "act" },
      { moduleId: "knowledge", level: "view" },
      { moduleId: "team_chat", level: "act" },
    ],
    toolGrants: [
      { domain: "crm", level: "view" },
      { domain: "email", level: "view" },
      { domain: "files", level: "view" },
      { domain: "calendar", level: "view" },
      { domain: "reminders", level: "view" },
      { domain: "notifications", level: "view" },
      { domain: "memory", level: "view" },
    ],
    connectorGrants: [],
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
  },
  {
    id: "read-only-auditor",
    name: "Read-only Auditor",
    description:
      "An outside accountant, compliance reviewer or consultant. Guest-based, which makes read-only STRUCTURAL rather than a setting: the tier cannot hold act or manage on anything except Voice and Messages, so no later edit widens this into a writing role by accident. Carries no Money grant on purpose — /api/money admits family and up, so a Money card here would advertise reach the API refuses.",
    startingPoint: "guest",
    featureGrants: [
      { moduleId: "files", level: "view" },
      { moduleId: "docs", level: "view" },
      { moduleId: "crm", level: "view" },
      { moduleId: "calendar", level: "view" },
      { moduleId: "contacts", level: "view" },
      { moduleId: "knowledge", level: "view" },
      { moduleId: "projects", level: "view" },
      { moduleId: "team_chat", level: "view" },
    ],
    toolGrants: [
      { domain: "files", level: "view" },
      { domain: "crm", level: "view" },
      { domain: "calendar", level: "view" },
      { domain: "reminders", level: "view" },
      { domain: "notifications", level: "view" },
      { domain: "memory", level: "view" },
      { domain: "pm", level: "view" },
    ],
    connectorGrants: [],
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
  },
  {
    id: "contractor-temp",
    name: "Contractor / Temp",
    description:
      "A locum, a relief hire or a vendor on site for the week — the smallest surface that is still useful. The shared drive and the calendar at view, plus Messages and Voice so they can be reached and can ask the assistant. Guest-based: view is the ceiling everywhere else, because those two are the only levels the guest tier leaves un-floored.",
    startingPoint: "guest",
    featureGrants: [
      { moduleId: "files", level: "view" },
      { moduleId: "calendar", level: "view" },
      { moduleId: "team_chat", level: "act" },
      { moduleId: "voice", level: "act" },
    ],
    toolGrants: [
      { domain: "files", level: "view" },
      { domain: "calendar", level: "view" },
      { domain: "reminders", level: "view" },
      { domain: "notifications", level: "view" },
    ],
    connectorGrants: [],
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
  },
] as const satisfies readonly RoleTemplate[];

/** The template id vocabulary — derived from the catalogue, never restated. */
export type RoleTemplateId = (typeof ROLE_TEMPLATES)[number]["id"];

export const ROLE_TEMPLATE_BY_ID: ReadonlyMap<RoleTemplateId, RoleTemplate> = new Map(
  ROLE_TEMPLATES.map((t) => [t.id, t] as const),
);

/** Runtime membership test for a template id (route param validation). */
export function isRoleTemplateId(v: string): v is RoleTemplateId {
  return ROLE_TEMPLATE_BY_ID.has(v as RoleTemplateId);
}

/**
 * The AccessRole create payload — field-for-field the body
 * `rolePayloadSchema` (routes/access.ts) parses on the non-duplicate branch
 * of POST /api/access/roles.
 *
 * Declared here so the route can instantiate a template without knowing the
 * catalogue's internal shape, and so a change to the payload contract breaks
 * this file at compile time rather than at request time. `description` is
 * nullable but REQUIRED (zod `.nullable()`, not `.optional()`) and
 * `storageQuotaBytes` is a decimal STRING, both matching the schema.
 */
export interface AccessRoleCreatePayload {
  name: string;
  description: string | null;
  startingPoint: AssignableRole;
  storageQuotaBytes: string | null;
  maxUploadSizeMb: number | null;
  llmDailyMessageCap: number | null;
  cloudModelsAllowed: boolean;
  mayOperateLocks: boolean;
  featureGrants: Array<{ moduleId: GateableModuleId; level: FeatureLevel }>;
  toolGrants: Array<{ domain: GrantableToolDomain; level: ToolLevel }>;
  connectorGrants: Array<{ provider: string; level: ConnectorLevel }>;
}

/**
 * Project a template onto the create payload.
 *
 * Returns FRESH, mutable arrays and objects every call: the catalogue above
 * is shared process-wide, and the create path hands its payload to
 * `normalizeGrants` and then to Prisma. A caller that spread the frozen
 * literals straight through would be one `.push()` away from mutating the
 * catalogue for every subsequent request.
 *
 * Deliberately NOT a clamp: the payload goes through the route's own
 * `normalizeGrants` like any other request body, because the server re-clamp
 * is the boundary and a template must not get a private path around it. The
 * templates are authored so the clamp is a no-op — `access-role-
 * templates.test.ts` is what proves that, and what goes red if a floor moves.
 */
export function roleTemplateCreatePayload(template: RoleTemplate): AccessRoleCreatePayload {
  return {
    name: template.name,
    description: template.description,
    startingPoint: template.startingPoint,
    storageQuotaBytes: template.storageQuotaBytes,
    maxUploadSizeMb: template.maxUploadSizeMb,
    llmDailyMessageCap: template.llmDailyMessageCap,
    cloudModelsAllowed: template.cloudModelsAllowed,
    mayOperateLocks: template.mayOperateLocks,
    featureGrants: template.featureGrants.map((g) => ({ moduleId: g.moduleId, level: g.level })),
    toolGrants: template.toolGrants.map((g) => ({ domain: g.domain, level: g.level })),
    connectorGrants: template.connectorGrants.map((g) => ({
      provider: g.provider,
      level: g.level,
    })),
  };
}
