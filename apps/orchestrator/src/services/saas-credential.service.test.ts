/**
 * WARP-2278 / WARP-2279 — the credential service: redaction, the three-way
 * secret resolution, and honest connection state.
 *
 * Every fixture provider here is REGISTERED at runtime through WARP-2217's
 * extension seam rather than being one of the shipped vendors. Two reasons, and
 * both are the point of the story:
 *
 *  - it proves the service is genuinely generic — it renders and validates a
 *    provider it has never heard of, which is the zero-vendor-string AC;
 *  - it lets a fixture declare a `pattern`, which no shipped descriptor does
 *    yet, so the server-side format refusal can be tested at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerProviderDescriptor,
  __resetRegisteredProvidersForTest,
  CREDENTIAL_VARIANT_FIELD,
  SAAS_CONNECTION_STATES,
  type ProviderDescriptor,
} from "@droplet/shared-types";

import { __setColumnCryptoKeyForTest } from "./column-crypto.service.js";
import { credentialsPurgedFor } from "./integrations.service.js";
import {
  buildCredentialView,
  openSaasCredentials,
  resolveCredentialUpdate,
  saasConnectionState,
  sealSaasCredentials,
  statusAfterCredentialUpdate,
  SaasCredentialValidationError,
  type SaasConnectionRow,
} from "./saas-credential.service.js";

const TEST_KEY = Buffer.alloc(32, 4).toString("base64");
const ROW_ID = "conn_fixture_0000000001";
/** Not shaped like a real vendor key on purpose — every `not.toContain`
 *  assertion below is only meaningful if this string is unmistakable. */
const SEEDED_SECRET = "SEEDED-CREDENTIAL-VALUE";

/**
 * A two-secret, two-config fixture with a format-constrained key.
 *
 * The `pattern` mirrors the class of vendor whose restricted-key prefix is a
 * contractual guarantee: a full-access key pasted where a restricted one is
 * required must be REFUSED by the box, not forwarded to the vendor.
 */
const FIXTURE: ProviderDescriptor = {
  id: "fixture-billing",
  displayName: "Fixture Billing",
  category: "Accounting",
  track: "cloud",
  credentialFields: [
    {
      name: "accountId",
      label: "Account id",
      type: "string",
      required: true,
      secret: false,
      storage: "providerConfig",
      help: "Found in the vendor console.",
    },
    {
      name: "region",
      label: "Region",
      type: "string",
      required: false,
      secret: false,
      storage: "providerConfig",
    },
    {
      name: "apiKey",
      label: "Restricted API key",
      type: "string",
      required: true,
      secret: true,
      storage: "encrypted",
      pattern: "^rk_(live|test)_",
    },
    {
      name: "webhookSecret",
      label: "Webhook signing secret",
      type: "string",
      required: false,
      secret: true,
      storage: "encrypted",
    },
  ],
  egressHosts: ["api.fixture-billing.invalid"],
  datasets: ["invoice"],
};

/** A second, structurally different provider — one secret, no pattern, one
 *  optional config field — used to prove ONE component/service renders both. */
const FIXTURE_TWO: ProviderDescriptor = {
  id: "fixture-crm",
  displayName: "Fixture CRM",
  category: "CRM",
  track: "cloud",
  credentialFields: [
    {
      name: "portalId",
      label: "Portal id",
      type: "string",
      required: false,
      secret: false,
      storage: "providerConfig",
    },
    {
      name: "privateToken",
      label: "Private app token",
      type: "string",
      required: true,
      secret: true,
      storage: "encrypted",
    },
  ],
  egressHosts: ["api.fixture-crm.invalid"],
  datasets: [],
};

function rowWith(overrides: Partial<SaasConnectionRow> = {}): SaasConnectionRow {
  return {
    id: ROW_ID,
    provider: FIXTURE.id,
    status: "PROVISIONING",
    providerTokensEnc: null,
    // The Eaglesoft REST track's column. Explicitly null rather than absent:
    // "was this credential purged" reads BOTH columns, and a fixture that
    // omitted one would answer the question with a column it never set.
    apiCredentialsEnc: null,
    providerConfig: { provider: FIXTURE.id, accountId: "acct-1", region: "us" },
    updatedAt: new Date("2026-08-27T00:00:00.000Z"),
    ...overrides,
  };
}

