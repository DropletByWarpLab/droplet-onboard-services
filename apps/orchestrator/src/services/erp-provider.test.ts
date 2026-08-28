/**
 * WARP-1294 — the dual-track connector factory: one place that maps a provider
 * key to a concrete Connector. Constructing a connector is pure (no I/O), so
 * these assertions are offline.
 */
import { describe, it, expect } from "vitest";
import { ConnectorBlockedError } from "@droplet/erp-connector";
import {
  connectorForProvider,
  isKnownErpProvider,
  EAGLESOFT_PROVIDER,
  EAGLESOFT_API_PROVIDER,
  KNOWN_ERP_PROVIDERS,
} from "./erp-provider.js";

describe("erp-provider dual-track factory", () => {
  it("knows both provider keys", () => {
    expect(KNOWN_ERP_PROVIDERS).toContain(EAGLESOFT_PROVIDER);
    expect(KNOWN_ERP_PROVIDERS).toContain(EAGLESOFT_API_PROVIDER);
    expect(isKnownErpProvider("eaglesoft")).toBe(true);
    expect(isKnownErpProvider("eaglesoft-api")).toBe(true);
    expect(isKnownErpProvider("dentrix")).toBe(false);
  });

  it("builds the direct-SQL connector for the eaglesoft provider", () => {
    const c = connectorForProvider({
      provider: EAGLESOFT_PROVIDER,
      host: "10.0.0.5",
      secretRef: "secret://erp/eaglesoft/ro",
    });
    expect(c.provider).toBe("eaglesoft");
  });

  it("builds the REST-API connector for the eaglesoft-api provider", () => {
    const c = connectorForProvider({
      provider: EAGLESOFT_API_PROVIDER,
      host: "10.0.0.5",
      secretRef: "secret://erp/eaglesoft-api/creds",
    });
    expect(c.provider).toBe("eaglesoft-api");
  });

  it("REFUSES an unknown provider instead of falling back to SQL (WARP-2217)", () => {
    // This used to return an EaglesoftConnector, on the reasoning that a stray
    // value must not reach a surprise transport. The fallback WAS the surprise
    // transport: a row naming anything unrecognised got a SQL Anywhere
    // connector aimed at that row's `host`, and reported its failure as an
    // Eaglesoft failure. Absence is never a silent success.
    //
    // Mutation: make `connectorForProvider` return `undefined` (or restore the
    // SQL fallback) for a miss and this goes red.
    expect(() => connectorForProvider({ provider: "mystery", host: "10.0.0.5" })).toThrow(
      ConnectorBlockedError,
    );
    expect(() => connectorForProvider({ provider: "mystery", host: "10.0.0.5" })).toThrow(
      /unknown ERP provider "mystery"/,
    );
  });

  it("refuses the empty provider and a catalog-only placeholder for the same reason", () => {
    // `opendental` HAS a descriptor — it is a hub card with no shipped
    // transport. Having a descriptor must not make it buildable, or a
    // placeholder becomes a connectable integration by accident.
    expect(() => connectorForProvider({ provider: "", host: "h" })).toThrow(ConnectorBlockedError);
    expect(() => connectorForProvider({ provider: "opendental", host: "h" })).toThrow(
      ConnectorBlockedError,
    );
    expect(isKnownErpProvider("opendental")).toBe(false);
  });

  it("degrades a refusal to ERP_NOT_CONNECTED rather than a fault", () => {
    // ConnectorBlockedError specifically, not a bare Error: both call sites
    // already map it to "this integration isn't connected", so a row written by
    // an older or newer build shows the owner something actionable instead of a
    // 500.
    try {
      connectorForProvider({ provider: "mystery", host: "10.0.0.5" });
      expect.unreachable("connectorForProvider must throw for an unknown provider");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("CONNECTOR_BLOCKED");
      expect((err as { remediation?: string }).remediation).toBeTruthy();
    }
  });
});

describe("erp-provider export-drop track (WARP-1964)", () => {
  it("accepts an export provider for every vendor with a built-in profile", () => {
    expect(isKnownErpProvider("eaglesoft-export")).toBe(true);
    expect(isKnownErpProvider("dentrix-export")).toBe(true);
    expect(isKnownErpProvider("opendental-export")).toBe(true);
    expect(isKnownErpProvider("generic-export")).toBe(true);
  });

  it("rejects an export provider for a vendor nobody has a profile for", () => {
    expect(isKnownErpProvider("nosuchpms-export")).toBe(false);
    // The bare vendor name is still not a provider — the suffix is what selects
    // this track, so the pre-existing direct-track keys are unaffected.
    expect(isKnownErpProvider("dentrix")).toBe(false);
  });

  it("builds the export-drop connector, one per vendor, off the same key shape", () => {
    for (const vendor of ["eaglesoft", "dentrix", "opendental"]) {
      const c = connectorForProvider({ provider: `${vendor}-export`, host: "" });
      expect(c.provider).toBe(`${vendor}-export`);
    }
  });

  it("does not divert the two direct-connection tracks", () => {
    // `eaglesoft-api` ends in neither "-export" nor anything else this branch
    // matches; a regression here would silently repoint a live REST connection
    // at a folder.
    expect(connectorForProvider({ provider: EAGLESOFT_API_PROVIDER, host: "h" }).provider).toBe(
      "eaglesoft-api",
    );
    expect(connectorForProvider({ provider: EAGLESOFT_PROVIDER, host: "h" }).provider).toBe(
      "eaglesoft",
    );
  });

  it("stays blocked when no drop root is configured", async () => {
    // ERP_EXPORT_DROP_ROOT defaults to empty, so a box that has not been given
    // a folder reports that rather than reporting a connection failure.
    const c = connectorForProvider({ provider: "eaglesoft-export", host: "" });
    await expect(c.connect()).rejects.toThrow(/CONNECTOR_BLOCKED|blocked/i);
  });
});
