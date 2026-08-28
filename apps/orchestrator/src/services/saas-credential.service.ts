/**
 * WARP-2275 — the descriptor-driven SaaS credential store.
 *
 * This is where a customer's vendor credential actually enters the box. Before
 * it, `IntegrationConnection.secretRef` held the literal string
 * `"<provider>:pending"` and nothing in the dashboard could write a credential
 * at all — every "connect" card on the hub led nowhere.
 *
 * The whole module is GENERIC. It contains no vendor knowledge: which fields
 * exist, which are secret, which are required and what each must look like all
 * come from the WARP-2217 `ProviderDescriptor`. A comparison of `provider`
 * against any vendor's key would be the defect — the descriptor would be
 * under-specified, and THAT is the bug to fix. WARP-2275 makes it a tripwire:
 * a grep for a vendor key over this file, the route and the dashboard
 * configurator must return zero.
 *
 * Shape, and why each piece is the shape it is:
 *
 *   - **Secrets live in `apiCredentialsEnc`**, sealed with column-crypto's
 *     `deriveSaasCredentialKey()` and AAD-bound to the row id, so a blob copied
 *     to another connection fails closed instead of authenticating as the wrong
 *     company. NOT `providerTokensEnc`: that column is the ERP cloud track's
 *     rotating OAuth material under a different key with a different lifecycle,
 *     and sharing a column would make "which key opens this?" a question about
 *     the row's history. The two encodings are distinguishable anyway — this
 *     one is always `dcv1:`-prefixed, the legacy Eaglesoft triple is not.
 *   - **Non-secret fields live in `providerConfig`**, validated through the
 *     descriptor's own `parseProviderConfigWith`, so the orchestrator and the
 *     dashboard cannot disagree about what a valid config is.
 *   - **The read view is assembled field by field.** Never `{ ...row }`. A
 *     spread ships every future column — including the next encrypted one
 *     somebody adds — straight to the browser, and does it silently.
 *   - **Three-way secret resolution** (omit / `""` / value) so an admin can fix
 *     a typo'd account id without retyping a key they may not still have.
 */
import {
  parseProviderConfigWith,
  providerDescriptor,
  validateCredentialFieldValue,
  type CredentialFieldDef,
  type ProviderDescriptor,
} from "@droplet/shared-types";

import {
  decryptColumn,
  deriveSaasCredentialKey,
  encryptColumn,
  isEncryptedColumn,
  saasCredentialAad,
} from "./column-crypto.service.js";

/** The `IntegrationStatus` values this service reads and writes. Mirrors the
 *  Prisma enum; kept as a local union so the service is testable against a
 *  structural stub rather than a generated client. */
export type IntegrationStatusName =
  | "NOT_CONFIGURED"
  | "PROVISIONING"
  | "CONNECTED"
  | "DEGRADED"
  | "DRIFT_LOCKED"
  // WARP-2458 — the persisted enum finally carries what `SaasConnectionState`
  // below could only derive, so the two unions in this file now agree.
  | "NEEDS_RECONNECT"
  | "ERROR"
  | "DISABLED";

/**
 * What the configurator tells a person about a connection.
 *
 * Modelled on `M365ConnectionState` (`schema.prisma:4990-5012`), whose docstring
 * requires NEEDS_RECONNECT stay distinguishable from DISCONNECTED, because the
 * two look identical to a "does a token decrypt?" check and mean opposite
 * things to a human: one asks them to sign in, the other says nothing is wrong.
 *
 * The same distinction is what this configurator exists to protect. A credential
 * the vendor REJECTED is not "not configured" — the admin pasted something and
 * it is present — and it is emphatically not CONNECTED. Collapsing either way
 * produces the failure mode the story is named for: a silent empty result
 * standing in for a broken connection.
 *
 * Derived from two EXPLICIT persisted facts — the `status` enum column and
 * whether the credential column holds a blob — never from a null standing in
 * for a state. This is the same derivation `m365-auth.service.ts` `toView` does
 * for an expired pending flow.
 */
export type SaasConnectionState =
  | "NOT_CONFIGURED"
  | "PROVISIONING"
  | "CONNECTED"
  | "NEEDS_RECONNECT"
  // WARP-2458 — present since NEEDS_RECONNECT stopped being inferred from it.
  // Terminal in the sense the enum's docstring means: reconnecting will not
  // fix it, so the view must be able to say so rather than folding it into an
  // instruction to paste a new key.
  | "ERROR"
  | "DEGRADED"
  | "DRIFT_LOCKED"
  | "DISABLED";

/** The row columns this service touches. Structural, so tests pass a literal. */
export interface SaasConnectionRow {
  id: string;
  provider: string;
  status: string;
  apiCredentialsEnc: string | null;
  providerConfig: unknown;
  updatedAt?: Date | null;
}