function sealedRow(secrets: Record<string, string>, overrides: Partial<SaasConnectionRow> = {}) {
  return rowWith({ providerTokensEnc: sealSaasCredentials(ROW_ID, secrets), ...overrides });
}

beforeEach(() => {
  __setColumnCryptoKeyForTest(TEST_KEY);
  __resetRegisteredProvidersForTest();
  registerProviderDescriptor(FIXTURE);
  registerProviderDescriptor(FIXTURE_TWO);
});

afterEach(() => {
  __resetRegisteredProvidersForTest();
});

describe("buildCredentialView — redaction", () => {
  it("never emits the secret, nor the encrypted column, nor a row spread", () => {
    const row = sealedRow({ apiKey: SEEDED_SECRET, webhookSecret: "OTHER-SEEDED-VALUE" });
    const view = buildCredentialView(FIXTURE, row);
    const json = JSON.stringify(view);

    // Mutation: `return { ...row, hasApiKey }` in buildCredentialView turns
    // every one of these red — the ciphertext key reappears, and with it the
    // habit of shipping whatever column the schema grows next.
    expect(json).not.toContain(SEEDED_SECRET);
    expect(json).not.toContain("OTHER-SEEDED-VALUE");
    // Both encrypted columns, not just the one this path writes: the view is
    // built from a row that could carry either, and a spread would ship both.
    expect(json).not.toContain("providerTokensEnc");
    expect(json).not.toContain("apiCredentialsEnc");
    expect(Object.keys(view)).not.toContain("providerTokensEnc");
    expect(Object.keys(view)).not.toContain("apiCredentialsEnc");
  });

  it("collapses each secret field to a hasValue boolean", () => {
    const view = buildCredentialView(FIXTURE, sealedRow({ apiKey: SEEDED_SECRET }));
    const byName = Object.fromEntries(view.fields.map((f) => [f.name, f]));

    expect(byName.apiKey.hasValue).toBe(true);
    // Declared but not stored — false, not undefined. The form needs to tell
    // "set" from "we don't know", and undefined would render as neither.
    expect(byName.webhookSecret.hasValue).toBe(false);
    // A non-secret field has no hasValue concept; its actual value is returned.
    expect(byName.accountId.hasValue).toBeNull();
    expect(view.values.accountId).toBe("acct-1");
  });

  it("reports hasValue false after a clear", () => {
    const view = buildCredentialView(FIXTURE, rowWith({ providerTokensEnc: null }));
    expect(view.fields.find((f) => f.name === "apiKey")?.hasValue).toBe(false);
    expect(view.hasCredentials).toBe(false);
  });

  it("carries the descriptor's own field metadata, including the pattern", () => {
    const view = buildCredentialView(FIXTURE, null);
    const apiKey = view.fields.find((f) => f.name === "apiKey");
    expect(apiKey).toMatchObject({
      label: "Restricted API key",
      required: true,
      secret: true,
      pattern: "^rk_(live|test)_",
    });
  });

  it("renders a second, structurally different provider from its descriptor alone", () => {
    // The generic claim: one function, two providers, no branch between them.
    const view = buildCredentialView(FIXTURE_TWO, null);
    expect(view.fields.map((f) => f.name)).toEqual(["portalId", "privateToken"]);
    expect(view.fields.find((f) => f.name === "privateToken")?.secret).toBe(true);
  });

  it("treats an unreadable blob as absent rather than throwing at the reader", () => {
    // A factory reset regenerated DEVICE_SECRET_KEY: the rows survive, the key
    // does not. The person must be routed to "paste it again", which is the
    // only thing that works — not to a 500.
    const row = sealedRow({ apiKey: SEEDED_SECRET });
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 5).toString("base64"));
    const view = buildCredentialView(FIXTURE, row);
    expect(view.hasCredentials).toBe(false);
    expect(view.state).toBe("NOT_CONFIGURED");
  });
});

