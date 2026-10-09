/**
 * WARP-2412 — `deriveMcpOAuthTokenKey()` and its row+owner AAD binding.
 *
 * Same two promises as column-crypto.saas-credential.test.ts: the key is its
 * own purpose, and a blob moved to another row/owner THROWS (never returns
 * empty, which would read as "not connected" instead of "tampered with").
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

import {
  __setColumnCryptoKeyForTest,
  decryptColumn,
  deriveErpCloudTokenKey,
  deriveM365TokenCacheKey,
  deriveSaasCredentialKey,
  deriveMcpOAuthTokenKey,
  encryptColumn,
  ENC_PREFIX,
  mcpOAuthAad,
} from "./column-crypto.service.js";
import { redactSecretParams } from "../lib/log-redaction.js";
import { MIGRATIONS_DIR, SCHEMA_PATH } from "../__tests__/helpers/test-paths.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const SEEDED = "SEEDED-MCP-OAUTH-TOKEN";
const A = { id: "row_a", scope: "MEMBER" as const, memberId: "user_alice" };
const B = { id: "row_b", scope: "MEMBER" as const, memberId: "user_alice" };
const A_BOB = { id: "row_a", scope: "MEMBER" as const, memberId: "user_bob" };
const A_WS = { id: "row_a", scope: "WORKSPACE" as const, memberId: null };

beforeEach(() => {
  __setColumnCryptoKeyForTest(TEST_KEY);
});

const seal = (row: Parameters<typeof mcpOAuthAad>[0]) =>
  encryptColumn(deriveMcpOAuthTokenKey(), SEEDED, mcpOAuthAad(row));
const open = (blob: string, row: Parameters<typeof mcpOAuthAad>[0]) =>
  decryptColumn(deriveMcpOAuthTokenKey(), blob, mcpOAuthAad(row));

describe("deriveMcpOAuthTokenKey", () => {
  it("is its own key, distinct from every other column purpose", () => {
    const k = deriveMcpOAuthTokenKey();
    // Mutation: aliasing onto deriveErpCloudTokenKey turns these red.
    expect(k.equals(deriveErpCloudTokenKey())).toBe(false);
    expect(k.equals(deriveM365TokenCacheKey())).toBe(false);
    expect(k.equals(deriveSaasCredentialKey())).toBe(false);
  });

  it("changes with the device secret, so a factory reset crypto-shreds", () => {
    const before = deriveMcpOAuthTokenKey();
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 8).toString("base64"));
    expect(deriveMcpOAuthTokenKey().equals(before)).toBe(false);
  });

  it("cannot open a blob sealed under another purpose's key", () => {
    const blob = encryptColumn(deriveErpCloudTokenKey(), SEEDED, mcpOAuthAad(A));
    expect(() => open(blob, A)).toThrow();
  });
});

describe("MCP OAuth AAD binding fails closed", () => {
  it("round-trips for the row and owner it was sealed for, as a dcv1: blob", () => {
    const blob = seal(A);
    expect(blob.startsWith(ENC_PREFIX)).toBe(true);
    expect(blob).not.toContain(SEEDED);
    expect(open(blob, A)).toBe(SEEDED);
    expect(open(seal(A_WS), A_WS)).toBe(SEEDED);
  });

  it("throws when the blob is moved to a different row", () => {
    expect(() => open(seal(A), B)).toThrow();
  });

  it("throws when the blob is moved to another member's row", () => {
    expect(() => open(seal(A), A_BOB)).toThrow();
  });

  it("throws when a member blob is re-scoped to WORKSPACE (or back)", () => {
    expect(() => open(seal(A), A_WS)).toThrow();
    expect(() => open(seal(A_WS), A)).toThrow();
  });

  it("refuses to build an ambiguous AAD", () => {
    expect(() => mcpOAuthAad({ id: "r", scope: "MEMBER", memberId: null })).toThrow();
    expect(() => mcpOAuthAad({ id: "r", scope: "WORKSPACE", memberId: "u" })).toThrow();
    expect(() => mcpOAuthAad({ id: "", scope: "WORKSPACE", memberId: null })).toThrow();
  });
});

describe("rule 19 — secret columns never reach a log", () => {
  it("redacts the new columns by name", () => {
    const out = redactSecretParams({
      tokensEnc: "dcv1:abc",
      clientSecretEnc: "dcv1:def",
      provider: "notion",
    });
    expect(JSON.stringify(out)).not.toContain("dcv1:");
    expect(out.provider).toBe("notion");
  });
});

describe("McpOAuthConnection schema and migration (WARP-2409)", () => {
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  const model = schema.slice(schema.indexOf("model McpOAuthConnection {"));
  const dirs = readFileSync(
    `${MIGRATIONS_DIR}/20261008140000_warp_2409_mcp_oauth_connection/migration.sql`,
    "utf-8",
  );

  it("keeps NEEDS_RECONNECT distinct from DISCONNECTED and defaults state explicitly", () => {
    const en = schema.slice(schema.indexOf("enum McpOAuthConnectionState {"));
    const body = en.slice(0, en.indexOf("}"));
    expect(body).toMatch(/NEEDS_RECONNECT/);
    expect(body).toMatch(/DISCONNECTED/);
    expect(model).toMatch(/state\s+McpOAuthConnectionState\s+@default\(DISCONNECTED\)/);
  });

  it("models the owner as an explicit scope enum plus memberId, with pinned hosts", () => {
    expect(model).toMatch(/scope\s+McpOAuthScope\n/);
    expect(model).toMatch(/memberId String\?/);
    expect(model).toMatch(/issuer\s+String\n/);
    expect(model).toMatch(/tokenEndpointHost\s+String\n/);
    expect(model).toMatch(/@@index\(\[memberId\]\)/);
  });

  it("enforces owner, acknowledgement and token invariants in SQL", () => {
    expect(dirs).toMatch(/"scope" = 'MEMBER'\) = \("memberId" IS NOT NULL\)/);
    expect(dirs).toMatch(/workspaceAckAt" IS NOT NULL/);
    expect(dirs).toMatch(/"state" <> 'CONNECTED' OR "tokensEnc" IS NOT NULL/);
    expect(dirs).toMatch(/WHERE "scope" = 'WORKSPACE'/);
  });
});