/** One field as the admin form should render it. Mirrors the descriptor's
 *  `CredentialFieldDef` minus nothing — the form gets the definition itself,
 *  which is what keeps the two apps from disagreeing about the form. */
export interface SaasCredentialFieldView {
  name: string;
  label: string;
  type: CredentialFieldDef["type"];
  required: boolean;
  secret: boolean;
  storage: CredentialFieldDef["storage"];
  help: string | null;
  /** The descriptor's validation regex source, so the form can hint before a
   *  round-trip. The SERVER is what enforces it — see `applyFieldUpdates`. */
  pattern: string | null;
  /**
   * For a secret field: whether a value is stored. NEVER the value, never a
   * prefix, a length, or a hash of it. `null` for a non-secret field, whose
   * actual value is safe to return and is carried in `values`.
   */
  hasValue: boolean | null;
}

/**
 * The API-safe projection of a connection's credentials.
 *
 * Built field by field in `buildCredentialView`. There is no code path that
 * emits `apiCredentialsEnc` or `providerTokensEnc` to a client or a log line.
 */
export interface SaasCredentialView {
  provider: string;
  displayName: string;
  category: string;
  /** Explicit — a provider with no row reports NOT_CONFIGURED, never `null`. */
  state: SaasConnectionState;
  /** Whether ANY secret field is stored. The per-field truth is in `fields`. */
  hasCredentials: boolean;
  configured: boolean;
  fields: SaasCredentialFieldView[];
  /** Current values of the NON-secret fields only. Secrets never appear here. */
  values: Record<string, string | number>;
  updatedAt: string | null;
}

/** Raised when a submitted field fails the descriptor's own validation. The
 *  route turns it into a 400; it is never a 500, because a rejected credential
 *  format is the customer's typo, not the box's fault. */
export class SaasCredentialValidationError extends Error {
  public readonly code = "SAAS_CREDENTIAL_INVALID";
  constructor(public readonly fieldErrors: Record<string, string[]>) {
    super("One or more credential fields are invalid.");
    this.name = "SaasCredentialValidationError";
  }
}

/** Raised when a provider key names nothing this appliance knows about. */
export class UnknownProviderError extends Error {
  public readonly code = "UNKNOWN_PROVIDER";
  constructor(public readonly provider: string) {
    super(`Unknown provider "${provider}".`);
    this.name = "UnknownProviderError";
  }
}

// --- Crypto ---------------------------------------------------------------

/**
 * Seal the secret fields of one connection.
 *
 * The whole bundle is one JSON object in one blob rather than a column per
 * field: the descriptor decides how many secret fields a provider has, and a
 * schema that had to grow a column per vendor field is exactly the hand-edit
 * treadmill WARP-2217 removed.
 */
export function sealSaasCredentials(
  connectionId: string,
  secrets: Record<string, string>,
): string {
  return encryptColumn(
    deriveSaasCredentialKey(),
    JSON.stringify(secrets),
    saasCredentialAad(connectionId),
  );
}

/**
 * Open a sealed bundle.
 *
 * THROWS on a blob that was sealed for a different row — GCM's tag check fails
 * because the AAD differs. It must never return `{}` or `null` for that case:
 * an empty credential set is indistinguishable from "not configured", and the
 * caller would then reach the vendor with no credential and collect an opaque
 * 401 instead of a diagnosable failure.
 */