describe("saasConnectionState — honesty", () => {
  it("passes NEEDS_RECONNECT through, distinct from both ends", () => {
    // WARP-2458 made this a PERSISTED status. Before it existed this function
    // had to infer it from `ERROR` + a credential being present, because the
    // enum could not express it; `connect()`'s probe now writes the real
    // member, so the inference is gone.
    // Mutation: fold NEEDS_RECONNECT back into the CONNECTED branch → red.
    const state = saasConnectionState("NEEDS_RECONNECT", true);
    expect(state).toBe("NEEDS_RECONNECT");
    expect(state).not.toBe("NOT_CONFIGURED");
    expect(state).not.toBe("CONNECTED");
  });

  it("no longer rewrites ERROR into NEEDS_RECONNECT", () => {
    // The inference this replaced was wrong once a real member existed. ERROR
    // means what the enum's docstring says — reconnecting will NOT fix it (a
    // Stripe key whose IP access policy refuses this box, a Mailchimp plan
    // that excludes the resource). Telling that owner to paste a new key sends
    // them to mint credentials until one works.
    // Mutation: restore `case "ERROR": return "NEEDS_RECONNECT"` → red.
    expect(saasConnectionState("ERROR", true)).toBe("ERROR");
  });

  it("keeps the DISABLED / NOT_CONFIGURED / NEEDS_RECONNECT triple pairwise distinct", () => {
    // ADR-042 §6's requirement, asserted directly: all three look identical to
    // a "does a credential decrypt?" check and mean opposite things to the
    // person reading the dashboard.
    // Mutation: collapse any pair → red.
    const triple = [
      saasConnectionState("DISABLED", true),
      saasConnectionState("CONNECTED", false),
      saasConnectionState("NEEDS_RECONNECT", true),
    ];
    expect(triple).toEqual(["DISABLED", "NOT_CONFIGURED", "NEEDS_RECONNECT"]);
    expect(new Set(triple).size).toBe(3);
  });

  it("never reports CONNECTED for a row whose credential is gone", () => {
    // The failure mode the configurator exists to prevent: a CONNECTED row
    // returning empty results because there is nothing to authenticate with.
    expect(saasConnectionState("CONNECTED", false)).toBe("NOT_CONFIGURED");
  });

  it("keeps DISABLED distinct from both — an operator turned it off", () => {
    expect(saasConnectionState("DISABLED", true)).toBe("DISABLED");
    expect(saasConnectionState("DISABLED", false)).toBe("DISABLED");
  });

  it("reports a stored-but-unproven credential as PROVISIONING", () => {
    expect(saasConnectionState("NOT_CONFIGURED", true)).toBe("PROVISIONING");
    expect(saasConnectionState("PROVISIONING", true)).toBe("PROVISIONING");
  });

  it("passes CAPABILITY_LIMITED through — the connection WORKS", () => {
    // WARP-2623. The case shipped with no test at all: deleting its two lines
    // dropped the status through to `default: return "PROVISIONING"`, the
    // credentials page said "Setting up..." about a connection that has been
    // reading data for months, and every suite in the repo stayed green.
    // Mutation: delete `case "CAPABILITY_LIMITED"` → PROVISIONING → red.
    expect(saasConnectionState("CAPABILITY_LIMITED", true)).toBe("CAPABILITY_LIMITED");
    // And it is not any of the three things it is deliberately NOT: the key is
    // fine, nothing is being set up, and nothing needs repairing.
    expect(saasConnectionState("CAPABILITY_LIMITED", true)).not.toBe("PROVISIONING");
    expect(saasConnectionState("CAPABILITY_LIMITED", true)).not.toBe("NEEDS_RECONNECT");
    expect(saasConnectionState("CAPABILITY_LIMITED", true)).not.toBe("ERROR");
  });

  /**
   * The gate the `default` arm needed and did not have.
   *
   * `integration-status.schema.test.ts:290-343` set-compares
   * `SAAS_CONNECTION_STATES` against the Prisma enum and nothing else, so a
   * newly-added status passes every gate in the repo and still falls silently
   * through `default: return "PROVISIONING"`. That is how `CAPABILITY_LIMITED`
   * came to ship a case with no test: the parity gate said the LISTS agreed,
   * which is a different claim from the FUNCTION agreeing with them.
   *
   * Stated as an identity over the whole list rather than one `it` per member,
   * because the thing being asserted is a property of the mapping and not of
   * any one status: every state a person can be shown is the status of the
   * same name, except the three the docstring derives. Those three are named
   * here explicitly — a set difference would let a member vanish from both
   * sides at once and still read as green.
   */
  it("maps every non-derived status to the state of the same name", () => {
    // Mutation: drop any `case` from the switch, or add a member to
    // SAAS_CONNECTION_STATES without giving the switch an arm → red here even
    // though the Prisma-parity gate stays green.
    const DERIVED = new Set([
      // `!hasCredentials` short-circuits before the switch; with a credential
      // present these two mean "we hold something unproven".
      "NOT_CONFIGURED",
      "PROVISIONING",
      // Wins over everything, above the switch.
      "DISABLED",
    ]);
    const passthrough = SAAS_CONNECTION_STATES.filter((s) => !DERIVED.has(s));
    // Guards the guard: if the derived list ever swallowed the union this
    // would assert nothing at all.
    expect(passthrough.length).toBeGreaterThan(4);
    for (const status of passthrough) {
      expect(saasConnectionState(status, true)).toBe(status);
    }
  });

  it("still answers DISABLED and the credential-less rule for every status", () => {
    // The two derivations are stated over the WHOLE list too, so a new member
    // cannot quietly acquire an exception to either.
    for (const status of SAAS_CONNECTION_STATES) {
      expect(saasConnectionState(status, false)).toBe(
        status === "DISABLED" ? "DISABLED" : "NOT_CONFIGURED",
      );
    }
    expect(saasConnectionState("DISABLED", true)).toBe("DISABLED");
  });
});

