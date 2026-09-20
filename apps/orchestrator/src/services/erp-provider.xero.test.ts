/**
 * WARP-2383 — the Xero track's orchestrator-side wiring.
 *
 * The connector's own behaviour is pinned in
 * `services/erp-connector/__tests__/xero.test.ts`. What is pinned HERE is
 * everything that lives outside it and that a connector test cannot see:
 *
 *   • the descriptor the wizard and the validator both read (WARP-2394),
 *   • the discriminated credential parse, which is what makes the two
 *     authentication paths disjoint rather than one form with optional extras,
 *   • the factory registration, without which the class is unreachable —
 *     the exact defect WARP-2466 had to fix for three earlier vendors,
 *   • that Xero's datasets are selectable through the GENERIC cloud read tool
 *     rather than through a per-vendor one (WARP-2421),
 *   • the egress declaration matching the registry entries (WARP-2403).
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, it, expect } from "vitest";

import {
  CREDENTIAL_VARIANT_FIELD,
  cloudProviderIds,
  credentialFieldsFor,
  credentialSecretFieldsFor,
  parseProviderConfigResult,
  providerDescriptor,
} from "@droplet/shared-types";
import {
  ConnectorBlockedError,
  XERO_ALLOWED_API_HOSTS,
  XERO_DATASETS,
  XERO_POLL_INTERVAL_FLOOR_MS,
  XERO_PROVIDER,
  XeroVariantNotImplementedError,
} from "@droplet/erp-connector";
import { CLOUD_QUERY_DATASETS } from "@droplet/tools-core";
import { connectorForProvider, parseProviderConfig } from "./erp-provider.js";
import { CLOUD_DATASET_READS } from "./erp.service.js";

const CONN = "conn-xero-0001";
/** Obviously fake, and a public identifier either way — a client id is not a
 *  secret, which is why the descriptor stores it in `providerConfig`. */
const CLIENT_ID = "FAKE-XERO-CLIENT-ID-0000";

const CUSTOM_CONNECTION = {
  [CREDENTIAL_VARIANT_FIELD]: "custom-connection",
  clientId: CLIENT_ID,
};

// ===========================================================================
// WARP-2394 — the descriptor
// ===========================================================================

describe("the Xero descriptor", () => {
  it("declares the two authentication paths as VARIANTS, not as optional fields", () => {
    // Rendering the union of both paths' fields would ask for a client secret
    // that cannot exist on the PKCE path; rendering only the first would hide
    // the other entirely (ADR-042 §4).
    // Mutation: move the variant fields up into `credentialFields` → the
    // wizard asks every customer for a secret half of them cannot produce.
    const d = providerDescriptor(XERO_PROVIDER);
    expect(d?.credentialFields).toEqual([]);
    expect(d?.credentialVariants?.map((v) => v.id)).toEqual(["custom-connection", "pkce-app"]);
  });

  it("gives the implemented path a secret and the unimplemented one none", () => {
    // ADR-042 §2: the PKCE app type has "no option to generate a client
    // secret". Mutation: add one to `pkce-app` → the form asks for a value
    // Xero will never issue, and §4's "a Path B config carrying a secret" case
    // becomes representable.
    expect(credentialFieldsFor(providerDescriptor(XERO_PROVIDER), "custom-connection").map(
      (f) => f.name,
    )).toEqual(["clientId", "clientSecret"]);
    expect(
      credentialSecretFieldsFor(providerDescriptor(XERO_PROVIDER), "custom-connection").map(
        (f) => f.name,
      ),
    ).toEqual(["clientSecret"]);
    expect(
      credentialSecretFieldsFor(providerDescriptor(XERO_PROVIDER), "pkce-app"),
    ).toEqual([]);
  });

  it("stores the client id in providerConfig and only the secret encrypted", () => {
    // ADR-042 §5: non-secret connection facts go in `providerConfig`, so
    // answering "which app is this connection?" never decrypts a credential.
    // Mutation: mark `clientId` secret → the hub cannot tell two Xero
    // connections apart without opening the sealed bundle.
    const fields = credentialFieldsFor(providerDescriptor(XERO_PROVIDER), "custom-connection");
    expect(fields.find((f) => f.name === "clientId")).toMatchObject({
      secret: false,
      storage: "providerConfig",
    });
    expect(fields.find((f) => f.name === "clientSecret")).toMatchObject({
      secret: true,
      storage: "encrypted",
    });
  });

  it("is a cloud track carrying its setup guide, and the four-hour poll floor", () => {
    // `setupGuideHref` is type-REQUIRED for an `available` cloud card, and Xero
    // needs it more than any other: the guide is where the customer learns the
    // connection is AU/NZ/UK/US-only and that Xero bills them per organisation.
    // Mutation: drop `pollIntervalFloorMs` → the cadence floor silently
    // disappears and the fleet polls on the 15-minute tick.
    const d = providerDescriptor(XERO_PROVIDER);
    expect(d?.track).toBe("cloud");
    expect(cloudProviderIds()).toContain(XERO_PROVIDER);
    expect(d?.catalog?.setupGuideHref).toBe("/help/integrations/xero");
    expect(d?.catalog?.availability).toBe("available");
    expect(d?.pollIntervalFloorMs).toBe(XERO_POLL_INTERVAL_FLOOR_MS);
  });

  it("declares exactly the hosts the connector guard allows (WARP-2403)", () => {
    // The descriptor's bare hosts and the connector's full-string literals are
    // two halves of one registration — `docs/security/allowed-egress.yaml`
    // holds the third. Mutation: add a host here without a registry entry →
    // the drift gate over the three goes red.
    expect(providerDescriptor(XERO_PROVIDER)?.egressHosts).toEqual([
      "api.xero.com",
      "identity.xero.com",
    ]);
    expect(new Set(providerDescriptor(XERO_PROVIDER)?.egressHosts)).toEqual(
      XERO_ALLOWED_API_HOSTS,
    );
    // NOT a dynamic-host track: both hosts are fixed literals the CI scanner
    // can see, unlike Mailchimp's. Mutation: add `dynamicEgress` → the
    // registry would be told to expect a `kind: dynamic` entry that is not
    // there.
    expect(providerDescriptor(XERO_PROVIDER)?.dynamicEgress).toBeUndefined();
  });

  it("declares the datasets the connector actually reports serving", () => {
    // Mutation: add `ap_summary` here → the descriptor claims a dataset the
    // connector refuses, and `cloudRowForDataset` resolves a Xero connection
    // for a read it will answer with DatasetNotServedError.
    expect(providerDescriptor(XERO_PROVIDER)?.datasets).toEqual([...XERO_DATASETS]);
  });
});

