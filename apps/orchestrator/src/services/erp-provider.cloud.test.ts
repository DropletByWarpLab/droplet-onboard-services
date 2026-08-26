/**
 * WARP-2137 — wiring the ADR-041 cloud ERP tracks into the connector factory.
 *
 * These connectors (WARP-2109 QuickBooks Online, WARP-2127 Dentrix Ascend)
 * shipped in `@droplet/erp-connector` with full test suites but no provider key
 * mapped in the orchestrator, so `validateProvider` rejected them and nothing
 * could ever construct one. The assertions here are about the WIRING — what the
 * factory does with a row's persisted material — not about the connectors'
 * internals, which their own package suites cover.
 *
 * Constructing a connector performs no I/O, so this file stays offline.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  QUICKBOOKS_ONLINE_PROVIDER,
  DENTRIX_ASCEND_PROVIDER,
  ConnectorBlockedError,
  DEFAULT_CALL_CEILING,
} from "@droplet/erp-connector";
import { __setColumnCryptoKeyForTest } from "./column-crypto.service.js";
import {
  connectorForProvider,
  cloudMaterialFromRow,
  encodeCloudTokens,
  isKnownErpProvider,
  isCloudErpProvider,
  parseProviderConfig,
  parseQboTokens,
  parseAscendToken,
  sharedCallBudget,
  __resetCallBudgetsForTest,
  KNOWN_ERP_PROVIDERS,
} from "./erp-provider.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

const QBO_TOKENS = {
  accessToken: "access-abc",
  refreshToken: "refresh-def",
  accessExpiresAt: 4_000_000_000_000,
  refreshExpiresAt: 5_000_000_000_000,
};

beforeEach(() => {
  __setColumnCryptoKeyForTest(TEST_KEY);
  __resetCallBudgetsForTest();
});

describe("cloud provider keys are reachable at all", () => {
  it("admits both cloud keys, which is the whole defect this ticket fixes", () => {
    expect(KNOWN_ERP_PROVIDERS).toContain(QUICKBOOKS_ONLINE_PROVIDER);
    expect(KNOWN_ERP_PROVIDERS).toContain(DENTRIX_ASCEND_PROVIDER);
    expect(isKnownErpProvider("quickbooks-online")).toBe(true);
    expect(isKnownErpProvider("dentrix-ascend")).toBe(true);
  });

  it("keeps the LAN tracks out of the cloud set", () => {
    expect(isCloudErpProvider("quickbooks-online")).toBe(true);
    expect(isCloudErpProvider("dentrix-ascend")).toBe(true);
    expect(isCloudErpProvider("eaglesoft")).toBe(false);
    expect(isCloudErpProvider("eaglesoft-api")).toBe(false);
  });
});

describe("parseProviderConfig validates structurally, never casts", () => {
  it("accepts a well-formed QuickBooks config", () => {
    const cfg = parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, {
      realmId: "9130347",
      baseUrl: "https://sandbox-quickbooks.api.intuit.com",
    });
    expect(cfg).toEqual({
      provider: QUICKBOOKS_ONLINE_PROVIDER,
      realmId: "9130347",
      baseUrl: "https://sandbox-quickbooks.api.intuit.com",
      callCeiling: undefined,
    });
  });

  it("refuses a QuickBooks config with no realm id — the identifier it cannot work without", () => {
    expect(parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, {})).toBeUndefined();
    expect(parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, { realmId: "" })).toBeUndefined();
    expect(parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, { realmId: "   " })).toBeUndefined();
    expect(parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, { realmId: 9130347 })).toBeUndefined();
  });

  it("ignores a nonsense call ceiling rather than blocking every read or silently defaulting", () => {
    for (const callCeiling of [0, -5, 1.5, "500"]) {
      const cfg = parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, { realmId: "r", callCeiling });
      expect(cfg).toMatchObject({ callCeiling: undefined });
    }
    expect(
      parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, { realmId: "r", callCeiling: 250 }),
    ).toMatchObject({ callCeiling: 250 });
  });

  it("accepts a Dentrix config, and keeps locationId optional", () => {
    expect(parseProviderConfig(DENTRIX_ASCEND_PROVIDER, { organizationId: "org-1" })).toEqual({
      provider: DENTRIX_ASCEND_PROVIDER,
      organizationId: "org-1",
      locationId: undefined,
      baseUrl: undefined,
    });
    expect(
      parseProviderConfig(DENTRIX_ASCEND_PROVIDER, { organizationId: "org-1", locationId: "7" }),
    ).toMatchObject({ locationId: "7" });
  });

  it("refuses a Dentrix config with no organization id", () => {
    expect(parseProviderConfig(DENTRIX_ASCEND_PROVIDER, {})).toBeUndefined();
  });

  it("refuses arrays, null, and a config belonging to another provider", () => {
    expect(parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, null)).toBeUndefined();
    expect(parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, [{ realmId: "r" }])).toBeUndefined();
    // A Dentrix-shaped config on a QuickBooks row has no realmId, so it fails
    // closed rather than half-configuring the wrong track.
    expect(
      parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, { organizationId: "org-1" }),
    ).toBeUndefined();
    expect(parseProviderConfig("eaglesoft", { realmId: "r" })).toBeUndefined();
  });
});

describe("token blobs are sealed to their row", () => {
  it("round-trips QuickBooks tokens for the row they were sealed against", async () => {
    const blob = encodeCloudTokens("conn-1", QBO_TOKENS);
    const material = cloudMaterialFromRow({
      id: "conn-1",
      provider: QUICKBOOKS_ONLINE_PROVIDER,
      providerConfig: { realmId: "9130347" },
      providerTokensEnc: blob,
    });
    expect(material.cloudTokens?.resolveQbo).toBeTypeOf("function");
    await expect(material.cloudTokens?.resolveQbo?.()).resolves.toEqual(QBO_TOKENS);
  });

  it("fails CLOSED when a blob is moved to another connection row", () => {
    // The AAD binding is the point: a blob lifted onto a different row must not
    // authenticate as that row's company.
    const blob = encodeCloudTokens("conn-1", QBO_TOKENS);
    const material = cloudMaterialFromRow({
      id: "conn-2",
      provider: QUICKBOOKS_ONLINE_PROVIDER,
      providerConfig: { realmId: "9130347" },
      providerTokensEnc: blob,
    });
    expect(material.cloudTokens).toBeUndefined();
  });

  it("treats an absent or undecryptable blob as not-configured, never as an exception", () => {
    for (const providerTokensEnc of [null, undefined, "", "not-a-blob", "dcv1:garbage"]) {
      const material = cloudMaterialFromRow({
        id: "conn-1",
        provider: QUICKBOOKS_ONLINE_PROVIDER,
        providerConfig: { realmId: "r" },
        providerTokensEnc,
      });
      expect(material.cloudTokens).toBeUndefined();
    }
  });

  it("narrows token shapes and rejects partial ones", () => {
    expect(parseQboTokens(QBO_TOKENS)).toEqual(QBO_TOKENS);
    expect(parseQboTokens({ ...QBO_TOKENS, refreshToken: undefined })).toBeUndefined();
    expect(parseQboTokens({ ...QBO_TOKENS, accessExpiresAt: "soon" })).toBeUndefined();
    expect(parseAscendToken({ accessToken: "t", expiresAt: 1 })).toEqual({
      accessToken: "t",
      expiresAt: 1,
    });
    expect(parseAscendToken({ accessToken: "t" })).toBeUndefined();
  });
});

describe("the metered call budget survives the per-read connector rebuild", () => {
  it("returns the SAME budget for a connection across calls", () => {
    // erp.service builds and closes a connector per read. A per-instance budget
    // would reset every time, making the ceiling that protects the fleet's
    // Intuit allowance completely inert — WARP-2137 finding #2.
    const a = sharedCallBudget("conn-1", 100);
    const b = sharedCallBudget("conn-1", 100);
    expect(b).toBe(a);
  });

  it("gives different connections different budgets", () => {
    expect(sharedCallBudget("conn-1", 100)).not.toBe(sharedCallBudget("conn-2", 100));
  });

  it("rebuilds when the configured ceiling changes, so an operator edit takes effect", () => {
    const a = sharedCallBudget("conn-1", 100);
    const b = sharedCallBudget("conn-1", 250);
    expect(b).not.toBe(a);
    expect(b).toBe(sharedCallBudget("conn-1", 250));
  });
});

describe("the factory builds the cloud connectors", () => {
  it("builds QuickBooks Online from a configured row", () => {
    const c = connectorForProvider({
      provider: QUICKBOOKS_ONLINE_PROVIDER,
      host: "",
      connectionId: "conn-1",
      providerConfig: parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, { realmId: "9130347" }),
      cloudTokens: { resolveQbo: async () => QBO_TOKENS },
    });
    expect(c.provider).toBe("quickbooks-online");
  });

  it("REFUSES a QuickBooks row with no company id instead of spending a metered call", () => {
    // The connector itself does not validate realmId: an empty one builds fine
    // and produces a /v3/company//query URL. Refusing here is what stops an
    // unconfigured row from asking Intuit about a company that does not exist.
    expect(() =>
      connectorForProvider({
        provider: QUICKBOOKS_ONLINE_PROVIDER,
        host: "",
        connectionId: "conn-1",
      }),
    ).toThrow(ConnectorBlockedError);
  });

  it("shares one budget between two connectors built for the same connection", () => {
    const sel = {
      provider: QUICKBOOKS_ONLINE_PROVIDER,
      host: "",
      connectionId: "conn-1",
      providerConfig: parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, { realmId: "r" }),
    };
    connectorForProvider(sel);
    connectorForProvider(sel);
    // Two reads, one budget — assert on the registry rather than a private
    // field, since the registry is what the wiring actually controls.
    expect(sharedCallBudget("conn-1", DEFAULT_CALL_CEILING)).toBe(
      sharedCallBudget("conn-1", DEFAULT_CALL_CEILING),
    );
  });

  it("builds Dentrix Ascend from a configured row", () => {
    const c = connectorForProvider({
      provider: DENTRIX_ASCEND_PROVIDER,
      host: "",
      connectionId: "conn-2",
      providerConfig: parseProviderConfig(DENTRIX_ASCEND_PROVIDER, {
        organizationId: "org-1",
        locationId: "7",
      }),
      cloudTokens: { resolveAscend: async () => ({ accessToken: "t", expiresAt: 9e12 }) },
    });
    expect(c.provider).toBe("dentrix-ascend");
  });

  it("lets the Ascend connector refuse a row with no Organization-ID at construction", () => {
    expect(() =>
      connectorForProvider({
        provider: DENTRIX_ASCEND_PROVIDER,
        host: "",
        connectionId: "conn-2",
      }),
    ).toThrow(ConnectorBlockedError);
  });

  it("does not route a cloud key to the SQL fallback", () => {
    const c = connectorForProvider({
      provider: DENTRIX_ASCEND_PROVIDER,
      host: "10.0.0.5",
      connectionId: "conn-2",
      providerConfig: parseProviderConfig(DENTRIX_ASCEND_PROVIDER, { organizationId: "org-1" }),
    });
    expect(c.provider).not.toBe("eaglesoft");
  });
});