/**
 * WARP-2489 — the purge fact `/integrations/credentials` renders.
 *
 * WARP-2483 gave that page its "credential removed" line and fed it
 * `!hasCredentials`. Those are different questions. `hasCredentials` is an
 * `every()` over the descriptor's DECLARED secrets, so a provider with two of
 * them and one stored answers `false` — and the page then told an admin the key
 * had been destroyed while it was still sealed on the row, on the one screen in
 * the product where ADR-041 §2's promise is made to the person it is made to.
 *
 * `FIXTURE` declares exactly that shape. WARP-2483's own suite exercised a
 * ONE-secret fixture, where `!hasCredentials` and "the blob is gone" coincide,
 * which is why it was green over a defect.
 *
 * The view now carries the box's own answer, from `credentialsPurgedFor` — the
 * same call the hub's payload is built from, not a second implementation of it.
 */
describe("buildCredentialView — credentialsPurged", () => {
  it("refuses to claim a purge while one of two declared secrets is still stored", () => {
    // The fixture WARP-2483's suite lacked: FIXTURE declares `apiKey` AND
    // `webhookSecret`; only `apiKey` is sealed here.
    const row = sealedRow({ apiKey: SEEDED_SECRET }, { status: "DISABLED" });
    const view = buildCredentialView(FIXTURE, row);

    // The two booleans genuinely disagree at this row, and the disagreement IS
    // the defect: the old code read the left one as the answer to the right
    // one's question.
    expect(view.hasCredentials).toBe(false);
    // Mutation: `credentialsPurged: !hasCredentials` → true → red, and an
    // admin is told a key was destroyed that Postgres can still open.
    expect(view.credentialsPurged).toBe(false);
  });

  it("reports the purge when the row holds neither credential blob", () => {
    const view = buildCredentialView(
      FIXTURE,
      rowWith({ status: "DISABLED", providerTokensEnc: null, apiCredentialsEnc: null }),
    );
    // Mutation: hardcode `false` → red. The finished state has to be sayable
    // too, or the page can never confirm the purge actually happened.
    expect(view.credentialsPurged).toBe(true);
  });

  it("counts the column hasCredentials never looks at", () => {
    // `hasCredentials` is computed from `providerTokensEnc` alone. A DISABLED
    // row still holding `apiCredentialsEnc` has NOT been purged, the hub
    // already says so, and the page must not contradict it.
    const view = buildCredentialView(
      FIXTURE,
      rowWith({
        status: "DISABLED",
        providerTokensEnc: null,
        apiCredentialsEnc: "dcv1:leftover-eaglesoft-blob",
      }),
    );
    expect(view.hasCredentials).toBe(false);
    // Mutation: drop `apiCredentialsEnc` from the predicate → true → red.
    expect(view.credentialsPurged).toBe(false);
  });

  it("is false for a connection nobody disconnected, and for one never configured", () => {
    const connected = buildCredentialView(
      FIXTURE,
      sealedRow(
        { apiKey: SEEDED_SECRET, webhookSecret: "OTHER-SEEDED-VALUE" },
        { status: "CONNECTED" },
      ),
    );
    expect(connected.hasCredentials).toBe(true);
    expect(connected.credentialsPurged).toBe(false);

    // Nothing was ever stored, so nothing went. Explicit `false`, never an
    // omitted key — absence must not read as "unknown" on the wire.
    const absent = buildCredentialView(FIXTURE, null);
    // Mutation: drop the `status === "DISABLED"` half of the predicate → a
    // provider nobody ever configured claims its credential was removed → red.
    expect(absent.credentialsPurged).toBe(false);
    expect(Object.keys(absent)).toContain("credentialsPurged");
  });

  it("gives the same answer the hub's payload does, from the same call", () => {
    // Not "kept in sync" — the same function. Mutation: re-derive it inside
    // `buildCredentialView` from `hasCredentials` and the one-of-two row goes
    // red while every other row in this table stays green, which is precisely
    // how the defect survived review.
    const rows: SaasConnectionRow[] = [
      sealedRow({ apiKey: SEEDED_SECRET }, { status: "DISABLED" }),
      sealedRow({ apiKey: SEEDED_SECRET, webhookSecret: "OTHER-SEEDED-VALUE" }, {
        status: "DISABLED",
      }),
      rowWith({ status: "DISABLED", providerTokensEnc: null }),
      rowWith({ status: "DISABLED", apiCredentialsEnc: "dcv1:leftover-eaglesoft-blob" }),
      sealedRow({ apiKey: SEEDED_SECRET }, { status: "CONNECTED" }),
      rowWith({ status: "ERROR" }),
    ];
    for (const row of rows) {
      expect(buildCredentialView(FIXTURE, row).credentialsPurged).toBe(
        credentialsPurgedFor(row),
      );
    }
  });
});

