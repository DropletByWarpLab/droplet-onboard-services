/**
 * WARP-2659 — the two facts the HUB CARD needs the box to state.
 *
 * The card for an `mcp` track is derived from the descriptor registry, so it
 * renders whether or not a connection row exists. That leaves the dashboard
 * with a question only the box can answer honestly: is this thing connected?
 *
 * It must NOT answer that itself. `buildHubEntries` keeps `absent` ("the box
 * mentioned nothing") distinct from a reported `NOT_CONFIGURED`, because
 * synthesizing the latter from a `Map` miss is the WARP-2291 defect, and
 * `integrations-hub.test.tsx` pins the distinction — an absent tile renders no
 * pill at all. So `list()` always lists an MCP provider, exactly as it has
 * always listed Eaglesoft before it is configured, and the status is the
 * explicit column.
 *
 * The second fact is the expiry verdict. WARP-2650 put it on
 * `/api/integrations/credentials`; the hub needs the same one, from the same
 * derivation, so a token twelve days from a hard stop cannot read as "expiring
 * soon" on one page and "Connected" full stop on the other.
 */
import { describe, it, expect, vi } from "vitest";
import { mcpProviderIds, providerDescriptor } from "@droplet/shared-types";

import {
  createIntegrationsService,
  credentialExpiryFor,
} from "./integrations.service.js";

/** The shipped MCP track, read from the registry — the dashboard holds no
 *  per-provider literal and neither does this suite. */
const MCP_ID = mcpProviderIds()[0]!;

/** The `providerConfig` field the descriptor names as carrying the expiry. */
const EXPIRY_FIELD = providerDescriptor(MCP_ID)!.credentialExpiry!.field;

/**
 * A COMPLETE stored config, built from the descriptor's own required
 * `providerConfig` fields.
 *
 * Completeness is load-bearing rather than tidiness: `credentialExpiryFor`
 * parses the config with `parseProviderConfigWith` before classifying, and a
 * config missing a required field fails that parse and reports EXPIRY_UNKNOWN.
 * A hand-written partial fixture would therefore have passed the UNKNOWN case
 * for the wrong reason and made the EXPIRING_SOON case unreachable — which is
 * exactly what the first draft of this suite did.
 */
function configWith(extra: Record<string, string> = {}): Record<string, string> {
  const required = Object.fromEntries(
    providerDescriptor(MCP_ID)!
      .credentialFields.filter((f) => f.required && f.storage === "providerConfig")
      .map((f) => [f.name, `fixture-${f.name}`]),
  );
  return { provider: MCP_ID, ...required, ...extra };
}

function serviceWith(rows: Array<Record<string, unknown>>) {
  const prisma = {
    integrationConnection: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => rows),
      findUnique: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(),
    },
    erpAuditLog: { create: vi.fn() },
    erpSyncCursor: { findMany: vi.fn(async () => []) },
  };
  return createIntegrationsService(prisma as never);
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: "conn-mcp",
    provider: MCP_ID,
    status: "CONNECTED",
    host: null,
    port: null,
    databaseName: null,
    secretRef: `${MCP_ID}:pending`,
    schemaVersion: null,
    schemaHash: null,
    writeEnabled: false,
    lastHealthyAt: null,
    apiCredentialsEnc: null,
    providerTokensEnc: "sealed",
    providerConfig: configWith(),
    ...over,
  };
}

/** A `YYYY-MM-DD` exactly `days` from `now`, the way a customer transcribes it. */
function dateIn(days: number, now: Date): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

async function listed(rows: Array<Record<string, unknown>>, provider: string) {
  const found = (await serviceWith(rows).list()).find((r) => r.provider === provider);
  if (!found) throw new Error(`no listed row for ${provider}`);
  return found;
}

