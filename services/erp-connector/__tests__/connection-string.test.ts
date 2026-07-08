/**
 * WARP-1094 — connection-string builder tests (brief §7.2; review C-1).
 *
 * Unit tests only; no database is touched. These pin the two corrections:
 * `Host` XOR `CommLinks` (never both), and `Encryption=NONE` by default.
 */
import { describe, it, expect } from "vitest";
import {
  buildConnectionString,
  ConnectionStringError,
  DEFAULT_PORT,
  DEFAULT_DATABASE_NAME,
  DEFAULT_SERVER_NAME,
} from "../src/connection-string.js";

describe("buildConnectionString", () => {
  const base = { host: "192.168.1.50", userId: "droplet_ro", password: "s3cret" };

  it("emits a Host= form and NEVER a CommLinks= form (review C-1)", () => {
    const s = buildConnectionString(base);
    expect(s).toContain(`Host=192.168.1.50:${DEFAULT_PORT}`);
    expect(s).not.toMatch(/CommLinks/i);
  });

  it("defaults ServerName, DatabaseName, port, and Encryption=NONE", () => {
    const s = buildConnectionString(base);
    expect(s).toContain(`ServerName=${DEFAULT_SERVER_NAME}`);
    expect(s).toContain(`DatabaseName=${DEFAULT_DATABASE_NAME}`);
    expect(s).toContain(`Host=192.168.1.50:2638`);
    expect(s).toContain("Encryption=NONE");
  });

  it("carries the provisioned login and password", () => {
    const s = buildConnectionString(base);
    expect(s).toContain("UID=droplet_ro");
    expect(s).toContain("PWD=s3cret");
  });

  it("honors explicit port, serverName, databaseName, and encryption", () => {
    const s = buildConnectionString({
      ...base,
      port: 2639,
      serverName: "MYENGINE",
      databaseName: "PattersonPM",
      encryption: "TLS(trusted_certificates=cert.pem)",
    });
    expect(s).toContain("Host=192.168.1.50:2639");
    expect(s).toContain("ServerName=MYENGINE");
    expect(s).toContain("Encryption=TLS(trusted_certificates=cert.pem)");
  });

  it("brace-quotes values with reserved characters (spaces / semicolons)", () => {
    const s = buildConnectionString({ ...base, serverName: "MY ENGINE", password: "a;b" });
    expect(s).toContain("ServerName={MY ENGINE}");
    expect(s).toContain("PWD={a;b}");
  });

  it("rejects a value that cannot be encoded (contains })", () => {
    expect(() => buildConnectionString({ ...base, password: "bad}pw" })).toThrow(
      ConnectionStringError,
    );
  });

  it("rejects a missing host / userId / password", () => {
    expect(() => buildConnectionString({ ...base, host: "" })).toThrow(ConnectionStringError);
    expect(() => buildConnectionString({ ...base, userId: "  " })).toThrow(ConnectionStringError);
    expect(() => buildConnectionString({ ...base, password: "" })).toThrow(ConnectionStringError);
  });

  it("rejects an out-of-range port", () => {
    expect(() => buildConnectionString({ ...base, port: 0 })).toThrow(ConnectionStringError);
    expect(() => buildConnectionString({ ...base, port: 70000 })).toThrow(ConnectionStringError);
    expect(() => buildConnectionString({ ...base, port: 2638.5 })).toThrow(ConnectionStringError);
  });
});