describe("resolveCredentialUpdate — the three-way rule", () => {
  it("OMIT keeps the stored ciphertext byte-identical", () => {
    const row = sealedRow({ apiKey: SEEDED_SECRET });
    const resolved = resolveCredentialUpdate(FIXTURE, row, { region: "eu" }, ROW_ID);

    // Mutation: treat an omitted field as a clear, and this goes red — the
    // column would be set to null by an admin who only edited the region.
    expect(resolved.providerTokensEnc).toBeUndefined();
    expect(resolved.hasSecret).toBe(true);
    expect(resolved.cleared).toBe(false);
  });

  it('EMPTY STRING clears it, and the status falls back to NOT_CONFIGURED', () => {
    const row = sealedRow({ apiKey: SEEDED_SECRET });
    const resolved = resolveCredentialUpdate(FIXTURE, row, { apiKey: "" }, ROW_ID);

    expect(resolved.providerTokensEnc).toBeNull();
    expect(resolved.hasSecret).toBe(false);
    expect(resolved.cleared).toBe(true);
    expect(statusAfterCredentialUpdate("CONNECTED", resolved.hasSecret)).toBe(
      "NOT_CONFIGURED",
    );
  });

  it("A VALUE re-encrypts under this row's AAD", () => {
    const row = sealedRow({ apiKey: "rk_test_old" });
    const resolved = resolveCredentialUpdate(FIXTURE, row, { apiKey: "rk_live_new" }, ROW_ID);

    expect(resolved.providerTokensEnc).toBeTypeOf("string");
    expect(openSaasCredentials(ROW_ID, resolved.providerTokensEnc as string)).toEqual({
      apiKey: "rk_live_new",
    });
  });

  it("distinguishes an ABSENT key from an EMPTY one end to end", () => {
    const row = sealedRow({ apiKey: SEEDED_SECRET });
    // Two bodies that a schema with a default would have flattened into one.
    const omitted = resolveCredentialUpdate(FIXTURE, row, {}, ROW_ID);
    const emptied = resolveCredentialUpdate(FIXTURE, row, { apiKey: "" }, ROW_ID);

    expect(omitted.providerTokensEnc).toBeUndefined();
    expect(emptied.providerTokensEnc).toBeNull();
    expect(omitted.providerTokensEnc).not.toBe(emptied.providerTokensEnc);
  });

  it("clears ONE secret without disturbing the other", () => {
    const row = sealedRow({ apiKey: "rk_live_keep", webhookSecret: "WEBHOOK-SEED" });
    const resolved = resolveCredentialUpdate(FIXTURE, row, { webhookSecret: "" }, ROW_ID);

    expect(resolved.hasSecret).toBe(true);
    expect(resolved.cleared).toBe(false);
    expect(openSaasCredentials(ROW_ID, resolved.providerTokensEnc as string)).toEqual({
      apiKey: "rk_live_keep",
    });
  });
});