describe("an MCP track is always listed, so the hub never infers its state", () => {
  /**
   * The load-bearing one.
   *
   * Mutation: drop `...mcpProviderIds()` from `list()`'s provider set → the
   * provider is missing from the payload → the hub tile falls back to `absent`
   * and renders no status pill at all → red here and in
   * `mcp-hub-card.test.tsx`'s NOT_CONFIGURED case.
   */
  it("reports NOT_CONFIGURED explicitly when no row exists", async () => {
    const listing = await serviceWith([]).list();
    expect(listing.map((r) => r.provider)).toContain(MCP_ID);

    const mcp = await listed([], MCP_ID);
    expect(mcp.status).toBe("NOT_CONFIGURED");
    expect(mcp.configured).toBe(false);
    // Nothing stored, so nothing to expire — NOT `EXPIRY_UNKNOWN`, which means
    // a credential IS stored with no date recorded and has its own remedy.
    expect(mcp.credentialExpiry).toBeNull();
    expect(mcp.credentialsPurged).toBe(false);
  });

  /** Every registered MCP track, not just the first — the derivation is over
   *  the registry, so a second provider is covered the day it lands. */
  it("lists every MCP provider the registry declares", async () => {
    const listing = await serviceWith([]).list();
    for (const id of mcpProviderIds()) {
      expect(listing.map((r) => r.provider)).toContain(id);
    }
  });

  /** An existing row still wins — the forced entry must not shadow it. */
  it("reports the row's own status once one exists", async () => {
    const mcp = await listed([row({ status: "CONNECTED" })], MCP_ID);
    expect(mcp.status).toBe("CONNECTED");
    expect(mcp.configured).toBe(true);
    // Listed once, not twice, despite being both forced and present.
    const listing = await serviceWith([row()]).list();
    expect(listing.filter((r) => r.provider === MCP_ID)).toHaveLength(1);
  });
});

describe("the hub row carries the same expiry verdict the configurator shows", () => {
  /**
   * Mutation: return `null` unconditionally from `credentialExpiryFor` → red.
   * Mutation: `Math.round` instead of `Math.floor` in `credentialExpiryVerdict`
   * → 12 becomes 13 → red.
   */
  it("classifies a date inside the warning window as EXPIRING_SOON", async () => {
    const now = new Date();
    const mcp = await listed(
      [row({ providerConfig: configWith({ [EXPIRY_FIELD]: dateIn(13, now) }) })],
      MCP_ID,
    );
    expect(mcp.credentialExpiry?.status).toBe("EXPIRING_SOON");
    // Floored, and a bare date parses as midnight UTC — the START of the
    // stated day — so the count is 12 whole days, never 13.
    expect(mcp.credentialExpiry?.daysRemaining).toBe(12);
  });

  /**
   * A stored credential with no recorded date. Its own state, with its own
   * remedy, and never VALID — no warning could ever fire for it.
   *
   * Mutation: treat a missing date as VALID → red.
   */
  it("reports EXPIRY_UNKNOWN for a stored credential with no date", async () => {
    const mcp = await listed([row()], MCP_ID);
    expect(mcp.credentialExpiry).toEqual({
      status: "EXPIRY_UNKNOWN",
      daysRemaining: null,
    });
  });

  /**
   * The absence of a policy is a CLAIM — "this credential cannot expire" —
   * not silence to be filled in optimistically. Every cloud and LAN provider
   * lands here, and a warning state they could never leave would be the
   * defect `credentialExpiryVerdict`'s docstring exists to prevent.
   */
  it("is null for a provider declaring no expiry policy", () => {
    expect(credentialExpiryFor("stripe", { provider: "stripe" }, new Date())).toBeNull();
    // An unknown key names nothing this appliance knows, which is also null —
    // never a fabricated verdict.
    expect(credentialExpiryFor("nope", {}, new Date())).toBeNull();
  });

  /** Generic by construction: the descriptor names the field, so the service
   *  never compares `provider` against a vendor key — the doctrine
   *  `saas-credential.service.ts`'s header makes explicit. */
  it("reads the field the descriptor names, not a hardcoded one", async () => {
    const now = new Date();
    const wrongField = await listed(
      [row({ providerConfig: configWith({ someOtherField: dateIn(2, now) }) })],
      MCP_ID,
    );
    expect(wrongField.credentialExpiry?.status).toBe("EXPIRY_UNKNOWN");
  });
});
