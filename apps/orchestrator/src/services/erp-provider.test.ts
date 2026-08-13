/**
 * WARP-1294 — the dual-track connector factory: one place that maps a provider
 * key to a concrete Connector. Constructing a connector is pure (no I/O), so
 * these assertions are offline.
 */
import { describe, it, expect } from "vitest";
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

  it("falls back to the SQL connector for an unknown provider (never a surprise transport)", () => {
    const c = connectorForProvider({ provider: "mystery", host: "10.0.0.5" });
    expect(c.provider).toBe("eaglesoft");
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