describe("resolveCredentialUpdate — server-side descriptor validation", () => {
  it("REFUSES a value that does not match the descriptor's pattern", () => {
    // The contractual refusal: a full-access key where the descriptor says a
    // restricted one is required. Enforced here, on the server, because a form
    // hint is a courtesy and this is the guarantee.
    expect(() =>
      resolveCredentialUpdate(FIXTURE, null, { accountId: "a", apiKey: "sk_live_wrong" }, ROW_ID),
    ).toThrow(SaasCredentialValidationError);
  });

  it("names the offending field WITHOUT echoing its value", () => {
    try {
      resolveCredentialUpdate(FIXTURE, null, { accountId: "a", apiKey: "sk_live_wrong" }, ROW_ID);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaasCredentialValidationError);
      const e = err as SaasCredentialValidationError;
      expect(Object.keys(e.fieldErrors)).toContain("apiKey");
      // A 400 that quoted the rejected key would put it in the response body
      // and every log between here and the browser.
      expect(JSON.stringify(e.fieldErrors)).not.toContain("sk_live_wrong");
    }
  });

  it("accepts a value that DOES match the pattern", () => {
    const resolved = resolveCredentialUpdate(
      FIXTURE,
      null,
      { accountId: "a", apiKey: "rk_live_ok" },
      ROW_ID,
    );
    expect(resolved.hasSecret).toBe(true);
  });

  it("rejects a required config field cleared out of an existing row", () => {
    // Clearing the account id breaks the connection just as surely as never
    // setting it — refuse at write time, not at dial time.
    const row = sealedRow({ apiKey: "rk_live_ok" });
    expect(() =>
      resolveCredentialUpdate(FIXTURE, row, { accountId: "" }, ROW_ID),
    ).toThrow(SaasCredentialValidationError);
  });

  it("keeps a stored config field when the body omits it", () => {
    const row = sealedRow({ apiKey: "rk_live_ok" });
    const resolved = resolveCredentialUpdate(FIXTURE, row, { region: "eu" }, ROW_ID);
    expect(resolved.providerConfig).toEqual({ accountId: "acct-1", region: "eu" });
  });
});

describe("openSaasCredentials — fails closed across rows", () => {
  it("throws rather than returning an empty bundle for another row's blob", () => {
    const blob = sealSaasCredentials(ROW_ID, { apiKey: SEEDED_SECRET });
    expect(() => openSaasCredentials("conn_a_different_row", blob)).toThrow();
  });
});

// ===========================================================================
// WARP-2491 — a provider with a discriminated credential choice
// ===========================================================================

/**
 * Two mutually exclusive authentication paths, modelled on Xero (WARP-2383).
 *
 * Each path owns one secret and one `providerConfig` field the other does not,
 * which is what makes the drop observable: "the other path's field is absent"
 * is a key that is either there or not, rather than a vague rejection.
 */
const VARIANT_FIXTURE: ProviderDescriptor = {
  id: "fixture-two-path",
  displayName: "Fixture Two-Path",
  category: "Accounting",
  track: "cloud",
  credentialFields: [
    {
      name: "tenantId",
      label: "Tenant ID",
      type: "string",
      required: true,
      secret: false,
      storage: "providerConfig",
    },
  ],
  credentialVariants: [
    {
      id: "custom-connection",
      label: "Custom Connection",
      fields: [
        {
          name: "connectionName",
          label: "Connection name",
          type: "string",
          required: true,
          secret: false,
          storage: "providerConfig",
        },
        {
          name: "customSecret",
          label: "Custom Connection secret",
          type: "string",
          required: true,
          secret: true,
          storage: "encrypted",
        },
      ],
    },
    {
      id: "pkce-app",
      label: "Your own PKCE app",
      fields: [
        {
          name: "pkceClientId",
          label: "PKCE client ID",
          type: "string",
          required: true,
          secret: false,
          storage: "providerConfig",
        },
        {
          name: "pkceSecret",
          label: "PKCE client secret",
          type: "string",
          required: true,
          secret: true,
          storage: "encrypted",
        },
      ],
    },
  ],
  egressHosts: ["two-path.example.test"],
  datasets: [],
};

const VARIANT_ROW_ID = "conn_variant_000000000001";

