/**
 * WARP-2458 — the ADR-041 §5 state mapping.
 *
 * Nothing here reaches a vendor, a database or a connector instance: the unit
 * under test is a pair of tables and two pure functions, and the errors are
 * the real exported classes from `@droplet/erp-connector` so a rename or a
 * changed `code` on any of them turns this red rather than passing against a
 * hand-written stub that agrees with a stale memory of the shape.
 */
import {
  ConnectorBlockedError,
  HubSpotCapabilityUnavailableError,
  HubSpotReauthorizationRequiredError,
  HubSpotSearchRateLimitedError,
  HubSpotSuperAdminRevokedError,
  MailchimpCapabilityMissingError,
  MailchimpReauthorizationRequiredError,
  StripeAccessPolicyError,
  StripeQuotaExhaustedError,
  StripeReauthorizationRequiredError,
  type CloudConnectionState,
} from "@droplet/erp-connector";
import { describe, expect, it } from "vitest";

import {
  INTEGRATION_STATUS_BY_CLOUD_STATE,
  integrationStatusForHealthFailure,
  statusAfterHealthProbe,
} from "./cloud-connection-state.js";

describe("INTEGRATION_STATUS_BY_CLOUD_STATE — ADR-041 §5's vocabulary", () => {
  it("maps all five canonical states, and needs_reconnect to its own member", () => {
    // The ADR names five states "at minimum". Mutation: map `needs_reconnect`
    // onto CONNECTED — the bug the ticket was filed for — and this goes red.
    expect(INTEGRATION_STATUS_BY_CLOUD_STATE).toEqual({
      disconnected: "NOT_CONFIGURED",
      pending_consent: "PROVISIONING",
      connected: "CONNECTED",
      needs_reconnect: "NEEDS_RECONNECT",
      error: "ERROR",
    });
  });

  it("is total over the source union", () => {
    // The `Record<CloudConnectionState, …>` annotation is what proves this at
    // compile time; the runtime half exists so a reader can see the list.
    // Mutation: make the Record `Partial` and drop a key → red here.
    const states: CloudConnectionState[] = [
      "disconnected",
      "pending_consent",
      "connected",
      "needs_reconnect",
      "error",
    ];
    for (const s of states) expect(INTEGRATION_STATUS_BY_CLOUD_STATE[s]).toBeDefined();
  });

  it("never maps a non-connected state onto CONNECTED", () => {
    // The single invariant the whole ticket rests on. Mutation: point any
    // entry other than `connected` at CONNECTED → red.
    for (const [state, status] of Object.entries(INTEGRATION_STATUS_BY_CLOUD_STATE)) {
      if (state === "connected") continue;
      expect(status, `${state} must not render as CONNECTED`).not.toBe("CONNECTED");
    }
  });
});

