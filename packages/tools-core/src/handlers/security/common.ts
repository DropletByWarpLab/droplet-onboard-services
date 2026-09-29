/**
 * WARP-2979 (ADR-059 P4 §6.12) — what the read-only `security` tools (P4's
 * four, and P5's `security_explain_pattern`) share: argument checks, and turning the assistant routes' answers into a
 * `ToolResult`. Declares no tool (the route manifest gate skips it); each
 * handler makes its own `ctx.http.orchestrator.get(…)` so that gate sees the
 * hop in the handler's source.
 *
 * DS-005 and the whitelisting of every field live in the ORCHESTRATOR
 * (routes/security-assistant.ts): the routes resolve the person the
 * assistant acts for from `X-Nextcloud-User`, which the mcp-server stamps on
 * every orchestrator call. The handlers never read `ctx.userId` — its shape
 * depends on the transport (a username on stdio, a User.id over HTTP,
 * WARP-3099) — and never `ctx.prisma`, which would be a second copy of the
 * visibility rules in another package.
 *
 * Refusals are honest and never an empty list:
 *   · 404 `module_disabled` → SECURITY_UNAVAILABLE ("switched off, or this
 *     person can't use it" — one answer for every refusal);
 *   · (WARP-2980, the fifth tool) 404 PLACE_NOT_FOUND — a missing or hidden
 *     area or camera, one answer for both — and 409 PATTERNS_NOT_READY
 *     ("not learned yet", with the route's reason);
 *   · 400 → BAD_REQUEST with the route's message; NO_SITE_TIMEZONE asks for
 *     exact times;
 *   · 503, any other status, or no answer at all → SECURITY_UNREACHABLE.
 *
 * The vocabularies below are restated rather than imported from
 * @prisma/client (tools-core builds before `db:generate`); the handler tests
 * pin each to the generated enums with `expectTypeOf`.
 */
import type { ToolResult } from "../../types.js";

export const SECURITY_PERIODS = ["last_hour", "today", "last_night", "last_24h", "last_7_days"] as const;

/** The incident severities a tool may filter on — a subset of Prisma's `SecuritySeverity`. */
export const SECURITY_SEVERITY_ARGS = ["alert", "notice"] as const;
export type SecuritySeverityName = (typeof SECURITY_SEVERITY_ARGS)[number];

/** The list filter's states: the stored ones a person names (below), plus `attention`, `activity` (no code) and `all`. */
export const SECURITY_STATE_ARGS = ["attention", "open", "acknowledged", "resolved", "activity", "all"] as const;
/** The stored `SecurityIncidentState`s the filter names directly — pinned to Prisma in the handler test. */
export type SecurityIncidentStateName = "open" | "acknowledged" | "resolved";

/** The event kinds a tool may filter on — a subset of Prisma's `SecurityEventKind` (the route maps each to the stored kinds it covers). */
export const SECURITY_EVENT_KIND_ARGS = ["detection", "camera_offline", "camera_online", "threat", "mode_changed"] as const;
export type SecurityEventKindName = (typeof SECURITY_EVENT_KIND_ARGS)[number];

export const SECURITY_LABEL_ARGS = ["person", "car", "dog", "cat"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SECURITY_UNAVAILABLE_MESSAGE = "Security is switched off on this Droplet, or this person can't use it.";
export const SECURITY_UNREACHABLE_MESSAGE = "Droplet couldn't read Security just now.";

export function securityError(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

export const invalidArgs = (message: string): ToolResult => securityError("INVALID_ARGS", message);

/** One argument check: the value to send, or the INVALID_ARGS result. */
type Checked = { ok: true; value: string | undefined } | { ok: false; result: ToolResult };

function optionalString(args: Record<string, unknown>, key: string, max: number): Checked {
  const v = args[key];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== "string" || v.trim() === "" || v.length > max) {
    return { ok: false, result: invalidArgs(`${key} must be a non-empty string of at most ${max} characters`) };
  }
  return { ok: true, value: v };
}

function optionalEnum(args: Record<string, unknown>, key: string, values: readonly string[]): Checked {
  const v = args[key];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== "string" || !values.includes(v)) {
    return { ok: false, result: invalidArgs(`${key} must be one of ${values.join(", ")}`) };
  }
  return { ok: true, value: v };
}

function optionalInt(args: Record<string, unknown>, key: string, min: number, max: number): Checked {
  const v = args[key];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    return { ok: false, result: invalidArgs(`${key} must be an integer from ${min} to ${max}`) };
  }
  return { ok: true, value: String(v) };
}