/** A row already saved on the Custom Connection path. */
function variantRow(
  overrides: Partial<SaasConnectionRow> = {},
  secrets: Record<string, string> = { customSecret: SEEDED_SECRET },
): SaasConnectionRow {
  return {
    id: VARIANT_ROW_ID,
    provider: VARIANT_FIXTURE.id,
    status: "CONNECTED",
    providerTokensEnc: sealSaasCredentials(VARIANT_ROW_ID, secrets),
    apiCredentialsEnc: null,
    providerConfig: {
      provider: VARIANT_FIXTURE.id,
      [CREDENTIAL_VARIANT_FIELD]: "custom-connection",
      tenantId: "t-1",
      connectionName: "Acme Books",
    },
    updatedAt: new Date("2026-08-27T00:00:00.000Z"),
    ...overrides,
  };
}

describe("the read view is variant-aware", () => {
  beforeEach(() => registerProviderDescriptor(VARIANT_FIXTURE));

  /**
   * Mutation: build the view's fields from `descriptor.credentialFields` alone
   * (the pre-WARP-2491 line) → red on both assertions. The chosen path's
   * fields vanish from the form, which is the browser half of the same defect:
   * the box asks for a credential it will not store.
   */
  it("renders the chosen path's fields, and not the other path's", () => {
    const view = buildCredentialView(VARIANT_FIXTURE, variantRow());
    const names = view.fields.map((f) => f.name);

    expect(names).toEqual(["tenantId", "connectionName", "customSecret"]);
    expect(names).not.toContain("pkceClientId");
    expect(names).not.toContain("pkceSecret");
  });

  /**
   * `hasValue` is the read view's whole answer about a secret, and it has to be
   * asked of the RIGHT secret.
   *
   * Mutation: drop the `variantId` argument from `credentialSecretFieldsFor`
   * → red, because `hasCredentials` is then an `every()` over both paths'
   * secrets and a fully-configured Custom Connection row reports unusable.
   */
  it("answers hasValue and hasCredentials about the path the row is on", () => {
    const view = buildCredentialView(VARIANT_FIXTURE, variantRow());
    const byName = Object.fromEntries(view.fields.map((f) => [f.name, f]));

    expect(byName.customSecret.hasValue).toBe(true);
    expect(byName.tenantId.hasValue).toBeNull();
    // The PKCE secret is not missing — it is not part of this credential.
    expect(view.hasCredentials).toBe(true);
    expect(view.state).toBe("CONNECTED");
  });

  it("emits the chosen variant's non-secret value, and never a secret's", () => {
    const view = buildCredentialView(VARIANT_FIXTURE, variantRow());
    expect(view.values.connectionName).toBe("Acme Books");
    expect(view.values.tenantId).toBe("t-1");
    expect(JSON.stringify(view)).not.toContain(SEEDED_SECRET);
  });
});