describe("integrationStatusForHealthFailure — classifying a rejected probe", () => {
  it("maps every connector's reauthorize error to NEEDS_RECONNECT", () => {
    // The three vendors this release wires, each throwing its OWN class. They
    // agree on `code: REAUTHORIZE_REQUIRED`, which is why the classifier needs
    // no vendor knowledge. Mutation: map REAUTHORIZE_REQUIRED to DEGRADED (or
    // to CONNECTED) → all three go red.
    for (const err of [
      new StripeReauthorizationRequiredError("revoked"),
      new HubSpotReauthorizationRequiredError("revoked"),
      new MailchimpReauthorizationRequiredError("revoked"),
    ]) {
      expect(integrationStatusForHealthFailure(err)).toBe("NEEDS_RECONNECT");
    }
  });

  it("treats a lost HubSpot super admin as needing a new credential", () => {
    // `USER_DOES_NOT_HAVE_PERMISSIONS`. The portal refuses every call until a
    // current super admin re-creates the private app and the token is pasted
    // here — a re-paste, so the same state. Mutation: map it to ERROR and the
    // owner is told reconnecting will not help, which is false.
    expect(
      integrationStatusForHealthFailure(new HubSpotSuperAdminRevokedError("creator lost admin")),
    ).toBe("NEEDS_RECONNECT");
  });

  it("keeps a transient throttle DEGRADED rather than asking for a new key", () => {
    // A rate limit clears in a second and a metered budget resets with its
    // period. Mutation: map either to NEEDS_RECONNECT and every throttled
    // connection tells its owner to go and re-paste a key that works.
    expect(integrationStatusForHealthFailure(new HubSpotSearchRateLimitedError(5, "throttled"))).toBe(
      "DEGRADED",
    );
    expect(integrationStatusForHealthFailure(new StripeQuotaExhaustedError(5000, 5000))).toBe(
      "DEGRADED",
    );
  });

  it("keeps failures a new credential cannot fix out of NEEDS_RECONNECT", () => {
    // Stripe's IP access policy: the key is fine and the permissions are fine.
    // Mutation: map it to NEEDS_RECONNECT → red, and the product would be
    // telling a merchant to mint keys until one of them works.
    expect(integrationStatusForHealthFailure(new StripeAccessPolicyError("ip refused"))).toBe(
      "ERROR",
    );
    // WARP-2623 — Mailchimp's capability gate used to be asserted here as
    // ERROR alongside it. It moved, deliberately: "a new key will not fix it"
    // is true of both, but only one of them means the connection is BROKEN.
    // See the capability table below.
    expect(
      integrationStatusForHealthFailure(new MailchimpCapabilityMissingError("lists", "plan")),
    ).not.toBe("ERROR");
  });

  it("reports an unwired connector as NOT_CONFIGURED, not as broken", () => {
    // A blocked connector never dialed: nothing resolved a credential. That is
    // the box's own state, not the vendor's answer.
    // Mutation: map CONNECTOR_BLOCKED to ERROR → a connection nobody has set
    // up yet renders as "Can't connect".
    expect(
      integrationStatusForHealthFailure(new ConnectorBlockedError("health", "nothing wired")),
    ).toBe("NOT_CONFIGURED");
  });

  it("refuses to call an unclassifiable failure healthy", () => {
    // Anything we cannot classify is ERROR — never CONNECTED, never an
    // optimistic default. Mutation: return "CONNECTED" for an unknown code and
    // the ticket's whole failure mode comes back through the side door.
    for (const err of [new Error("boom"), { code: "SOMETHING_NEW" }, null, undefined, "nope"]) {
      expect(integrationStatusForHealthFailure(err)).toBe("ERROR");
    }
  });
});

/**
 * WARP-2623 — the four capability codes land on their own persisted status.
 *
 * ## What was wrong
 *
 * All four mapped to `IntegrationStatus.ERROR`, which both surfaces render as
 * "Can't connect": the hub tile (`connector-visuals.tsx` `statusView`) and
 * `/integrations/credentials` (`SaasCredentialsSection.tsx` `STATE_COPY`). So a
 * Basic-plan Shopify store — orders, products, inventory and fulfilment all
 * reading correctly, only customer identities withheld — and a Mailchimp
 * account whose plan excludes one resource were both drawn as broken
 * connections. `ERROR` is also not a pollable status, so the working store
 * stopped syncing the datasets it CAN read as well.
 *
 * ## What this table pins
 *
 * One row per capability code, the vendor that throws it, and the persisted
 * status it must produce — plus the codes that stay `ERROR`, listed so that
 * widening the capability set later is a deliberate edit to this table rather
 * than a silent reclassification.
 */