// ===========================================================================
// The discriminated credential parse
// ===========================================================================

describe("parsing a Xero providerConfig", () => {
  it("refuses a config that names no path — it is never defaulted", () => {
    // Which authentication path a connection is on is persisted state, and
    // guessing it is the no-guessing-from-absence rule. Mutation: fall back to
    // the first variant → a row saved with no discriminator silently becomes a
    // Custom Connection and asks for a secret that may not exist.
    const result = parseProviderConfigResult(providerDescriptor(XERO_PROVIDER), {
      clientId: CLIENT_ID,
    });
    expect(result).toMatchObject({ ok: false, reason: "missing-variant" });
  });

  it("parses the chosen path's fields and records which path it was", () => {
    // WARP-2491's fix: before it, a variant provider's fields were DROPPED
    // here while the wizard collected them, so the row looked configured with
    // half its credential missing. Mutation: walk `credentialFields` only →
    // `clientId` vanishes and the connector cannot be built.
    const cfg = parseProviderConfig(XERO_PROVIDER, CUSTOM_CONNECTION);
    expect(cfg).toMatchObject({
      provider: XERO_PROVIDER,
      [CREDENTIAL_VARIANT_FIELD]: "custom-connection",
      clientId: CLIENT_ID,
    });
  });

  it("refuses a variant this descriptor does not declare", () => {
    // Mutation: accept any string → a row can record a path nothing can build,
    // and the failure surfaces at read time rather than at save time.
    expect(
      parseProviderConfigResult(providerDescriptor(XERO_PROVIDER), {
        [CREDENTIAL_VARIANT_FIELD]: "oauth-code",
        clientId: CLIENT_ID,
      }),
    ).toMatchObject({ ok: false, reason: "unknown-variant" });
  });

  it("refuses the custom-connection path with no client id", () => {
    // Mutation: mark `clientId` optional → the row saves, and the connector is
    // then built with an empty id, producing a Basic header of `:<secret>`.
    expect(
      parseProviderConfigResult(providerDescriptor(XERO_PROVIDER), {
        [CREDENTIAL_VARIANT_FIELD]: "custom-connection",
      }),
    ).toMatchObject({ ok: false, reason: "missing-required-field", field: "clientId" });
  });
});

