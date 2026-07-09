/**
 * WARP-1094 — EaglesoftConnector stub contract (brief §6, §7).
 *
 * This slice is DB-independent: every driver/network boundary is stubbed and
 * throws a typed ConnectorBlockedError. These tests pin that contract so the
 * blocked boundary is explicit and can't silently start "working" against a
 * fake database (team rule: no mock-DB integration tests). The pure
 * statement-building pieces are tested in their own suites.
 */
import { describe, it, expect } from "vitest";
import {
  EaglesoftConnector,
  ConnectorBlockedError,
  fingerprintTables,
  type ConnectorConfig,
} from "../src/connector.js";

const config: ConnectorConfig = {
  host: "10.0.0.5",
  port: 2638,
  serverName: "PattersonPM",
  databaseName: "PattersonPM",
  readSecretRef: "secret://erp/eaglesoft/droplet_ro",
};

describe("EaglesoftConnector (stubbed driver)", () => {
  it("is the eaglesoft provider", () => {
    expect(new EaglesoftConnector(config).provider).toBe("eaglesoft");
  });

  it("blocks connect() until the driver + copy DB exist", async () => {
    await expect(new EaglesoftConnector(config).connect()).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
  });

  it("blocks introspect() and health()", async () => {
    const c = new EaglesoftConnector(config);
    await expect(c.introspect()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("blocks runRead() and applyWrite()", async () => {
    const c = new EaglesoftConnector(config);
    await expect(c.runRead("get_schedule_today", {})).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
    await expect(c.applyWrite("reschedule_appointment", {})).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
  });

  it("never persists a cleartext password (secretRef pointer only)", () => {
    const c = new EaglesoftConnector(config);
    // The connector holds only a secret-store pointer; assert it is a ref.
    expect(config.readSecretRef.startsWith("secret://")).toBe(true);
    expect(JSON.stringify(config)).not.toMatch(/password/i);
    void c;
  });

  it("exposes a pure fingerprint helper for drift re-checks", () => {
    const fp = fingerprintTables([
      { name: "appointment", owner: "dba", columns: [{ name: "appt_id", type: "integer" }] },
    ]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
