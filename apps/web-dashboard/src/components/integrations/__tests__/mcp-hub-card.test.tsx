/**
 * WARP-2659 — an `mcp`-track provider gets a hub card derived from the
 * descriptor registry, not from a `catalog` block or a `ConnectorId` literal.
 *
 * WARP-3965 replaced the hub page with the Connectors directory, so the
 * page-level halves of this file (tile affordances, state copy, Disconnect on
 * the tile) went with it; the directory's own behaviour is pinned in
 * `connector-directory.test.tsx`. What stays is the derivation, which
 * `useIntegrations` and the Connect wizard still rely on.
 */
import { describe, it, expect } from "vitest";
import { mcpProviderIds, providerDescriptor } from "@droplet/shared-types";
import { CONNECTORS, MCP_CONNECTORS } from "@/lib/connectors";
import { PROVIDER_DESCRIPTORS } from "@/components/integrations/provider-descriptors";

/**
 * The shipped MCP provider, read from the registry rather than typed as a
 * literal: the dashboard holds no per-provider MCP literal, and these tests keep
 * working for a second MCP provider without being edited.
 */
const MCP_ID = MCP_CONNECTORS[0]?.id ?? "";

describe("the card is derived from the mcp track, not from a catalog block", () => {
  /**
   * MEMBERSHIP, not a count: the card set equals the registry's `mcp` set, in
   * order, so a descriptor that gains no card — or a card with no descriptor —
   * is what goes red.
   */
  it("ships one card per MCP-track descriptor, keyed on the descriptor id", () => {
    expect(MCP_CONNECTORS.length).toBeGreaterThan(0);
    expect(MCP_CONNECTORS.map((c) => c.id)).toEqual(mcpProviderIds());
    for (const card of MCP_CONNECTORS) {
      const descriptor = providerDescriptor(card.id);
      expect(descriptor?.track).toBe("mcp");
      // The card id IS the connection row's `provider` key, which is what lets
      // the status join work with no mapping entry.
      expect(card.id).toBe(descriptor!.id);
    }
  });

  /** The closed `ConnectorId` union stays closed. */
  it("adds NO id to the catalog-block cards the ConnectorId union covers", () => {
    expect(CONNECTORS.map((c) => c.id)).not.toContain(MCP_ID);
    expect(providerDescriptor(MCP_ID)?.catalog).toBeUndefined();
  });

  /** Copy comes off the descriptor; nothing in the dashboard writes a sentence about a vendor. */
  it("takes name, category, description and guide from the descriptor", () => {
    const d = providerDescriptor(MCP_ID)!;
    if (d.track !== "mcp") throw new Error("fixture is not an mcp track");
    expect(MCP_CONNECTORS[0]).toEqual({
      id: d.id,
      name: d.displayName,
      category: d.category,
      description: d.description,
      availability: "available",
      setupGuideHref: d.setupGuideHref,
    });
  });

  /**
   * `providerKeysFor` appends `<id>-export`, which belongs to the export-drop
   * family. An MCP track has no such key.
   */
  it("answers to the descriptor id alone — no <id>-export sibling", () => {
    const entry = PROVIDER_DESCRIPTORS.find((d) => d.meta.id === MCP_ID)!;
    expect(entry.providerKeys).toEqual([MCP_ID]);
    expect(entry.syncs).toBe(false);
  });
});