describe("the write path is variant-aware", () => {
  beforeEach(() => registerProviderDescriptor(VARIANT_FIXTURE));

  /**
   * THE mutation test for the service half.
   *
   * Mutation: ignore the discriminator — resolve `configFields` from
   * `credentialFieldsFor(descriptor, undefined)`, or union every variant's
   * fields — and this goes red, because `pkceClientId` is then written into a
   * Custom Connection row's config.
   */
  it("stores the chosen path's fields and refuses the other path's", () => {
    const resolved = resolveCredentialUpdate(
      VARIANT_FIXTURE,
      null,
      {
        [CREDENTIAL_VARIANT_FIELD]: "custom-connection",
        tenantId: "t-1",
        connectionName: "Acme Books",
        customSecret: "CUSTOM-PATH-SECRET",
        // Belongs to the path NOT chosen.
        pkceClientId: "should-not-be-stored",
      },
      VARIANT_ROW_ID,
    );

    expect(resolved.providerConfig?.connectionName).toBe("Acme Books");
    expect(resolved.providerConfig && "pkceClientId" in resolved.providerConfig).toBe(false);
    // The choice is PERSISTED explicitly — never re-derived from which fields
    // the row happens to carry.
    expect(resolved.providerConfig?.[CREDENTIAL_VARIANT_FIELD]).toBe("custom-connection");

    const sealed = openSaasCredentials(VARIANT_ROW_ID, resolved.providerTokensEnc as string);
    expect(sealed.customSecret).toBe("CUSTOM-PATH-SECRET");
    expect("pkceSecret" in sealed).toBe(false);
  });

  it("rejects a body that names no path on a connection that has none", () => {
    // Mutation: fall back to the first variant instead of throwing → red. That
    // fallback is a FORM behaviour; here it would persist a path the owner
    // never chose and call the row configured.
    try {
      resolveCredentialUpdate(
        VARIANT_FIXTURE,
        null,
        { tenantId: "t-1", connectionName: "Acme Books" },
        VARIANT_ROW_ID,
      );
      expect.unreachable("a missing discriminator must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(SaasCredentialValidationError);
      const fieldErrors = (err as SaasCredentialValidationError).fieldErrors;
      expect(Object.keys(fieldErrors)).toEqual([CREDENTIAL_VARIANT_FIELD]);
    }
  });

  it("rejects a path the descriptor does not declare, without echoing it back", () => {
    try {
      resolveCredentialUpdate(
        VARIANT_FIXTURE,
        null,
        { [CREDENTIAL_VARIANT_FIELD]: "oauth-implicit", tenantId: "t-1" },
        VARIANT_ROW_ID,
      );
      expect.unreachable("an unknown discriminator must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(SaasCredentialValidationError);
      const fieldErrors = (err as SaasCredentialValidationError).fieldErrors;
      expect(fieldErrors[CREDENTIAL_VARIANT_FIELD]).toEqual(["Unknown credential variant."]);
      // Rule 19 — the submitted value is not quoted back into a 400 body that
      // every log between here and the browser will carry.
      expect(JSON.stringify(fieldErrors)).not.toContain("oauth-implicit");
    }
  });

  /**
   * The three-way rule (WARP-2278) still governs the discriminator itself.
   *
   * Mutation: throw whenever the body omits it → red, because editing a tenant
   * id on a saved connection would then demand the owner re-pick their path.
   */
  it("keeps the stored path when the body omits the discriminator", () => {
    const resolved = resolveCredentialUpdate(
      VARIANT_FIXTURE,
      variantRow(),
      { tenantId: "t-2" },
      VARIANT_ROW_ID,
    );

    expect(resolved.providerConfig?.[CREDENTIAL_VARIANT_FIELD]).toBe("custom-connection");
    expect(resolved.providerConfig?.tenantId).toBe("t-2");
    // Untouched secret survives, byte-identical — the column is not in the
    // update at all.
    expect(resolved.providerTokensEnc).toBeUndefined();
  });

  /**
   * Switching path must not leave the abandoned path's secret sealed on the
   * row: it is credential material for a flow nobody can use, and nothing in
   * the UI would admit it is still there.
   *
   * Mutation: drop the other-variant delete loop → red, `customSecret`
   * reappears in the resealed blob.
   */
  it("drops the abandoned path's secret when the owner switches", () => {
    const resolved = resolveCredentialUpdate(
      VARIANT_FIXTURE,
      variantRow(),
      {
        [CREDENTIAL_VARIANT_FIELD]: "pkce-app",
        tenantId: "t-1",
        pkceClientId: "c-1",
        pkceSecret: "PKCE-PATH-SECRET",
      },
      VARIANT_ROW_ID,
    );

    const sealed = openSaasCredentials(VARIANT_ROW_ID, resolved.providerTokensEnc as string);
    expect(sealed.pkceSecret).toBe("PKCE-PATH-SECRET");
    expect("customSecret" in sealed).toBe(false);
    // The shared field belongs to the ACCOUNT and survives the switch; the old
    // path's config field does not.
    expect(resolved.providerConfig?.tenantId).toBe("t-1");
    expect(resolved.providerConfig && "connectionName" in resolved.providerConfig).toBe(false);
    expect(resolved.providerConfig?.[CREDENTIAL_VARIANT_FIELD]).toBe("pkce-app");
  });

  it("still requires the chosen path's own required field", () => {
    try {
      resolveCredentialUpdate(
        VARIANT_FIXTURE,
        null,
        { [CREDENTIAL_VARIANT_FIELD]: "pkce-app", tenantId: "t-1", pkceSecret: "s" },
        VARIANT_ROW_ID,
      );
      expect.unreachable("a required variant field must be enforced");
    } catch (err) {
      expect(err).toBeInstanceOf(SaasCredentialValidationError);
      expect(
        (err as SaasCredentialValidationError).fieldErrors.pkceClientId,
      ).toEqual(["PKCE client ID is required."]);
    }
  });
});
