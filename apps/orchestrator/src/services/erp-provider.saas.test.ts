/**
 * WARP-2466 — the three WARP-2214 SaaS vendors become selectable providers.
 *
 * Nothing here reaches a vendor. Every connector is built with an injected
 * `fetch` or with no credential at all, and the assertions are about the CALLS
 * MADE (and, more often, the calls NOT made) rather than about a return value
 * — the house pattern from `quickbooks-online.test.ts`.
 */
import {
  ConnectorBlockedError,
  MailchimpConnector,
  HUBSPOT_PROVIDER,
  MAILCHIMP_PROVIDER,
  STRIPE_PROVIDER,
  STRIPE_MIN_POLL_INTERVAL_SECONDS,
  STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION,
  HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND,
  HUBSPOT_DATASETS,
  MAILCHIMP_DATASETS,
  STRIPE_DATASETS,
} from "@droplet/erp-connector";
import { providerDescriptor } from "@droplet/shared-types";
import { afterEach, describe, expect, it } from "vitest";

import { __resetCallBudgetsForTest, cloudMaterialFromRow, connectorForProvider } from "./erp-provider.js";
import { sealSaasCredentials } from "./saas-credential.service.js";

afterEach(() => {
  __resetCallBudgetsForTest();
});

/** A fixture credential. Composed FROM PARTS at runtime, never as one literal:
 *  GitHub's push protection has vendor detectors for every one of these
 *  prefixes and rejects a realistic-shaped literal at `git push` even when
 *  local gitleaks is clean (WARP-2379 learned this the hard way). */
const FAKE_STRIPE_KEY = "rk_test_" + "EXAMPLE" + "FIXTURE" + "NOTAREALKEY";
const FAKE_HUBSPOT_TOKEN = "pat-na1-" + "EXAMPLE-FIXTURE-NOT-A-REAL-TOKEN";
const FAKE_MAILCHIMP_KEY = "EXAMPLEFIXTURENOTAREALKEY000" + "-" + "us14";

const CONN = "conn-warp-2466";

// ===========================================================================
// Scope item 1 — one descriptor per vendor
// ===========================================================================