export type ArgSpec =
  | { kind: "string"; max: number }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "int"; min: number; max: number };

/**
 * Check `args` against `spec` (unknown keys refused, like the schema's
 * `additionalProperties: false`) and build the query params. Nothing is
 * sent when any check fails.
 */
export function checkArgs(
  args: Record<string, unknown>,
  spec: Readonly<Record<string, ArgSpec>>,
): { ok: true; params: Record<string, string> } | { ok: false; result: ToolResult } {
  const unknown = Object.keys(args).filter((k) => !(k in spec));
  if (unknown.length > 0) return { ok: false, result: invalidArgs(`unknown argument(s): ${unknown.join(", ")}`) };
  const params: Record<string, string> = {};
  for (const [key, s] of Object.entries(spec)) {
    const c =
      s.kind === "string" ? optionalString(args, key, s.max) : s.kind === "enum" ? optionalEnum(args, key, s.values) : optionalInt(args, key, s.min, s.max);
    if (!c.ok) return c;
    if (c.value !== undefined) params[key] = c.value;
  }
  if (params.period !== undefined && (params.from !== undefined || params.to !== undefined)) {
    return { ok: false, result: invalidArgs("give period or from/to, not both") };
  }
  if (params.to !== undefined && params.from === undefined) return { ok: false, result: invalidArgs("to needs from") };
  return { ok: true, params };
}

/** The period arguments every listing tool takes. */
export const PERIOD_SPEC: Readonly<Record<string, ArgSpec>> = {
  period: { kind: "enum", values: SECURITY_PERIODS },
  from: { kind: "string", max: 40 },
  to: { kind: "string", max: 40 },
};

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** The route's `{error: {code, message}}`, or the gates' `{error: 'module_disabled'}`, whichever it sent. */
function routeError(body: unknown): { code: string | null; message: string | null } {
  const e = (body as { error?: unknown } | null)?.error;
  if (typeof e === "string") return { code: e, message: null };
  if (e && typeof e === "object") {
    const { code, message } = e as { code?: unknown; message?: unknown };
    return { code: typeof code === "string" ? code : null, message: typeof message === "string" ? message : null };
  }
  return { code: null, message: null };
}

/**
 * Turn an assistant route's answer into the tool's result: the listed keys of
 * a 200 body under `type`, or the honest error. Never an empty list on a
 * failure — an empty list reads as a quiet site.
 */
export async function securityResult(res: Response, type: string, keys: readonly string[]): Promise<ToolResult> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) {
    if (!body || typeof body !== "object") return securityError("SECURITY_UNREACHABLE", SECURITY_UNREACHABLE_MESSAGE);
    const data: Record<string, unknown> = { type };
    for (const k of keys) if (k in body) data[k] = (body as Record<string, unknown>)[k];
    return { ok: true, data };
  }
  const { code, message } = routeError(body);
  if (res.status === 404 && code === "module_disabled") return securityError("SECURITY_UNAVAILABLE", SECURITY_UNAVAILABLE_MESSAGE);
  if (res.status === 404 && code === "INCIDENT_NOT_FOUND") {
    return securityError("INCIDENT_NOT_FOUND", "No incident with that id that this person can see.");
  }
  // WARP-2980 (P5 PR-E) — security_explain_pattern's two answers that are not an outage.
  if (res.status === 404 && code === "PLACE_NOT_FOUND") {
    return securityError("PLACE_NOT_FOUND", "No area or camera by that name that this person can see.");
  }
  if (res.status === 409 && code === "PATTERNS_NOT_READY") {
    return securityError("PATTERNS_NOT_READY", message ?? "Droplet hasn't worked out what's usual yet.");
  }
  if (res.status === 400 && code === "NO_SITE_TIMEZONE") {
    return securityError("NO_SITE_TIMEZONE", "Droplet doesn't know this site's time zone. Ask for exact times and pass them as from/to with an offset.");
  }
  if (res.status === 400) return securityError("BAD_REQUEST", message ?? "Security didn't accept those options.");
  return securityError("SECURITY_UNREACHABLE", SECURITY_UNREACHABLE_MESSAGE);
}

/** A GET that never throws: no answer at all is SECURITY_UNREACHABLE. */
export async function securityGet(call: () => Promise<Response>, type: string, keys: readonly string[]): Promise<ToolResult> {
  let res: Response;
  try {
    res = await call();
  } catch {
    return securityError("SECURITY_UNREACHABLE", SECURITY_UNREACHABLE_MESSAGE);
  }
  return securityResult(res, type, keys);
}