export function openSaasCredentials(
  connectionId: string,
  blob: string,
): Record<string, string> {
  const json = decryptColumn(
    deriveSaasCredentialKey(),
    blob,
    saasCredentialAad(connectionId),
  );
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("saas-credential: sealed bundle is not an object");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// --- State ----------------------------------------------------------------

/**
 * Map (persisted status, credential presence) to what a person is told.
 *
 * Order is load-bearing:
 *  1. DISABLED wins — an operator turned it off, and that is true whether or
 *     not a credential is sitting on the row.
 *  2. No credential ⇒ NOT_CONFIGURED, whatever the status column says. This is
 *     the honesty rule: a row left at CONNECTED after its credential was
 *     cleared must not keep claiming to work.
 *  3. NEEDS_RECONNECT is now a PERSISTED status (WARP-2458) and passes
 *     straight through. Before that member existed this function had to infer
 *     it from `ERROR` + a credential being present, because the enum could not
 *     express it. That inference is now WRONG and has been removed: with a
 *     real member available, `ERROR` means what its docstring says — something
 *     reconnecting will not fix, like a Stripe key whose IP access policy
 *     refuses this box, or a Mailchimp plan that excludes the resource.
 *     Collapsing those into "paste a new key" sends the owner to mint keys
 *     until one of them works, which is the opposite of actionable.
 */
export function saasConnectionState(
  status: string,
  hasCredentials: boolean,
): SaasConnectionState {
  if (status === "DISABLED") return "DISABLED";
  if (!hasCredentials) return "NOT_CONFIGURED";
  switch (status) {
    case "CONNECTED":
      return "CONNECTED";
    case "NEEDS_RECONNECT":
      return "NEEDS_RECONNECT";
    case "ERROR":
      return "ERROR";
    case "DEGRADED":
      return "DEGRADED";
    case "DRIFT_LOCKED":
      return "DRIFT_LOCKED";
    default:
      // NOT_CONFIGURED / PROVISIONING with a credential present: we hold
      // something and have not yet proved it works.
      return "PROVISIONING";
  }
}

// --- The read view --------------------------------------------------------

function secretFieldsOf(d: ProviderDescriptor): readonly CredentialFieldDef[] {
  return d.credentialFields.filter((f) => f.secret);
}

/**
 * Project a row into the API-safe view — FIELD BY FIELD.
 *
 * Deliberately not `{ ...row, hasApiKey }`. The spread is the defect this shape
 * exists to prevent, and it is a defect that grows silently: it ships whatever
 * column the schema gains next, and nobody reviewing that migration is looking
 * at this file.
 */
export function buildCredentialView(
  descriptor: ProviderDescriptor,
  row: SaasConnectionRow | null,
): SaasCredentialView {
  const storedSecrets: Record<string, string> = (() => {
    if (!row?.apiCredentialsEnc) return {};
    // A legacy non-`dcv1:` blob (the pre-descriptor Eaglesoft triple) is not
    // ours to read; report no SaaS credential rather than guessing at a format.
    if (!isEncryptedColumn(row.apiCredentialsEnc)) return {};
    try {
      return openSaasCredentials(row.id, row.apiCredentialsEnc);
    } catch {
      // Unreadable after a factory reset regenerated DEVICE_SECRET_KEY. The
      // credential is gone in every sense that matters, so it reads as absent —
      // which routes the person to "paste it again", the only thing that works.
      return {};
    }
  })();

  const config = parseProviderConfigWith(descriptor, row?.providerConfig) ?? undefined;

  const fields: SaasCredentialFieldView[] = descriptor.credentialFields.map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    required: f.required,
    secret: f.secret,
    storage: f.storage,
    help: f.help ?? null,
    pattern: f.pattern ?? null,
    hasValue: f.secret ? typeof storedSecrets[f.name] === "string" : null,
  }));

  const values: Record<string, string | number> = {};
  for (const f of descriptor.credentialFields) {
    if (f.secret) continue; // a secret's value never leaves the box
    const v = config?.[f.name];
    if (typeof v === "string" || typeof v === "number") values[f.name] = v;
  }

  const declaredSecrets = secretFieldsOf(descriptor);
  const hasCredentials =
    declaredSecrets.length > 0 &&
    declaredSecrets.every((f) => typeof storedSecrets[f.name] === "string");

  return {
    provider: descriptor.id,
    displayName: descriptor.displayName,
    category: descriptor.category,
    state: saasConnectionState(row?.status ?? "NOT_CONFIGURED", hasCredentials),
    hasCredentials,
    configured: row !== null,
    fields,
    values,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

// --- The write path -------------------------------------------------------

/** The result of resolving a PATCH body against what is already stored. */
export interface ResolvedCredentialUpdate {
  /** The blob to persist, `null` to clear the column, or `undefined` to leave
   *  it exactly as it is (byte-identical — the "omit = keep" case). */
  apiCredentialsEnc: string | null | undefined;
  /** The `providerConfig` JSON to persist, or `undefined` to leave it. */
  providerConfig: Record<string, string | number> | undefined;
  /** True when at least one secret field ends up stored. Audited as a boolean
   *  and nothing more — this is the ONLY thing the audit row learns about the
   *  credential. */
  hasSecret: boolean;
  /** True when the caller explicitly cleared every secret. Drives the row back
   *  to NOT_CONFIGURED rather than leaving a CONNECTED row with no credential. */
  cleared: boolean;
}

/**
 * Resolve a submitted field map against the stored credential — the three-way
 * rule, ported field for field from `settings-email.ts:147-154`:
 *
 *   - **key absent** → keep whatever is stored. This is what lets an admin fix
 *     a mistyped account id without re-entering a key they may no longer have,
 *     and it is the single most common place a configurator silently wipes a
 *     working credential.
 *   - **`""`** → clear it.
 *   - **any value** → validate against the descriptor, then encrypt and replace.
 *
 * `undefined` and `""` therefore MUST stay distinguishable all the way from the
 * JSON body to this function. Nothing on the path may default one into the
 * other.
 */
export function resolveCredentialUpdate(
  descriptor: ProviderDescriptor,
  row: SaasConnectionRow | null,
  submitted: Record<string, string | number>,
  connectionId: string,
): ResolvedCredentialUpdate {
  const fieldErrors: Record<string, string[]> = {};

  const stored: Record<string, string> = (() => {
    if (!row?.apiCredentialsEnc || !isEncryptedColumn(row.apiCredentialsEnc)) return {};
    try {
      return openSaasCredentials(row.id, row.apiCredentialsEnc);
    } catch {
      return {};
    }
  })();

  // --- secrets ---
  const nextSecrets: Record<string, string> = { ...stored };
  let touchedSecret = false;
  for (const f of secretFieldsOf(descriptor)) {
    if (!(f.name in submitted)) continue; // omitted → keep
    touchedSecret = true;
    const raw = submitted[f.name];
    if (raw === "") {
      delete nextSecrets[f.name];
      continue;
    }
    // The descriptor's own `pattern` is enforced HERE, server-side. A form hint
    // is a courtesy; this is the refusal. A vendor whose key format is a
    // contractual guarantee (a restricted-key prefix, say) gets that guarantee
    // because the descriptor declares it, not because this file knows the
    // vendor.
    const valid = validateCredentialFieldValue(f, raw);
    if (valid === undefined) {
      (fieldErrors[f.name] ??= []).push(
        f.pattern
          ? `${f.label} is not in the expected format.`
          : `${f.label} must be a non-empty value.`,
      );
      continue;
    }
    nextSecrets[f.name] = String(valid);
  }

  // --- non-secret config ---
  const storedConfig = parseProviderConfigWith(descriptor, row?.providerConfig);
  const nextConfig: Record<string, string | number> = {};
  let touchedConfig = false;
  const configFields = descriptor.credentialFields.filter(
    (f) => !f.secret && f.storage === "providerConfig",
  );
  for (const f of configFields) {
    if (f.name in submitted) {
      touchedConfig = true;
      const raw = submitted[f.name];
      if (raw === "") continue; // cleared → simply absent from the next config
      const valid = validateCredentialFieldValue(f, raw);
      if (valid === undefined) {
        (fieldErrors[f.name] ??= []).push(
          `${f.label} is not in the expected format.`,
        );
        continue;
      }
      nextConfig[f.name] = valid;
      continue;
    }
    const existing = storedConfig?.[f.name];
    if (typeof existing === "string" || typeof existing === "number") {
      nextConfig[f.name] = existing;
    }
  }

  // A required field must survive the merge, not merely the submission — an
  // admin who clears the account id has broken the connection just as surely as
  // one who never set it, and the refusal belongs here rather than at dial time.
  for (const f of configFields) {
    if (f.required && nextConfig[f.name] === undefined) {
      (fieldErrors[f.name] ??= []).push(`${f.label} is required.`);
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new SaasCredentialValidationError(fieldErrors);
  }

  const remaining = Object.keys(nextSecrets).length;
  const hasSecret = remaining > 0;

  return {
    apiCredentialsEnc: !touchedSecret
      ? undefined // omit = keep: the column is not in the update at all
      : hasSecret
        ? sealSaasCredentials(connectionId, nextSecrets)
        : null,
    providerConfig: touchedConfig || configFields.length > 0 ? nextConfig : undefined,
    hasSecret,
    // Cleared = the caller sent "" and nothing is left. `touchedSecret` alone
    // would call a partial update a clear.
    cleared: touchedSecret && !hasSecret,
  };
}

/**
 * The status a row should carry after a credential write.
 *
 * Explicit-enum, per the house rule: the status is a value we choose and write,
 * never something a later reader infers from whether a column is null.
 */
export function statusAfterCredentialUpdate(
  current: string,
  hasSecret: boolean,
): IntegrationStatusName {
  if (!hasSecret) return "NOT_CONFIGURED";
  // A row that was DISABLED stays DISABLED — pasting a key is not the same
  // gesture as turning the connector back on.
  if (current === "DISABLED") return "DISABLED";
  // A fresh credential deserves a fresh verdict: whatever the vendor said about
  // the OLD key is no longer evidence about this one.
  return "PROVISIONING";
}

/** Resolve a provider key to its descriptor, or throw. Absence is never a
 *  silent anything — an unknown key is a 404, not an empty form. */
export function requireDescriptor(provider: string): ProviderDescriptor {
  const d = providerDescriptor(provider);
  if (!d) throw new UnknownProviderError(provider);
  return d;
}
