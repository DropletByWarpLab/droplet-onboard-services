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
 *   - **Secrets live in `providerTokensEnc`** (`schema.prisma:4396`), sealed
 *     with column-crypto's `deriveSaasCredentialKey()` and AAD-bound to the row
 *     id, so a blob copied to another connection fails closed instead of
 *     authenticating as the wrong company. This is ADR-042 §5, and it is the
 *     doctrine rather than a preference: `providerTokensEnc` is the CLOUD-track
 *     credential column, and it is what the connectors' `TokenResolver` reads.
 *     NOT `apiCredentialsEnc` (`:4353`) — that column is the Eaglesoft REST
 *     track's static {integrationKey,userId,password} triple under the older
 *     `encryptSecret`, on a LAN transport this configurator never touches.
 *     An earlier pass of this file wrote `apiCredentialsEnc` because the
 *     subtasks named it; ADR-042 is the authority and the column was corrected.
 *
 *     The two writers of `providerTokensEnc` stay disjoint by PROVIDER, and
 *     each fails closed against the other's blobs: the ERP cloud track seals
 *     under `deriveErpCloudTokenKey()` with the bare row id as AAD, this path
 *     under `deriveSaasCredentialKey()` with a `saas-credential:` AAD, so
 *     neither can open the other's ciphertext — it reads as "no credential",
 *     never as a wrong one.
 *   - **Non-secret connection facts live in `providerConfig`** (`:4383`) —
 *     ADR-042 §5 again — validated through the descriptor's own
 *     `parseProviderConfigWith`, so the orchestrator and the dashboard cannot
 *     disagree about what a valid config is. Never inside the encrypted blob,
 *     and never re-derived per request.
 *   - **The read view is assembled field by field.** Never `{ ...row }`. A
 *     spread ships every future column — including the next encrypted one
 *     somebody adds — straight to the browser, and does it silently.
 *   - **Three-way secret resolution** (omit / `""` / value) so an admin can fix
 *     a typo'd account id without retyping a key they may not still have.
 */
import {
  credentialExpiryVerdict,
  credentialFieldsFor,
  credentialSecretFieldsFor,
  parseProviderConfigWith,
  providerConfigVariantId,
  providerDescriptor,
  setupGuideHrefFor,
  validateCredentialFieldValue,
  CREDENTIAL_VARIANT_FIELD,
  type CredentialExpiryVerdict,
  type CredentialFieldDef,
  type ProviderDescriptor,
  // WARP-2639 — the ONE `IntegrationStatus`, imported under the name this
  // module has always exported it as. Re-exported below.
  type IntegrationStatus as IntegrationStatusName,
  // WARP-2633 — the ONE `SaasConnectionState`. Re-exported below so this
  // module stays the name every existing caller imports it under.
  type SaasConnectionState,
} from "@droplet/shared-types";
import {
  remoteMcpLifecycle,
  type RemoteMcpAttachView,
  type RemoteMcpLifecycleRegistry,
} from "./remote-mcp-lifecycle.service.js";

import {
  decryptColumn,
  deriveSaasCredentialKey,
  encryptColumn,
  isEncryptedColumn,
  saasCredentialAad,
} from "./column-crypto.service.js";
import { credentialsPurgedFor } from "./integrations.service.js";

/**
 * The `IntegrationStatus` values this service reads and writes. Kept as a
 * union rather than the generated Prisma enum so the service stays testable
 * against a structural stub rather than a generated client.
 *
 * WARP-2639 — the definition moved to `@droplet/shared-types`
 * (`integration-status.ts`) and is re-exported here, because this module was
 * one of FOUR hand-copied unions of the same enum. Same move, and for the same
 * reason, as `SaasConnectionState` below.
 */
export type { IntegrationStatusName };

