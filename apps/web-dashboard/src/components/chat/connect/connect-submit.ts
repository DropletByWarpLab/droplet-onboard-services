/**
 * WARP-3904 — what a connect card sends, and where.
 *
 * Every write here goes to a route the Integrations hub or Settings already
 * writes to, with the body shape that surface sends. The card adds no write
 * surface: the box's own role guard and egress allowlist still decide. What the
 * card adds is a place to type, and one promise about it: the values go from
 * this form to those routes and nowhere else. They are never handed to
 * `onOutcome`, the SSE stream, the transcript or the model; the only thing that
 * leaves this module is a result with a person-readable message.
 *
 * ## Credentials (catalog providers) — the hub's two calls, not one
 *
 * `ConnectWizard` does not post credentials to `/connect`. It saves them with
 * `PATCH /api/integrations/:provider/credentials` (`{ fields }`, plus the
 * reserved `credentialVariant` when a variant was picked) and then asks the box
 * to CHECK them with `POST /api/integrations/:provider/connect` and an EMPTY
 * body. The orchestrator's cloud connect schema is strict: a credential in the
 * connect body is a 400. So the card does the same two calls, and the PATCH
 * target is derived from the descriptor's allowlisted `post.path` (same
 * provider segment, same prefix), never taken from the descriptor directly.
 * A track whose paste IS the connection (mcp) skips the second call and takes
 * the state the save returned, as the hub does.
 *
 * ## Mailbox and calendar — one POST, the existing forms' bodies
 *
 * `EmailAccountCard` posts `{ displayName, address, imapHost, imapPort,
 * imapTls, smtpHost, smtpPort, smtpTls, username, password }` to
 * `/api/email/accounts`; `SubscriptionsPanel` posts `{ name, url, authMode,
 * username?, password? }` to `/api/calendar/sources`.
 *
 * ## OAuth — the Settings cards' start call
 *
 * `POST /api/google/connect` or `/api/m365/connect` → `{ authorizeUrl }`.
 */
import {
  CREDENTIAL_VARIANT_FIELD,
  isAllowedConnectPostPath,
  isAllowedOauthStartPath,
  isProbedOnConnect,
  providerDescriptor,
  type CalendarConnectCard,
  type ConnectField,
  type CredentialsConnectCard,
  type MailboxConnectCard,
  type OauthConnectCard,
} from "@droplet/shared-types";
import { authFetch } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";

export type FieldValues = Record<string, string>;

/** `rejected`: the details were refused (wrong key or password). `other`: anything else. */
export type ConnectFailure = { ok: false; tone: "rejected" | "other"; message: string };
export type ConnectSuccess = { ok: true; note?: string };
export type ConnectAttempt = ConnectSuccess | ConnectFailure;

type FormCard = CredentialsConnectCard | MailboxConnectCard | CalendarConnectCard;

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const NETWORK_MESSAGE = "Droplet couldn't reach itself. Check your connection and try again.";
const SESSION_MESSAGE = "Your session expired. Sign in again, then try once more.";
const PERMISSION_MESSAGE = "Only an owner or admin can connect this.";
const GENERIC_MESSAGE = "Something went wrong on the box. Try again in a moment.";

// ── Fields ───────────────────────────────────────────────────────────────

/** The base fields plus the picked variant's, a variant field overriding a base one of the same name. */
export function fieldsFor(card: FormCard, variantId: string | null): ConnectField[] {
  const base = card.fields;
  const variant = card.mode === "credentials" && variantId ? card.variants?.find((v) => v.id === variantId) : undefined;
  if (!variant) return base;
  const names = new Set(variant.fields.map((f) => f.name));
  return [...base.filter((f) => !names.has(f.name)), ...variant.fields];
}

/** Every secret field name the card can show, across all variants. */
export function secretNamesOf(card: FormCard): string[] {
  const all = [...card.fields, ...(card.mode === "credentials" ? (card.variants ?? []).flatMap((v) => v.fields) : [])];
  return [...new Set(all.filter((f) => f.secret).map((f) => f.name))];
}

/** Why a field is not ready, or null. Blank-and-optional is ready; a pattern applies only to what was typed. */
export function fieldProblem(field: ConnectField, value: string | undefined): "required" | "pattern" | null {
  const typed = value ?? "";
  if (typed.trim() === "") return field.required ? "required" : null;
  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(typed)) return "pattern";
    } catch {
      /* the parser already dropped unparseable patterns; ignore one that slipped through */
    }
  }
  return null;
}

// ── Errors ───────────────────────────────────────────────────────────────