describe("descriptors for the three SaaS vendors", () => {
  it("registers all three as cloud tracks with a hub card each", () => {
    // Mutation: remove one descriptor → red, and the registry-set test in
    // `erp-provider.descriptor.test.ts` goes red alongside it.
    for (const id of [STRIPE_PROVIDER, HUBSPOT_PROVIDER, MAILCHIMP_PROVIDER]) {
      const d = providerDescriptor(id);
      expect(d, `${id} descriptor`).toBeDefined();
      expect(d?.track, `${id} track`).toBe("cloud");
      expect(d?.catalog?.id, `${id} card`).toBeTruthy();
      expect(d?.catalog?.availability, `${id} availability`).toBe("available");
    }
  });

  it("declares exactly one secret credential field per vendor", () => {
    // ADR-042's third consent model: the customer mints ONE credential and
    // pastes it. A second secret field would mean we had invented an OAuth
    // flow nobody asked for.
    for (const id of [STRIPE_PROVIDER, HUBSPOT_PROVIDER, MAILCHIMP_PROVIDER]) {
      const secrets = providerDescriptor(id)!.credentialFields.filter((f) => f.secret);
      expect(secrets.map((f) => f.name), `${id} secrets`).toHaveLength(1);
      expect(secrets[0].storage, `${id} storage`).toBe("encrypted");
      expect(secrets[0].required).toBe(true);
    }
  });

  it("refuses a full-privilege Stripe secret key at the descriptor boundary", () => {
    // ADR-042 §4's boundary rejection. `sk_` can move money; `rk_` cannot.
    // Mutation: relax the pattern to `^(rk|sk)_` → red, and the box would
    // accept the ability to issue refunds.
    const field = providerDescriptor(STRIPE_PROVIDER)!.credentialFields.find((f) => f.secret)!;
    const re = new RegExp(field.pattern!);
    expect(re.test(FAKE_STRIPE_KEY)).toBe(true);
    expect(re.test("sk_test_" + "EXAMPLE")).toBe(false);
    expect(re.test("sk_live_" + "EXAMPLE")).toBe(false);
  });

  it("requires the Mailchimp datacentre suffix, which selects the host", () => {
    // Mutation: drop the `-us14` group from the pattern → a key with no
    // datacentre validates, and the connector then has no host to dial.
    const field = providerDescriptor(MAILCHIMP_PROVIDER)!.credentialFields.find((f) => f.secret)!;
    const re = new RegExp(field.pattern!);
    expect(re.test(FAKE_MAILCHIMP_KEY)).toBe(true);
    expect(re.test("EXAMPLEFIXTURENOTAREALKEY000")).toBe(false);
  });

  it("accepts a HubSpot private app token and refuses an OAuth-shaped one", () => {
    const field = providerDescriptor(HUBSPOT_PROVIDER)!.credentialFields.find((f) => f.secret)!;
    const re = new RegExp(field.pattern!);
    expect(re.test(FAKE_HUBSPOT_TOKEN)).toBe(true);
    // HubSpot has no PKCE, so an OAuth access token is not a credential this
    // track can hold. Mutation: drop the `pat-` anchor → red.
    expect(re.test("CJ" + "EXAMPLE" + "OAUTHTOKEN")).toBe(false);
  });

  it("declares egress hosts that match the registered entries exactly", () => {
    // Mutation: add a host here that `allowed-egress.yaml` does not carry →
    // `scripts/check-egress-allowlist.py` goes red.
    expect(providerDescriptor(STRIPE_PROVIDER)?.egressHosts).toEqual([
      "api.stripe.com",
      "files.stripe.com",
    ]);
    expect(providerDescriptor(HUBSPOT_PROVIDER)?.egressHosts).toEqual(["api.hubapi.com"]);
  });

  it("declares Mailchimp's egress as DYNAMIC rather than as an empty list", () => {
    // The distinction this exists for: an empty `egressHosts` on a LAN track
    // means "never leaves the network"; on Mailchimp it means "the host comes
    // out of the customer's key". Reading the second as the first would hand a
    // cloud track a LAN-only guarantee it does not have.
    // Mutation: delete `dynamicEgress` → red, and Mailchimp becomes
    // indistinguishable from Eaglesoft on this axis.
    const mc = providerDescriptor(MAILCHIMP_PROVIDER);
    expect(mc?.egressHosts).toEqual([]);
    expect(mc?.dynamicEgress?.registryId).toBe("mailchimp-marketing-api");
    expect(providerDescriptor("eaglesoft")?.dynamicEgress).toBeUndefined();
  });

  it("carries the rate limits and poll floor each ticket specifies", () => {
    // Mutation: change any of these to a round number somebody invented → red.
    expect(providerDescriptor(STRIPE_PROVIDER)?.rateLimit?.callCeiling).toBe(
      STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION,
    );
    expect(providerDescriptor(STRIPE_PROVIDER)?.pollIntervalFloorMs).toBe(
      STRIPE_MIN_POLL_INTERVAL_SECONDS * 1000,
    );
    // Account-keyed, per SECOND — not folded into a monthly figure, because
    // it is a rate two connections on one portal SHARE.
    expect(providerDescriptor(HUBSPOT_PROVIDER)?.rateLimit?.callCeiling).toBe(
      HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND,
    );
    expect(providerDescriptor(HUBSPOT_PROVIDER)?.rateLimit?.periodMs).toBe(1000);
    // Mailchimp meters CONCURRENCY, not calls per period. A ceiling invented
    // for it would be a guess wearing a policy's clothes.
    expect(providerDescriptor(MAILCHIMP_PROVIDER)?.rateLimit).toBeUndefined();
  });

  it("declares the datasets the connectors actually report serving", () => {
    // Reconciled against `Connector.servesDatasets` rather than duplicated —
    // the same rule the pre-existing descriptors follow.
    // Mutation: drift either side → red.
    expect(providerDescriptor(STRIPE_PROVIDER)?.datasets).toEqual([...STRIPE_DATASETS]);
    expect(providerDescriptor(HUBSPOT_PROVIDER)?.datasets).toEqual([...HUBSPOT_DATASETS]);
    expect(providerDescriptor(MAILCHIMP_PROVIDER)?.datasets).toEqual([...MAILCHIMP_DATASETS]);
  });
});

// ===========================================================================
// Scope item 2 — connectorForProvider wiring
// ===========================================================================

const CONFIG = {
  stripe: { provider: "stripe" },
  hubspot: { provider: "hubspot", portalId: "1234567" },
  mailchimp: { provider: "mailchimp", datacenter: "us14" },
} as const;