/**
 * What the configurator tells a person about a connection.
 *
 * WARP-2633 — the definition moved to `@droplet/shared-types`
 * (`saas-connection-state.ts`) and is re-exported here, because this module
 * was one of TWO hand-maintained copies (the other was the dashboard's
 * `lib/api.ts`) with nothing asserting they agreed. The member docs and the
 * `NON_CONNECTION_INTEGRATION_STATUSES` exclusion live with the definition;
 * the Prisma-parity gate is `__tests__/integration-status.schema.test.ts`.
 *
 * Re-exported rather than left to callers to import from the package, so the
 * dozen existing `from "./saas-credential.service.js"` imports keep working
 * and the move stays a refactor rather than a rename of the whole surface.
 *
 * The properties the state carries have not changed. It is still modelled on
 * `M365ConnectionState` (`schema.prisma:4990-5012`), whose docstring requires
 * NEEDS_RECONNECT stay distinguishable from DISCONNECTED — the two look
 * identical to a "does a token decrypt?" check and mean opposite things to a
 * human. And it is still derived from two EXPLICIT persisted facts, the
 * `status` enum column and whether the credential column holds a blob, never
 * from a null standing in for a state.
 */
export type { SaasConnectionState };

/** The row columns this service touches. Structural, so tests pass a literal. */
export interface SaasConnectionRow {
  id: string;
  provider: string;
  /**
   * The Prisma `IntegrationStatus` enum column, typed as the enum. It was
   * `string`, which is what let `saasConnectionState`'s `default` arm stay
   * unreachable-by-gate: a `string` cannot be narrowed to `never`, so the
   * compiler had nothing to say about a status the switch had not learned.
   */
  status: IntegrationStatusName;
  /** ADR-042 §5 — where a customer-supplied credential lives. */
  providerTokensEnc: string | null;
  /**
   * WARP-2489 — the Eaglesoft REST track's column. This service never reads a
   * credential OUT of it (that is `erp-provider.ts`'s static triple under the
   * older `encryptSecret`), but "has this connection's credential material
   * been removed" is a question about the ROW, and the row has two credential
   * columns. Answering it from `providerTokensEnc` alone would let the
   * credentials page report a purge that the hub — reading both — denies.
   *
   * Required, not optional: a caller that narrows its `select` and drops the
   * column must fail to compile rather than silently claim a purge.
   */
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
  /**
   * Whether EVERY declared secret field is stored — an `every()`, not an
   * `any()`. It answers "is this connection usable", which is what `state` is
   * derived from.
   *
   * It is emphatically NOT the answer to "was the credential removed"
   * (WARP-2489): a provider declaring two secrets with one stored reports
   * `false` here while that one is still sealed on the row. Read
   * {@link SaasCredentialView.credentialsPurged} for that question.
   */
  hasCredentials: boolean;
  /**
   * WARP-2489 — whether this connection's credential material has actually
   * been removed from the row, so `/integrations/credentials` can say
   * "disconnected · credential removed" only when it is true.
   *
   * Produced by `credentialsPurgedFor` — the SAME call that builds the hub's
   * `IntegrationSummary.credentialsPurged`, so the two surfaces cannot give an
   * owner opposite answers about the same row. It reads the explicit `status`
   * enum and both credential columns; it is never inferred from a null, and
   * never from `hasCredentials`.
   *
   * `false`, never omitted, for an unconfigured provider: nothing was purged.
   */
  credentialsPurged: boolean;
  configured: boolean;
  fields: SaasCredentialFieldView[];
  /** Current values of the NON-secret fields only. Secrets never appear here. */
  values: Record<string, string | number>;
  updatedAt: string | null;
  /**
   * WARP-2650 — where the customer reads how to mint this credential, or
   * `null` when the provider declares none.
   *
   * This page is the one place in the product where somebody is asked to go to
   * a vendor console and come back with a value, and it was the only surface
   * rendering a descriptor that could not link the guide the descriptor already
   * declares — the hub tile and the connect wizard both do (WARP-2342), and an
   * `mcp` track has neither of those. Read through `setupGuideHrefFor` so all
   * three surfaces resolve it the same way.
   */
  setupGuideHref: string | null;
  /**
   * WARP-2650 — the credential's expiry verdict, or `null` when the provider
   * declares no {@link CredentialExpiryPolicy}.
   *
   * `null` is "this credential has no expiry concept" and is a different answer
   * from `{status: "EXPIRY_UNKNOWN"}`, which is "it does, and no date was
   * recorded, so no warning can ever fire". Collapsing the two would put every
   * Stripe connection in a warning state it can never leave.
   *
   * Carried ALONGSIDE `state` rather than folded into it: `IntegrationStatus`
   * has no EXPIRING_SOON member (WARP-2353 modelled the window read-time only,
   * and adding an enum value is a migration on its own ticket), and a token
   * twelve days from a hard stop is genuinely CONNECTED *and* genuinely needs
   * action. Two facts, two fields — never one field guessing at both.
   */
  credentialExpiry: CredentialExpiryVerdict | null;
  /**
   * WARP-2651 — whether this box is actually ATTACHED to the vendor's MCP
   * server right now, or `null` for every track that has no such concept.
   *
   * Carried alongside `state` rather than folded into it, for the same reason
   * `credentialExpiry` is: `IntegrationStatus` is what the OPERATOR configured
   * and it is persisted; this is what the RUNTIME currently is, it lives in
   * this process's memory, and the two are legitimately different. A connection
   * whose credential is perfect and whose bridge container is restarting is
   * genuinely `CONNECTED` *and* genuinely not reaching anything — one field
   * guessing at both is how "looks connected and quietly does nothing" ships.
   *
   * `null` for a `cloud` or `lan` track is "there is no session concept here",
   * and `null` for an `mcp` track is "no attach has ever been attempted on this
   * box" — which is the shipping default (the allowlist is empty) and is not an
   * error state. Both are absence of a REGISTRATION, never absence of a session
   * id: the state itself is always a declared value.
   */
  remoteMcp: RemoteMcpAttachView | null;
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
  status: IntegrationStatusName,
  hasCredentials: boolean,
): SaasConnectionState {
  if (status === "DISABLED") return "DISABLED";
  if (!hasCredentials) return "NOT_CONFIGURED";
  switch (status) {
    case "CONNECTED":
      return "CONNECTED";
    case "NEEDS_RECONNECT":
      return "NEEDS_RECONNECT";
    case "CAPABILITY_LIMITED":
      return "CAPABILITY_LIMITED";
    case "ERROR":
      return "ERROR";
    case "DEGRADED":
      return "DEGRADED";
    case "DRIFT_LOCKED":
      return "DRIFT_LOCKED";
    // Both mean "we hold something and have not yet proved it works" — the
    // only two statuses this function deliberately RENAMES, and they are
    // spelled out rather than left to `default` so that arm can be a
    // never-check.
    case "NOT_CONFIGURED":
    case "PROVISIONING":
      return "PROVISIONING";
    default: {
      // The gate the parity test could not be. `integration-status.schema.test.ts`
      // set-compares the ARRAYS against the Prisma enum, which is a claim about
      // two lists and says nothing about this function: a status added to both
      // lists passed every gate in the repo and still fell through the old
      // `default` to "PROVISIONING", telling an owner a working connection was
      // "Setting up...". That is exactly how `CAPABILITY_LIMITED` came to ship
      // a case with no test.
      //
      // Typing the parameter `IntegrationStatusName` and assigning the
      // fallthrough to `never` moves the decision to COMPILE time: the next
      // member added to `INTEGRATION_STATUSES` breaks the build here until
      // somebody says what a person should be told about it. It cannot be
      // answered by omission, which is the "no guessing state" rule applied to
      // a switch.
      const unhandled: never = status;
      // Runtime arm kept for the value that cannot exist in the type but can
      // exist in a column an older box wrote. "Unproven" is the honest answer
      // for a status this build has never heard of — it claims nothing.
      void unhandled;
      return "PROVISIONING";
    }
  }
}

