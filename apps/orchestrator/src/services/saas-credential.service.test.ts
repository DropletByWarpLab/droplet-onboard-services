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
  type ProviderDescriptor,
} from "@droplet/shared-types";

import { __setColumnCryptoKeyForTest } from "./column-crypto.service.js";
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
    apiCredentialsEnc: null,
    providerConfig: { provider: FIXTURE.id, accountId: "acct-1", region: "us" },
    updatedAt: new Date("2026-08-27T00:00:00.000Z"),
    ...overrides,
  };
}

function sealedRow(secrets: Record<string, string>, overrides: Partial<SaasConnectionRow> = {}) {
  return rowWith({ apiCredentialsEnc: sealSaasCredentials(ROW_ID, secrets), ...overrides });
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
    expect(json).not.toContain("apiCredentialsEnc");
    expect(json).not.toContain("providerTokensEnc");
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
    const view = buildCredentialView(FIXTURE, rowWith({ apiCredentialsEnc: null }));
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
  it("maps a rejected credential to NEEDS_RECONNECT, distinct from both ends", () => {
    const state = saasConnectionState("ERROR", true);
    expect(state).toBe("NEEDS_RECONNECT");
    expect(state).not.toBe("NOT_CONFIGURED");
    expect(state).not.toBe("CONNECTED");
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
});

describe("resolveCredentialUpdate — the three-way rule", () => {
  it("OMIT keeps the stored ciphertext byte-identical", () => {
    const row = sealedRow({ apiKey: SEEDED_SECRET });
    const resolved = resolveCredentialUpdate(FIXTURE, row, { region: "eu" }, ROW_ID);

    // Mutation: treat an omitted field as a clear, and this goes red — the
    // column would be set to null by an admin who only edited the region.
    expect(resolved.apiCredentialsEnc).toBeUndefined();
    expect(resolved.hasSecret).toBe(true);
    expect(resolved.cleared).toBe(false);
  });

  it('EMPTY STRING clears it, and the status falls back to NOT_CONFIGURED', () => {
    const row = sealedRow({ apiKey: SEEDED_SECRET });
    const resolved = resolveCredentialUpdate(FIXTURE, row, { apiKey: "" }, ROW_ID);

    expect(resolved.apiCredentialsEnc).toBeNull();
    expect(resolved.hasSecret).toBe(false);
    expect(resolved.cleared).toBe(true);
    expect(statusAfterCredentialUpdate("CONNECTED", resolved.hasSecret)).toBe(
      "NOT_CONFIGURED",
    );
  });

  it("A VALUE re-encrypts under this row's AAD", () => {
    const row = sealedRow({ apiKey: "rk_test_old" });
    const resolved = resolveCredentialUpdate(FIXTURE, row, { apiKey: "rk_live_new" }, ROW_ID);

    expect(resolved.apiCredentialsEnc).toBeTypeOf("string");
    expect(openSaasCredentials(ROW_ID, resolved.apiCredentialsEnc as string)).toEqual({
      apiKey: "rk_live_new",
    });
  });

  it("distinguishes an ABSENT key from an EMPTY one end to end", () => {
    const row = sealedRow({ apiKey: SEEDED_SECRET });
    // Two bodies that a schema with a default would have flattened into one.
    const omitted = resolveCredentialUpdate(FIXTURE, row, {}, ROW_ID);
    const emptied = resolveCredentialUpdate(FIXTURE, row, { apiKey: "" }, ROW_ID);

    expect(omitted.apiCredentialsEnc).toBeUndefined();
    expect(emptied.apiCredentialsEnc).toBeNull();
    expect(omitted.apiCredentialsEnc).not.toBe(emptied.apiCredentialsEnc);
  });

  it("clears ONE secret without disturbing the other", () => {
    const row = sealedRow({ apiKey: "rk_live_keep", webhookSecret: "WEBHOOK-SEED" });
    const resolved = resolveCredentialUpdate(FIXTURE, row, { webhookSecret: "" }, ROW_ID);

    expect(resolved.hasSecret).toBe(true);
    expect(resolved.cleared).toBe(false);
    expect(openSaasCredentials(ROW_ID, resolved.apiCredentialsEnc as string)).toEqual({
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