describe("integrationStatusForHealthFailure — capability codes are not ERROR (WARP-2623)", () => {
  /**
   * PR #1945's Shopify errors, mirrored locally.
   *
   * The connector is not on `stage` yet, so importing the real classes would
   * not compile. What is asserted is the CONTRACT the classifier keys on — the
   * `code` string — copied from `services/erp-connector/src/shopify/
   * connector.ts` on `origin/feat/warp-2296-shopify-connector`
   * (`ShopifyScopeMissingError`, `ShopifyProtectedDataDeniedError`). When
   * #1945 merges these become plain imports; if its codes changed in review,
   * this table goes red, which is the point.
   */
  class ShopifyScopeMissing extends Error {
    readonly code = "SCOPE_MISSING";
  }
  class ShopifyProtectedDataDenied extends Error {
    readonly code = "PROTECTED_CUSTOMER_DATA_DENIED";
  }

  const CAPABILITY: ReadonlyArray<[vendor: string, code: string, make: () => Error]> = [
    [
      "mailchimp",
      "CAPABILITY_MISSING",
      () => new MailchimpCapabilityMissingError("lists", "plan does not include it"),
    ],
    [
      "hubspot",
      "CAPABILITY_NOT_AVAILABLE",
      () => new HubSpotCapabilityUnavailableError("quotes", "Sales Hub Professional"),
    ],
    ["shopify (#1945)", "SCOPE_MISSING", () => new ShopifyScopeMissing("read_customers")],
    [
      "shopify (#1945)",
      "PROTECTED_CUSTOMER_DATA_DENIED",
      () => new ShopifyProtectedDataDenied("silent redaction"),
    ],
  ];

  it.each(CAPABILITY)("%s's %s classifies as CAPABILITY_LIMITED", (_vendor, code, make) => {
    // Mutation: map any one of the four back to "ERROR" in
    // INTEGRATION_STATUS_BY_HEALTH_FAILURE_CODE → that row goes red.
    const err = make();
    expect((err as unknown as { code: string }).code, "the code the classifier keys on").toBe(code);
    expect(integrationStatusForHealthFailure(err)).toBe("CAPABILITY_LIMITED");
  });

  it("does not call a capability-limited connection healthy either", () => {
    // The other half of the honesty rule. CONNECTED would hide the missing
    // dataset behind a green pill, which is the failure ADR-041 §5 exists to
    // prevent — the same one NEEDS_RECONNECT was added for.
    // Mutation: map any capability code to "CONNECTED" → red.
    for (const [, , make] of CAPABILITY) {
      expect(integrationStatusForHealthFailure(make())).not.toBe("CONNECTED");
    }
  });

  it("never sends the owner after a new credential for one", () => {
    // A plan boundary and a scope grant are both fixed in the vendor's own
    // console. Mutation: map any capability code to "NEEDS_RECONNECT" → red,
    // and the product tells a merchant to mint keys until one of them works.
    for (const [, , make] of CAPABILITY) {
      expect(integrationStatusForHealthFailure(make())).not.toBe("NEEDS_RECONNECT");
    }
  });

  it("leaves the genuinely broken codes at ERROR", () => {
    // The boundary of the change, asserted so widening it later is deliberate.
    // `STRIPE_ACCESS_POLICY` reads the same way from a distance — "a new key
    // will not fix it" — but nothing works through it, so it is not the same
    // state. Mutation: move either into the capability block → red.
    expect(integrationStatusForHealthFailure(new StripeAccessPolicyError("ip refused"))).toBe(
      "ERROR",
    );
    expect(integrationStatusForHealthFailure({ code: "UNSAFE_BASE_URL" })).toBe("ERROR");
  });
});

describe("statusAfterHealthProbe — a completed probe never leaves PROVISIONING", () => {
  it("advances a resolved probe to CONNECTED", () => {
    // Mutation: return PROVISIONING here → red, and a pasted key would sit at
    // "Setting up" forever, which is the state WARP-2466 exists to end.
    expect(statusAfterHealthProbe()).toBe("CONNECTED");
    expect(statusAfterHealthProbe(undefined)).toBe("CONNECTED");
  });

  it("cannot produce PROVISIONING for any rejection", () => {
    // WARP-2466's acceptance criterion, asserted as a property of the function
    // rather than as a rule call sites must remember. Mutation: add a branch
    // returning PROVISIONING → red.
    const failures: unknown[] = [
      new StripeReauthorizationRequiredError("revoked"),
      new HubSpotSuperAdminRevokedError("lost"),
      new HubSpotSearchRateLimitedError(5, "throttled"),
      new StripeAccessPolicyError("ip"),
      new MailchimpCapabilityMissingError("lists", "plan"),
      new ConnectorBlockedError("health", "nothing wired"),
      new Error("boom"),
    ];
    for (const f of failures) {
      const status = statusAfterHealthProbe(f);
      expect(status, `${String(f)} produced PROVISIONING`).not.toBe("PROVISIONING");
      expect(status, `${String(f)} produced CONNECTED`).not.toBe("CONNECTED");
    }
  });
});