describe("connectorForProvider builds all three", () => {
  it("returns the right connector for each key", () => {
    // Mutation: drop one `registerConnectorFactory` call → `connectorForProvider`
    // throws "unknown ERP provider" → red. This is the AC the three vendor PRs
    // each deferred: before it, all three classes were unreachable.
    expect(
      connectorForProvider({ provider: STRIPE_PROVIDER, host: "", connectionId: CONN, providerConfig: CONFIG.stripe }).provider,
    ).toBe(STRIPE_PROVIDER);
    expect(
      connectorForProvider({ provider: HUBSPOT_PROVIDER, host: "", connectionId: CONN, providerConfig: CONFIG.hubspot }).provider,
    ).toBe(HUBSPOT_PROVIDER);
    expect(
      connectorForProvider({ provider: MAILCHIMP_PROVIDER, host: "", connectionId: CONN, providerConfig: CONFIG.mailchimp }).provider,
    ).toBe(MAILCHIMP_PROVIDER);
  });

  it("still throws by name on an unknown provider", () => {
    // The WARP-2217 refusal must survive three new registrations. Mutation:
    // reinstate any fallback → red.
    expect(() => connectorForProvider({ provider: "netsuite", host: "" })).toThrow(
      /unknown ERP provider/,
    );
  });

  it("refuses to build HubSpot without a portal id", () => {
    // The Search governor is ACCOUNT-keyed. A connection that cannot name its
    // portal cannot share the ceiling with its siblings, so building it would
    // produce a connector that looks correct and 429s under load.
    // Mutation: default the portal id to "" → red.
    expect(() =>
      connectorForProvider({
        provider: HUBSPOT_PROVIDER,
        host: "",
        connectionId: CONN,
        providerConfig: { provider: "hubspot" },
      }),
    ).toThrow(ConnectorBlockedError);
  });

  it("refuses to build Mailchimp without a datacentre", () => {
    // No datacentre means no host at all. Mutation: default it to "us1" → the
    // box silently dials somebody else's shard.
    expect(() =>
      connectorForProvider({
        provider: MAILCHIMP_PROVIDER,
        host: "",
        connectionId: CONN,
        providerConfig: { provider: "mailchimp" },
      }),
    ).toThrow(ConnectorBlockedError);
  });

  it("leaves the connector BLOCKED when no credential is sealed", () => {
    // Honest degradation: a half-configured row reports not-connected rather
    // than reaching a vendor with nothing and collecting an opaque 401.
    // Mutation: pass a resolver that returns "" → the connector dials with an
    // empty credential and this stops throwing.
    const c = connectorForProvider({
      provider: STRIPE_PROVIDER,
      host: "",
      connectionId: CONN,
      providerConfig: CONFIG.stripe,
    });
    return expect(c.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
  });
});

// ===========================================================================
// The credential resolver — reads what WARP-2275 actually shipped
// ===========================================================================

describe("the SaaS credential resolver", () => {
  it("resolves a sealed secret by FIELD NAME, with no vendor branching", () => {
    // The resolver is generic: it is handed a field name from the descriptor
    // and knows nothing about which vendor it serves.
    const blob = sealSaasCredentials(CONN, { apiKey: FAKE_STRIPE_KEY });
    const mat = cloudMaterialFromRow({
      id: CONN,
      provider: STRIPE_PROVIDER,
      providerConfig: CONFIG.stripe,
      providerTokensEnc: blob,
    });
    expect(mat.cloudTokens?.resolveSaasSecret).toBeDefined();
    return expect(mat.cloudTokens!.resolveSaasSecret!("apiKey")).resolves.toBe(FAKE_STRIPE_KEY);
  });

  it("reads providerTokensEnc, NOT apiCredentialsEnc", () => {
    // ADR-042 §5 is the authority and WARP-2453 (#1827) reconciled the
    // configurator onto `providerTokensEnc`: it is the CLOUD-track credential
    // column, sealed under `deriveSaasCredentialKey()` with the
    // `saas-credential:<rowId>` AAD. `apiCredentialsEnc` is the Eaglesoft REST
    // track's static {integrationKey,userId,password} triple under the older
    // `encryptSecret`, on a LAN transport this resolver never touches — so a
    // resolver reading it would decrypt nothing for a SaaS row.
    //
    // Mutation: point the resolver at `apiCredentialsEnc` → the second half
    // goes red (no resolver from a providerTokensEnc row) AND the first half
    // goes red (a resolver appears from an apiCredentialsEnc row).
    const blob = sealSaasCredentials(CONN, { apiKey: FAKE_STRIPE_KEY });

    const rightColumn = cloudMaterialFromRow({
      id: CONN,
      provider: STRIPE_PROVIDER,
      providerConfig: CONFIG.stripe,
      providerTokensEnc: blob,
    });
    expect(rightColumn.cloudTokens?.resolveSaasSecret).toBeDefined();

    const wrongColumn = cloudMaterialFromRow({
      id: CONN,
      provider: STRIPE_PROVIDER,
      providerConfig: CONFIG.stripe,
      apiCredentialsEnc: blob,
    });
    expect(wrongColumn.cloudTokens?.resolveSaasSecret).toBeUndefined();
  });

  it("keeps the two providerTokensEnc writers disjoint by provider", () => {
    // WARP-2453's argument, asserted rather than trusted. Two writers share
    // this column: the ERP cloud track (QBO, Ascend) seals rotating OAuth
    // material under `deriveErpCloudTokenKey()`, the SaaS tracks seal a pasted
    // bundle under `deriveSaasCredentialKey()`. A row is ONE provider, so only
    // one writer ever owns a blob — and the QBO/Ascend branches return before
    // the generic SaaS branch is reached.
    //
    // Mutation: move the SaaS branch above the QBO branch → QuickBooks stops
    // getting `resolveQbo` and gets a SaaS resolver instead → red.
    const blob = sealSaasCredentials(CONN, { apiKey: FAKE_STRIPE_KEY });
    const qbo = cloudMaterialFromRow({
      id: CONN,
      provider: "quickbooks-online",
      providerConfig: { provider: "quickbooks-online", realmId: "r-1" },
      providerTokensEnc: blob,
    });
    // A SaaS-sealed blob on a QuickBooks row yields no QBO tokens (it is not
    // QBO's encoding) and no SaaS resolver either (QBO returns first). It
    // fails closed as "no credential" — never as somebody else's.
    expect(qbo.cloudTokens?.resolveSaasSecret).toBeUndefined();
    expect(qbo.cloudTokens?.resolveQbo).toBeUndefined();
  });

  it("fails closed on a blob sealed for a different row", () => {
    // The AAD binding. A credential moved between rows must not authenticate
    // as the wrong company — GCM's tag check is what makes that structural
    // rather than a policy we remember to apply.
    // Mutation: drop the AAD from seal/open → this stops throwing.
    const blob = sealSaasCredentials("conn-a", { apiKey: FAKE_STRIPE_KEY });
    const mat = cloudMaterialFromRow({
      id: "conn-b",
      provider: STRIPE_PROVIDER,
      providerConfig: CONFIG.stripe,
      providerTokensEnc: blob,
    });
    return expect(mat.cloudTokens!.resolveSaasSecret!("apiKey")).rejects.toThrow();
  });

  it("rejects rather than returning empty for a field the bundle lacks", () => {
    // An empty credential is indistinguishable from "not configured".
    // Mutation: `return secrets[field] ?? ""` → red.
    const blob = sealSaasCredentials(CONN, { apiKey: FAKE_STRIPE_KEY });
    const mat = cloudMaterialFromRow({
      id: CONN,
      provider: HUBSPOT_PROVIDER,
      providerConfig: CONFIG.hubspot,
      providerTokensEnc: blob,
    });
    return expect(mat.cloudTokens!.resolveSaasSecret!("accessToken")).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
  });

  it("never puts credential material in a thrown message", () => {
    // Rule 19. Mutation: interpolate the field's value into the refusal → red.
    const blob = sealSaasCredentials(CONN, { apiKey: FAKE_STRIPE_KEY });
    const mat = cloudMaterialFromRow({
      id: CONN,
      provider: HUBSPOT_PROVIDER,
      providerConfig: CONFIG.hubspot,
      providerTokensEnc: blob,
    });
    return mat.cloudTokens!.resolveSaasSecret!("accessToken").then(
      () => expect.unreachable("should have rejected"),
      (err: unknown) => {
        expect(String(err)).not.toContain(FAKE_STRIPE_KEY);
        expect(String(err)).not.toContain("rk_test");
      },
    );
  });

  it("hands a built connector a working resolver end to end", async () => {
    // The whole seam, exercised the way production runs it: seal → row →
    // selector → factory → connector. The connector is asked for `status()`,
    // which resolves the credential without dialing anything.
    const blob = sealSaasCredentials(CONN, { apiKey: FAKE_MAILCHIMP_KEY });
    const mat = cloudMaterialFromRow({
      id: CONN,
      provider: MAILCHIMP_PROVIDER,
      providerConfig: CONFIG.mailchimp,
      providerTokensEnc: blob,
    });
    // Cast to the concrete class: `status()` is a Mailchimp method, not part
    // of the `Connector` interface every track implements.
    const c = connectorForProvider({
      provider: MAILCHIMP_PROVIDER,
      host: "",
      ...mat,
    }) as unknown as MailchimpConnector;
    const status = await c.status();
    // Mutation: wire the resolver to the wrong field name → `hasApiKey` false.
    expect(status.hasApiKey).toBe(true);
    // And the status must never carry the key itself — the `hasPassword`
    // convention from the SMTP settings view.
    expect(JSON.stringify(status)).not.toContain(FAKE_MAILCHIMP_KEY);
  });
});