// ===========================================================================
// The factory registration
// ===========================================================================

describe("connectorForProvider builds the Xero track", () => {
  it("returns a Xero connector for a configured Custom Connection", () => {
    // Mutation: drop the `registerConnectorFactory(XERO_PROVIDER, …)` call →
    // "unknown ERP provider", and the whole class is unreachable from a row.
    // That is the exact defect three earlier vendors shipped with.
    const c = connectorForProvider({
      provider: XERO_PROVIDER,
      host: "",
      connectionId: CONN,
      providerConfig: { provider: XERO_PROVIDER, ...CUSTOM_CONNECTION },
    });
    expect(c.provider).toBe(XERO_PROVIDER);
    expect([...c.servesDatasets]).toEqual(["invoice", "bill", "contact"]);
  });

  it("REFUSES the pkce-app path at construction, by name", () => {
    // WARP-2388: the path needs an authorization-code redirect an appliance
    // with no inbound path cannot receive. Mutation: let it build → the owner
    // gets an opaque `invalid_client` from Xero on the first read instead of a
    // sentence telling them to create a Custom Connection.
    let err: unknown;
    try {
      connectorForProvider({
        provider: XERO_PROVIDER,
        host: "",
        connectionId: CONN,
        providerConfig: {
          provider: XERO_PROVIDER,
          [CREDENTIAL_VARIANT_FIELD]: "pkce-app",
          clientId: CLIENT_ID,
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(XeroVariantNotImplementedError);
    expect((err as Error).message).toMatch(/Custom Connection/);
  });

  it("refuses to build without a client id or without a row id", () => {
    // Both are refused HERE, where the row is known to be unconfigured, rather
    // than being discovered by spending a metered call.
    // Mutation: default either → a request goes out that cannot succeed.
    expect(() =>
      connectorForProvider({
        provider: XERO_PROVIDER,
        host: "",
        connectionId: CONN,
        providerConfig: { provider: XERO_PROVIDER, [CREDENTIAL_VARIANT_FIELD]: "custom-connection" },
      }),
    ).toThrow(ConnectorBlockedError);
    expect(() =>
      connectorForProvider({
        provider: XERO_PROVIDER,
        host: "",
        providerConfig: { provider: XERO_PROVIDER, ...CUSTOM_CONNECTION },
      }),
    ).toThrow(ConnectorBlockedError);
  });

  it("leaves the connector BLOCKED when no credential is sealed", () => {
    // Honest degradation: a half-configured row reports not-connected rather
    // than reaching Xero with nothing and collecting an opaque 401.
    // Mutation: wire a resolver that returns "" → the mint goes out with an
    // empty secret and this stops throwing.
    const c = connectorForProvider({
      provider: XERO_PROVIDER,
      host: "",
      connectionId: CONN,
      providerConfig: { provider: XERO_PROVIDER, ...CUSTOM_CONNECTION },
    });
    return expect(c.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
  });
});

// ===========================================================================
// WARP-2421 — reachable through the GENERIC cloud tool, with no per-vendor tool
// ===========================================================================

describe("the assistant reaches Xero through cloud_query_dataset only", () => {
  it("makes all three Xero datasets selectable on the one cloud tool", () => {
    // The ticket's resolution: the vendor is not a tool axis, so a fourth
    // connector must add ZERO tools. `invoice` and `contact` were already
    // reachable — `cloudRowForDataset` resolves a dataset to whichever
    // CONNECTED provider declares it, so those needed nothing. `bill` is the
    // one Xero adds.
    // Mutation: remove `bill` from either list → "what do we owe?" selects the
    // cloud domain (the selection pattern already claims the word) and meets a
    // tool with no way to ask.
    for (const dataset of XERO_DATASETS) {
      expect(CLOUD_QUERY_DATASETS).toContain(dataset);
      expect(CLOUD_DATASET_READS[dataset]).toBeTruthy();
    }
    expect(CLOUD_DATASET_READS.bill).toBe("get_open_bills");
  });

  it("adds NO per-vendor tool for Xero", async () => {
    // The prompt budget is the constraint: the chat pool sits within a few
    // dozen characters of its 60,000-char tripwire, so a per-vendor read tool
    // is not a design preference, it is unaffordable.
    // Mutation: register `xero_*` handlers → red here, and the budget canary
    // goes red immediately after.
    const { TOOLS } = await import("@droplet/tools-core");
    expect([...TOOLS.keys()].filter((n) => n.toLowerCase().includes("xero"))).toEqual([]);
  });
});
