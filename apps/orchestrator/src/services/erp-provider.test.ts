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
