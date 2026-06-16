/**
 * WARP (SCIM directory sync) — SCIM 2.0 resource (de)serialization + filter.
 *
 * Pure, DB-free helpers implementing the wire shapes Okta's SCIM client
 * exchanges with /scim/v2/* (RFC 7643 resources, RFC 7644 messages). Keeping
 * the SCIM JSON contract in one audited module (rather than a heavyweight
 * SCIM library) mirrors the `sso-oidc.service.ts` "single boundary" posture:
 * the surface is small, every field is explicit, and the route stays thin.
 *
 * We implement the SUBSET Okta actually uses for User/Group provisioning:
 *   - core User attrs: userName, name.{givenName,familyName}, displayName,
 *     emails[], active, externalId, meta.
 *   - ListResponse envelope + Error envelope.
 *   - the `userName eq "..."` filter (Okta's "does this user already exist?"
 *     probe before a create — the linchpin of idempotency).
 */

/** Canonical SCIM 2.0 schema URNs (RFC 7643 §8.7, RFC 7644 §3.4 / §3.12). */
export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_PATCH_OP_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** SCIM content type (RFC 7644 §3.1). */
export const SCIM_CONTENT_TYPE = "application/scim+json";

/**
 * Typed SCIM error — carries the HTTP status the route should send and the
 * SCIM Error envelope to render. Mirrors the codebase's typed-error idiom
 * (router-error.ts): a discriminated `Error` subclass with a `toScim()`
 * serializer + static factories, so handlers `throw ScimError.notFound(...)`
 * and a single catch renders the envelope.
 */
export class ScimError extends Error {
  public readonly status: number;
  public readonly scimType?: string;

  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.name = "ScimError";
    this.status = status;
    this.scimType = scimType;
  }

  toScim(): ScimErrorBody {
    return scimError(this.status, this.message, this.scimType);
  }

  static badRequest(detail: string, scimType = "invalidValue"): ScimError {
    return new ScimError(400, detail, scimType);
  }
  static notFound(detail = "Resource not found"): ScimError {
    return new ScimError(404, detail);
  }
  static conflict(detail: string): ScimError {
    return new ScimError(409, detail, "uniqueness");
  }
}

export interface ScimEmail {
  value: string;
  primary?: boolean;
  type?: string;
}

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  displayName?: string;
  name?: { givenName?: string; familyName?: string };
  emails?: ScimEmail[];
  active: boolean;
  meta?: { resourceType: string; created?: string; lastModified?: string; location?: string };
}

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export interface ScimErrorBody {
  schemas: string[];
  status: string;
  detail: string;
  scimType?: string;
}

/** The minimal local-user shape needed to render a SCIM User. */
export interface LocalUserForScim {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
  createdAt: Date;
  updatedAt: Date;
}

/** Split a display name into (givenName, familyName) best-effort. */
function splitName(displayName: string): { givenName?: string; familyName?: string } {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return {};
  if (parts.length === 1) return { givenName: parts[0] };
  return { givenName: parts[0], familyName: parts.slice(1).join(" ") };
}

/**
 * Render a local User row as a SCIM User resource. The SCIM resource `id` IS
 * the local `User.id` UUID (WARP-485 — the canonical key everywhere), so a
 * later GET/PATCH/PUT/DELETE by that id resolves the same row. `active`
 * reflects the soft-deactivation status (DEACTIVATED → active:false).
 */
export function toScimUser(user: LocalUserForScim): ScimUserResource {
  const userName = user.email ?? user.username;
  const resource: ScimUserResource = {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    userName,
    displayName: user.displayName,
    name: splitName(user.displayName),
    active: user.directoryStatus === "ACTIVE",
    meta: {
      resourceType: "User",
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
      location: `/scim/v2/Users/${user.id}`,
    },
  };
  if (user.email) {
    resource.emails = [{ value: user.email, primary: true, type: "work" }];
  }
  return resource;
}

/** Wrap resources in the SCIM ListResponse envelope (RFC 7644 §3.4.2). */
export function toScimListResponse<T>(
  resources: T[],
  totalResults: number,
  startIndex = 1,
): ScimListResponse<T> {
  return {
    schemas: [SCIM_LIST_RESPONSE_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/** Build a SCIM Error envelope (RFC 7644 §3.12). `status` is a STRING. */
export function scimError(status: number, detail: string, scimType?: string): ScimErrorBody {
  const body: ScimErrorBody = {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    detail,
  };
  if (scimType) body.scimType = scimType;
  return body;
}

/** Normalize an email to the directory login key form (#374 trim+lowercase). */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Parse Okta's `userName eq "<value>"` filter. This is the ONLY filter we
 * support — it's the existence probe Okta runs before a create, and the basis
 * for idempotent provisioning. Returns the NORMALIZED email, or null for any
 * other filter shape (the route renders that as an empty ListResponse, which
 * is the correct "no match" answer rather than a 400 that would wedge Okta).
 */
export function parseUserNameEqFilter(filter: string | undefined | null): string | null {
  if (!filter) return null;
  // attribute (userName) — case-insensitive — operator eq — quoted value.
  const m = filter.match(/^\s*userName\s+eq\s+"([^"]*)"\s*$/i);
  if (!m) return null;
  const value = normalizeEmail(m[1] ?? "");
  return value.length > 0 ? value : null;
}

/** Normalized result of reading a SCIM User write payload. */
export interface ParsedScimUser {
  email: string;
  displayName: string;
  active: boolean;
  externalId?: string;
}

/**
 * Read a SCIM User write payload (POST create / PUT replace) into a
 * normalized local shape. `userName` is the email (trim+lowercased to the
 * directory login key). `active` defaults true. displayName resolves to an
 * explicit displayName, else assembled name parts, else the email. Throws a
 * typed ScimError(400) when userName is missing/blank — a SCIM User without
 * one can't key a local row.
 */
export function parseScimUser(body: unknown): ParsedScimUser {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawUserName = typeof b.userName === "string" ? b.userName : "";
  const email = normalizeEmail(rawUserName);
  if (email.length === 0) {
    throw ScimError.badRequest("userName is required", "invalidValue");
  }

  const name = (b.name ?? {}) as Record<string, unknown>;
  const givenName = typeof name.givenName === "string" ? name.givenName.trim() : "";
  const familyName = typeof name.familyName === "string" ? name.familyName.trim() : "";
  const explicitDisplay = typeof b.displayName === "string" ? b.displayName.trim() : "";
  const assembled = [givenName, familyName].filter((s) => s.length > 0).join(" ");
  const displayName = explicitDisplay || assembled || email;

  // `active` defaults to true when absent; only an explicit boolean false
  // deactivates (a non-boolean is ignored → stays active).
  const active = typeof b.active === "boolean" ? b.active : true;

  const externalId = typeof b.externalId === "string" && b.externalId.length > 0 ? b.externalId : undefined;

  return { email, displayName, active, externalId };
}