/** The error code a route answered with: `{ error: "code" }`, `{ error: { code } }` or `{ code }`. */
async function errorCodeOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown } | null;
    if (typeof body?.error === "string") return body.error;
    if (body?.error && typeof body.error === "object" && typeof (body.error as { code?: unknown }).code === "string") {
      return (body.error as { code: string }).code;
    }
    if (typeof body?.code === "string") return body.code;
  } catch {
    /* non-JSON error body */
  }
  return undefined;
}

/** The field messages a validation 400 names. Never a value: the route says which field, not what was in it. */
async function fieldErrorsOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { details?: { fieldErrors?: Record<string, string[]> } } | null;
    const fieldErrors = body?.details?.fieldErrors;
    if (fieldErrors) return Object.values(fieldErrors).flat().filter((m) => typeof m === "string").join(" ");
  } catch {
    /* non-JSON error body */
  }
  return "";
}

function statusFailure(status: number): ConnectFailure {
  if (status === 401) return { ok: false, tone: "other", message: SESSION_MESSAGE };
  if (status === 403) return { ok: false, tone: "other", message: PERMISSION_MESSAGE };
  return { ok: false, tone: "other", message: GENERIC_MESSAGE };
}

function networkFailure(): ConnectFailure {
  return { ok: false, tone: "other", message: NETWORK_MESSAGE };
}

// ── Credentials ──────────────────────────────────────────────────────────

const CONNECT_PATH_RE = /^\/api\/integrations\/([a-z0-9][a-z0-9-]{0,63})\/connect$/;

/** The save target for a card's allowlisted connect path: same provider, `/credentials`. */
export function credentialsPathFor(connectPath: string): string | null {
  const m = CONNECT_PATH_RE.exec(connectPath);
  return m ? `/api/integrations/${m[1]}/credentials` : null;
}

/** One plain sentence per verdict the box can return, in the hub's words. */
function verdictAttempt(status: unknown, name: string): ConnectAttempt {
  switch (status) {
    case "CONNECTED":
      return { ok: true };
    case "CAPABILITY_LIMITED":
      return { ok: true, note: `Droplet is reading ${name}, but one dataset needs a plan or permission change at the vendor.` };
    case "DEGRADED":
      return { ok: true, note: `The key works, but ${name} isn't answering reliably right now. Droplet will keep trying.` };
    case "NEEDS_RECONNECT":
      return { ok: false, tone: "rejected", message: "Check it's current and has read access, then paste it again." };
    case "ERROR":
      return {
        ok: false,
        tone: "other",
        message: `${name} refused the connection, and a new key won't change that. Check the vendor's settings. An access policy or plan limit is the usual cause.`,
      };
    default:
      return { ok: false, tone: "other", message: `Droplet couldn't confirm the connection to ${name} yet. Try again in a moment.` };
  }
}

/** Save the typed credential, then ask the box to check it. Secrets leave only through the PATCH. */
export async function submitCredentials(
  card: CredentialsConnectCard,
  values: FieldValues,
  variantId: string | null,
): Promise<ConnectAttempt> {
  // The parser already refuses a card naming anything off the generic allowlist; this is the
  // second lock, same as submitInline's: the connect path must name THIS card's own provider,
  // or a card for one provider could save its secret under another provider's route.
  if (card.post.path !== `/api/integrations/${card.provider}/connect`) {
    return { ok: false, tone: "other", message: GENERIC_MESSAGE };
  }
  const savePath = credentialsPathFor(card.post.path);
  if (!savePath) return { ok: false, tone: "other", message: GENERIC_MESSAGE };

  const payload: Record<string, string> = {};
  for (const f of fieldsFor(card, variantId)) {
    const typed = values[f.name];
    // An untouched field is OMITTED, never sent as "": the box reads "" as "clear it".
    if (typed === undefined || typed === "") continue;
    payload[f.name] = typed;
  }
  if (variantId && card.variants?.some((v) => v.id === variantId)) payload[CREDENTIAL_VARIANT_FIELD] = variantId;

  try {
    const saved = await authFetch(savePath, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ fields: payload }) });
    if (!saved.ok) {
      if (saved.status === 400 || saved.status === 422) {
        const detail = await fieldErrorsOf(saved);
        return { ok: false, tone: "rejected", message: detail || "Droplet couldn't accept those details. Check them and try again." };
      }
      return statusFailure(saved.status);
    }
    const savedState = ((await saved.json().catch(() => ({}))) as { state?: unknown } | null)?.state;

    // Read off the descriptor, like the hub: cloud and REST are probed on
    // connect; an MCP paste is the connection itself. A provider the registry
    // does not know is probed, which is what the generic route does.
    const descriptor = providerDescriptor(card.provider);
    if (descriptor && !isProbedOnConnect(descriptor)) return verdictAttempt(savedState, card.displayName);

    const checked = await authFetch(card.post.path, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    if (!checked.ok) return statusFailure(checked.status);
    const verdict = ((await checked.json().catch(() => ({}))) as { status?: unknown } | null)?.status;
    return verdictAttempt(verdict, card.displayName);
  } catch {
    return networkFailure();
  }
}