// --- The read view --------------------------------------------------------

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
  /** Injected so the expiry verdict is testable without freezing a clock
   *  process-wide. Defaults to now, like every other read of the time here. */
  now: Date = new Date(),
  /** Injected for the same reason: a test drives its own registry instead of
   *  the process-wide attachment. */
  lifecycle: RemoteMcpLifecycleRegistry = remoteMcpLifecycle,
): SaasCredentialView {
  const storedSecrets: Record<string, string> = (() => {
    if (!row?.providerTokensEnc) return {};
    // A non-`dcv1:` blob is not ours to read; report no SaaS credential rather
    // than guessing at a format.
    if (!isEncryptedColumn(row.providerTokensEnc)) return {};
    try {
      return openSaasCredentials(row.id, row.providerTokensEnc);
    } catch {
      // Two cases, both correctly "absent": a factory reset regenerated
      // DEVICE_SECRET_KEY, or the blob is the ERP cloud track's OAuth material
      // sealed under `deriveErpCloudTokenKey()` — a different key and a
      // different AAD, so it fails the GCM tag check here. Either way the
      // credential is gone in every sense that matters, which routes the person
      // to "paste it again", the only thing that works.
      return {};
    }
  })();

  const config = parseProviderConfigWith(descriptor, row?.providerConfig) ?? undefined;

  /**
   * WARP-2491 — which authentication path this row is on, read from the key
   * the config EXPLICITLY records. Never inferred from which fields happen to
   * be present: two variants may share a field name, and "whichever path's
   * fields I can see" is the guessed state the explicit-enum rule forbids.
   *
   * `undefined` for a provider declaring no variants, which is every shipped
   * one — `credentialFieldsFor` then returns `credentialFields` unchanged and
   * this whole block is a no-op.
   */
  const variantId = providerConfigVariantId(descriptor, row?.providerConfig);
  /**
   * The fields this connection's form is actually made of. A variants-declaring
   * provider's view must carry the CHOSEN path's fields — rendering
   * `credentialFields` alone is what made the wizard collect values the service
   * then dropped.
   *
   * A row whose stored variant id no longer exists falls back to the first
   * variant here (`credentialVariantFor`'s documented behaviour): a form that
   * renders nothing looks like a provider needing no credentials, which is
   * worse than reopening on a path the owner can correct.
   */
  const viewFields = credentialFieldsFor(descriptor, variantId);

  const fields: SaasCredentialFieldView[] = viewFields.map((f) => ({
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
  for (const f of viewFields) {
    if (f.secret) continue; // a secret's value never leaves the box
    const v = config?.[f.name];
    if (typeof v === "string" || typeof v === "number") values[f.name] = v;
  }

  // Variant-aware: "is this connection usable" is a question about the path it
  // is on. A PKCE row is not missing the Custom Connection secret — that field
  // is not part of its credential at all, and counting it would report every
  // variant connection as permanently incomplete.
  const declaredSecrets = credentialSecretFieldsFor(descriptor, variantId);
  const hasCredentials =
    declaredSecrets.length > 0 &&
    declaredSecrets.every((f) => typeof storedSecrets[f.name] === "string");

  return {
    provider: descriptor.id,
    displayName: descriptor.displayName,
    category: descriptor.category,
    state: saasConnectionState(row?.status ?? "NOT_CONFIGURED", hasCredentials),
    hasCredentials,
    // WARP-2489 — the box's own answer, from the hub's own derivation. NOT
    // `!hasCredentials`, which is an `every()` over the declared secrets and
    // goes false the moment one of two is missing while the other is still
    // sealed right here on this row.
    //
    // A row that does not exist is NOT_CONFIGURED, so the predicate returns
    // false through its `status === "DISABLED"` half — nothing was stored, so
    // nothing was purged. Spelling the absent row out as an explicit
    // all-null NOT_CONFIGURED keeps that a stated fact rather than a
    // conclusion drawn from `null`.
    credentialsPurged: credentialsPurgedFor(
      row ?? { status: "NOT_CONFIGURED", apiCredentialsEnc: null, providerTokensEnc: null },
    ),
    configured: row !== null,
    fields,
    values,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    setupGuideHref: setupGuideHrefFor(descriptor) ?? null,
    // Read off the SAME parsed config the form's `values` come from, so the
    // date an admin can see and the date the warning is computed from are one
    // value. A second read of `row.providerConfig` here could disagree with the
    // form after a failed parse.
    //
    // GATED ON A STORED CREDENTIAL. `credentialExpiryVerdict` is handed a
    // descriptor and a config, so it cannot tell "connected, no date recorded"
    // from "never connected" — both read EXPIRY_UNKNOWN. The dashboard renders
    // that as "No expiry date recorded — Droplet can't warn you before this
    // credential stops working", which on a provider nobody has connected is a
    // warning about a thing that does not exist, and it would sit on the card
    // permanently with no action that clears it.
    //
    // "No credential stored" and "credential stored, no expiry date" are
    // different states with different remedies, and only the second is a
    // warning. WARP-2353's `atlassian-token-expiry.ts` held that rule and had
    // no production callers; this is where it belongs, on the path that ships.
    // The first state is already answered by `state` and `hasCredentials` on
    // this same payload, so `null` here is not silence — it is the expiry
    // question not applying yet.
    credentialExpiry: hasCredentials
      ? (credentialExpiryVerdict(descriptor, config, now) ?? null)
      : null,
    // Keyed on the TRACK, never on a provider id: an `mcp` vendor added later
    // gets this for free, and no other track can accidentally grow a session
    // state it has no session for.
    remoteMcp:
      descriptor.track === "mcp" ? lifecycle.view(descriptor.mcpServerId) : null,
  };
}

// --- The write path -------------------------------------------------------

/** The result of resolving a PATCH body against what is already stored. */
export interface ResolvedCredentialUpdate {
  /** The blob to persist, `null` to clear the column, or `undefined` to leave
   *  it exactly as it is (byte-identical — the "omit = keep" case). */
  providerTokensEnc: string | null | undefined;
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

  /**
   * WARP-2491 — resolve the authentication path BEFORE anything else, and
   * throw rather than accumulate.
   *
   * Which variant this write is for decides which fields are even legal, so
   * there is nothing useful to say about the individual fields until it is
   * known. Accumulating a per-field error list against the wrong path would
   * hand the owner a list of complaints about fields their flow does not have.
   *
   * The three-way rule still holds for the discriminator itself: a body that
   * omits it on a row that already records one KEEPS that path. What is refused
   * is a variant this descriptor does not declare (always), and an absent one
   * on a connection that has never recorded a path — the case that used to
   * parse "successfully" with the variant's fields silently dropped.
   */
  const declaredVariants = descriptor.credentialVariants ?? [];
  const storedVariantId = providerConfigVariantId(descriptor, row?.providerConfig);
  let variantId: string | undefined;
  if (declaredVariants.length > 0) {
    const submittedVariant = submitted[CREDENTIAL_VARIANT_FIELD];
    if (typeof submittedVariant === "string" && submittedVariant !== "") {
      if (!declaredVariants.some((v) => v.id === submittedVariant)) {
        throw new SaasCredentialValidationError({
          // The rejected id is NOT echoed. It is caller-supplied text, and a
          // 400 that quotes what was submitted is how submitted values reach
          // every log between here and the browser (rule 19).
          [CREDENTIAL_VARIANT_FIELD]: ["Unknown credential variant."],
        });
      }
      variantId = submittedVariant;
    } else if (storedVariantId !== undefined) {
      variantId = storedVariantId;
    } else {
      throw new SaasCredentialValidationError({
        [CREDENTIAL_VARIANT_FIELD]: ["Choose which credential type this is."],
      });
    }
  }

  const stored: Record<string, string> = (() => {
    if (!row?.providerTokensEnc || !isEncryptedColumn(row.providerTokensEnc)) return {};
    try {
      return openSaasCredentials(row.id, row.providerTokensEnc);
    } catch {
      return {};
    }
  })();

  // --- secrets ---
  const nextSecrets: Record<string, string> = { ...stored };
  /**
   * A secret belonging to a path this connection is NOT on is dropped rather
   * than resealed. After a switch from Custom Connection to PKCE, the old
   * path's client secret is credential material for a flow nobody can use, and
   * carrying it forward would keep it sealed on the row indefinitely with
   * nothing in the UI admitting it is there.
   *
   * Scoped to fields OTHER variants declare, and only when the live path does
   * not declare the same name — a provider with no variants is untouched.
   */
  const liveSecretNames = new Set(
    credentialSecretFieldsFor(descriptor, variantId).map((f) => f.name),
  );
  for (const v of declaredVariants) {
    if (v.id === variantId) continue;
    for (const f of v.fields) {
      if (f.secret && !liveSecretNames.has(f.name)) delete nextSecrets[f.name];
    }
  }
  let touchedSecret = false;
  for (const f of credentialSecretFieldsFor(descriptor, variantId)) {
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
  const configFields = credentialFieldsFor(descriptor, variantId).filter(
    (f) => !f.secret && f.storage === "providerConfig",
  );
  // The chosen path is PERSISTED, first, as an explicit key — never re-derived
  // later from which fields the row happens to carry.
  if (variantId !== undefined) nextConfig[CREDENTIAL_VARIANT_FIELD] = variantId;
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
    providerTokensEnc: !touchedSecret
      ? undefined // omit = keep: the column is not in the update at all
      : hasSecret
        ? sealSaasCredentials(connectionId, nextSecrets)
        : null,
    // A variants-declaring provider always writes a config, even with zero
    // config-stored fields: the chosen path itself has to be recorded.
    providerConfig:
      touchedConfig || configFields.length > 0 || variantId !== undefined
        ? nextConfig
        : undefined,
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
 *
 * ## Why the `mcp` track lands on CONNECTED and every other track does not
 *
 * PROVISIONING means "a credential is present and the connection is being
 * established", and the enum's own docstring adds the rule that makes it
 * honest: *"A row may NOT rest here after a completed probe."* For a `cloud` or
 * `lan` track something completes that probe — `connect()` dials the vendor and
 * writes the verdict.
 *
 * For an `mcp` track nothing does, and nothing CAN, because the probe would be
 * an outbound MCP session and ADR-043 §5 puts that behind
 * `remote-mcp-gateway.service.ts`, whose third gate is `status === "CONNECTED"`
 * on this very row. A probe-before-CONNECTED design is therefore circular: the
 * row would rest at PROVISIONING forever, and a status no writer can advance is
 * worse than a wrong one — it is a state the product can never leave, which the
 * hub and this page would both render as "checking the connection" for the life
 * of the box.
 *
 * So the paste IS the connection for this track, and CONNECTED says exactly
 * that: the customer supplied a complete credential set. The first outbound
 * call is the probe, and its failure is not swallowed — it lands as the
 * bridge's explicit `auth_rejected` session state plus a `provider_error` audit
 * row, and `attachAtlassianRemote` refuses rather than half-attaching. That is
 * a weaker claim than a cloud track's CONNECTED, and it is written down here
 * rather than left for a reader to assume.
 *
 * The DISABLED and no-credential rules are unchanged and apply to every track.
 */
export function statusAfterCredentialUpdate(
  descriptor: ProviderDescriptor,
  current: string,
  hasSecret: boolean,
): IntegrationStatusName {
  if (!hasSecret) return "NOT_CONFIGURED";
  // A row that was DISABLED stays DISABLED — pasting a key is not the same
  // gesture as turning the connector back on.
  if (current === "DISABLED") return "DISABLED";
  if (descriptor.track === "mcp") return "CONNECTED";
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