// ── Mailbox and calendar ─────────────────────────────────────────────────

function mailboxBody(card: MailboxConnectCard, values: FieldValues): Record<string, string | number | boolean> {
  const body: Record<string, string | number | boolean> = {};
  for (const f of card.fields) {
    const typed = values[f.name];
    if (typed === undefined || typed === "") continue;
    const n = Number(typed);
    body[f.name] = f.type === "number" && Number.isFinite(n) ? n : typed;
  }
  // EmailAccountCard connects over implicit TLS on both servers.
  if (!("imapTls" in body)) body.imapTls = true;
  if (!("smtpTls" in body)) body.smtpTls = true;
  return body;
}

/** `{ name, url, authMode, username?, password? }`; basic auth only when both halves are typed. */
function calendarBody(card: CalendarConnectCard, values: FieldValues): Record<string, string> | { problem: string } {
  const body: Record<string, string> = {};
  for (const f of card.fields) {
    const typed = values[f.name];
    if (typed === undefined || typed === "") continue;
    body[f.name] = typed;
  }
  const username = body.username?.trim();
  const password = body.password;
  if ((username && !password) || (!username && password)) {
    return { problem: "Signing in needs both a username and a password." };
  }
  if (username && password) return { ...body, authMode: "basic" };
  delete body.username;
  delete body.password;
  return { ...body, authMode: "none" };
}

export async function submitInline(
  card: MailboxConnectCard | CalendarConnectCard,
  values: FieldValues,
): Promise<ConnectAttempt> {
  // The parser already refuses a card naming anything else; this is the second lock.
  const expected = card.mode === "mailbox" ? "/api/email/accounts" : "/api/calendar/sources";
  if (!isAllowedConnectPostPath(card.post.path) || card.post.path !== expected) {
    return { ok: false, tone: "other", message: GENERIC_MESSAGE };
  }
  let body: unknown;
  if (card.mode === "mailbox") {
    body = mailboxBody(card, values);
  } else {
    const built = calendarBody(card, values);
    if ("problem" in built) return { ok: false, tone: "other", message: built.problem };
    body = built;
  }
  try {
    const res = await authFetch(card.post.path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (res.ok) return { ok: true };
    const code = await errorCodeOf(res);
    const domain = card.mode === "mailbox" ? "email" : "subscription";
    const message = translateError({ code, status: res.status }, domain);
    const rejected = code === "email_mailbox_refused" || code === "AUTH_REQUIRED";
    return { ok: false, tone: rejected ? "rejected" : "other", message };
  } catch {
    return networkFailure();
  }
}

// ── OAuth ────────────────────────────────────────────────────────────────

/** Where the box sends the browser next. Google and Microsoft only, over https. */
function isAuthorizeUrl(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

/** The Settings cards' own copy for a sign-in that would not start. */
function oauthFailure(card: OauthConnectCard, kind: "refused" | "network"): string {
  if (card.family === "m365") {
    return kind === "refused"
      ? "Droplet could not start the Microsoft sign-in. Try again, or ask your Droplet administrator to check Account connection setup."
      : "Droplet could not reach itself to start the sign-in. Check your connection and try again.";
  }
  const label = card.family === "google" ? "Google" : card.providerLabel;
  return kind === "refused"
    ? `Droplet could not start ${label} sign-in. Try again, or ask your Droplet administrator to check Account connection setup.`
    : `Droplet could not start ${label} sign-in. Check your connection and try again.`;
}

export async function startOauth(
  card: OauthConnectCard,
  options: Record<string, boolean>,
): Promise<{ ok: true; authorizeUrl: string } | { ok: false; message: string }> {
  // The parser already refuses a card naming anything else; this is the second lock.
  if (!isAllowedOauthStartPath(card.start.path)) return { ok: false, message: oauthFailure(card, "refused") };
  try {
    const res = await authFetch(card.start.path, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...options, returnTo: "/chat" }),
    });
    const body = (await res.json().catch(() => ({}))) as { authorizeUrl?: unknown } | null;
    if (res.ok && isAuthorizeUrl(body?.authorizeUrl)) return { ok: true, authorizeUrl: body.authorizeUrl };
    return { ok: false, message: oauthFailure(card, "refused") };
  } catch {
    return { ok: false, message: oauthFailure(card, "network") };
  }
}
