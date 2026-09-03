/**
 * WARP-2659 — an `mcp`-track provider gets a hub card, and it is NOT an ERP
 * card.
 *
 * WARP-2650 shipped the Atlassian descriptor with `catalog?: never` and
 * recorded the consequence as its first gap: the provider was invisible on
 * `/integrations`, reachable only from `/integrations/credentials`. A customer
 * looking for "connect Jira" looks at the hub.
 *
 * Two halves are proved here, and the second matters as much as the first:
 *
 *  1. **The card exists**, derived from the descriptor registry — no
 *     `ConnectorId` literal, no `catalog` block. Deleting the `mcp` arm of
 *     `hubCardFor` is a `tsc` error; deleting the descriptor takes these tests
 *     out wholesale.
 *  2. **The card offers nothing the track cannot do.** No wizard (transport
 *     probe, read scopes, dataset sync), no second Connect path that could
 *     store a credential over a working one, and no "synced …" claim for a
 *     track that never syncs. Both actions land on the configurator.
 *
 * Component tests over an SWR fixture, matching `integrations-hub.test.tsx`:
 * the real `useIntegrations`, the real `connectors.ts` derivation and the real
 * shared descriptors run; only `fetchIntegrations` and the router are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { providerDescriptor } from "@droplet/shared-types";
import type { IntegrationConnection, IntegrationStatus } from "@/lib/erp-types";
import { CONNECTORS, MCP_CONNECTORS } from "@/lib/connectors";
import { PROVIDER_DESCRIPTORS } from "@/components/integrations/provider-descriptors";

vi.mock("@/lib/api.erp", () => ({
  fetchIntegrations: vi.fn(),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/integrations",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ children }: { children?: ReactNode }) => (
    <div className="droplet-shell">{children}</div>
  ),
}));

// Observably open or shut, and reporting WHICH provider — so "the wizard did
// not open" is an assertion about the DOM rather than about a spy.
vi.mock("@/components/integrations/ConnectWizard", () => ({
  ConnectWizard: ({ catalogId }: { catalogId: string | null }) =>
    catalogId ? (
      <div data-testid="connect-wizard" data-provider={catalogId}>
        wizard
      </div>
    ) : null,
}));

import { fetchIntegrations } from "@/lib/api.erp";
import IntegrationsPage from "@/app/integrations/page";

/**
 * The shipped MCP provider, read from the registry rather than typed as a
 * literal.
 *
 * The point of the whole change is that the dashboard holds no per-provider
 * MCP literal, so a test that hard-coded "atlassian" everywhere would be
 * asserting the opposite shape. The id is read once, here, and everything else
 * is derived — which also means these tests keep working for the SECOND MCP
 * provider without being edited.
 */
const MCP_ID = MCP_CONNECTORS[0]?.id ?? "";
const CREDENTIALS_ROUTE = "/integrations/credentials";

const conn = (
  provider: string,
  status: IntegrationStatus,
  over: Partial<IntegrationConnection> = {},
): IntegrationConnection => ({ provider, status, writeEnabled: false, ...over });

function renderHub() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <IntegrationsPage />
    </SWRConfig>,
  );
}

function tiles(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".grid.c3 > .card"));
}

function tile(container: HTMLElement, name: string): HTMLElement {
  const found = tiles(container).find((t) => within(t).queryByText(name) !== null);
  if (!found) {
    const names = tiles(container).map(
      (t) => t.querySelector(".type-headline")?.textContent ?? "?",
    );
    throw new Error(`no tile named ${name}. Rendered: ${names.join(", ")}`);
  }
  return found;
}

/** The MCP tile, found by the name the descriptor declares. */
function mcpTile(container: HTMLElement): HTMLElement {
  return tile(container, MCP_CONNECTORS[0]!.name);
}

/** Settle the first render so `state.kind` is no longer `loading`. */
async function settled(container: HTMLElement) {
  await waitFor(() =>
    expect(within(mcpTile(container)).queryByText("Checking…")).toBeNull(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the card is derived from the mcp track, not from a catalog block", () => {
  /**
   * The premise. If this ever goes red the rest of the file is testing a
   * fixture rather than the product.
   *
   * Mutation: delete the `atlassian` descriptor from `provider-registry.ts` →
   * `MCP_CONNECTORS` is empty and every test in this file fails.
   */
  it("ships exactly one MCP-track card, keyed on the descriptor id", () => {
    expect(MCP_CONNECTORS).toHaveLength(1);
    const descriptor = providerDescriptor(MCP_ID);
    expect(descriptor?.track).toBe("mcp");
    // The card id IS the connection row's `provider` key, which is what lets
    // the hub's status join work with no mapping entry.
    expect(MCP_CONNECTORS[0]!.id).toBe(descriptor!.id);
  });

  /**
   * The shape decision, pinned: the closed `ConnectorId` union stays closed.
   *
   * Mutation: give the descriptor a `catalog` block (and widen `ConnectorId`)
   * → the id appears in `CONNECTORS` → red, and `connectors.test.ts`'s pinned
   * id list goes red too.
   */
  it("adds NO id to the catalog-block cards the ConnectorId union covers", () => {
    expect(CONNECTORS.map((c) => c.id)).not.toContain(MCP_ID);
    expect(providerDescriptor(MCP_ID)?.catalog).toBeUndefined();
  });

  /**
   * Copy comes off the descriptor. Nothing in the dashboard writes a sentence
   * about a vendor — the rule `descriptorForReportedProvider` already states.
   */
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
   * family. An MCP track has no such key, and claiming it would let this tile
   * swallow a reported connection that is not its own.
   *
   * Mutation: build the entry with `providerKeysFor(meta.id)` → red.
   */
  it("answers to the descriptor id alone — no <id>-export sibling", () => {
    const entry = PROVIDER_DESCRIPTORS.find((d) => d.meta.id === MCP_ID)!;
    expect(entry.providerKeys).toEqual([MCP_ID]);
    expect(entry.syncs).toBe(false);
  });
});

describe("the card's affordances are the credential configurator's, not the ERP wizard's", () => {
  /**
   * The ticket's headline. A CONNECTED MCP row's primary action opens the
   * configurator.
   *
   * Mutation: wire `connect`/`open` to `{ kind: "wizard" }` → the wizard
   * mounts, `push` is never called → red on both assertions.
   */
  it("Open on a connected card routes to the credentials configurator", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn(MCP_ID, "CONNECTED")]);
    const { container } = renderHub();
    await settled(container);

    const button = within(mcpTile(container)).getByRole("button");
    expect(button.textContent).toBe("Open");
    fireEvent.click(button);

    expect(push).toHaveBeenCalledWith(CREDENTIALS_ROUTE);
    expect(screen.queryByTestId("connect-wizard")).toBeNull();
  });

  /**
   * …and so does the first-run action, to the SAME place.
   *
   * That sameness is the WARP-2483 lesson: a separate Connect path alongside a
   * stored credential is how a second credential gets written over a working
   * one. The configurator renders one form per provider whose secret input
   * says "Saved — replace to change", so first-run and re-entry are one act.
   */
  it("Connect on a not-configured card routes to the same configurator", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn(MCP_ID, "NOT_CONFIGURED")]);
    const { container } = renderHub();
    await settled(container);

    const button = within(mcpTile(container)).getByRole("button");
    expect(button.textContent).toBe("Connect");
    fireEvent.click(button);

    expect(push).toHaveBeenCalledWith(CREDENTIALS_ROUTE);
    expect(screen.queryByTestId("connect-wizard")).toBeNull();
  });

  /**
   * The negative half, stated as a set rather than one example: NONE of the
   * ERP card's own affordances appear. Each names something the track cannot
   * do — probe a transport, grant a read scope, pick a dataset, run a sync.
   */
  it("offers no sync, dataset or transport affordance", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn(MCP_ID, "CONNECTED")]);
    const { container } = renderHub();
    await settled(container);

    const card = mcpTile(container);
    for (const absent of ["Sync now", "Resume setup", "Fix connection", "Retry"]) {
      expect(within(card).queryByText(absent)).toBeNull();
    }
    // Exactly one action, so there is no second button to be a wizard.
    expect(within(card).getAllByRole("button")).toHaveLength(1);
    expect(card.querySelector("input")).toBeNull();
  });

  /**
   * WARP-2342's guide link, which for this track is the only place a customer
   * learns where the token is minted — the credential is created in a vendor
   * console Warp Lab does not control.
   */
  it("links the setup guide the descriptor declares", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn(MCP_ID, "CONNECTED")]);
    const { container } = renderHub();
    await settled(container);

    const link = within(mcpTile(container)).getByText("Setup guide").closest("a");
    expect(link?.getAttribute("href")).toBe(MCP_CONNECTORS[0]!.setupGuideHref);
  });

  /**
   * WARP-2659 — the Connected strip must not claim a sync this track never
   * performs. `syncedAgo(undefined)` is the string "never", so the shipped
   * sub-line would have read "Connected · synced never".
   *
   * Mutation: `syncs: true` on the MCP entry → "synced never" appears → red.
   */
  it("drops the synced clause from the Connected strip", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn(MCP_ID, "CONNECTED")]);
    const { container } = renderHub();
    await settled(container);

    const row = container.querySelector(".rows .lrow");
    expect(row?.textContent).toContain("Connected");
    expect(row?.textContent).not.toContain("synced");
    expect(row?.textContent).toContain("read-only");
  });
});

describe("state copy comes from the box, never from absence", () => {
  /**
   * The three states the ticket names, each read off a REPORTED row.
   *
   * `NOT_CONFIGURED` is the one that needed backend work: the hub's `absent`
   * state renders no pill at all, on purpose (`integrations-hub.test.tsx`
   * pins that a `Map` miss is not a status — the WARP-2291 defect). So the
   * box now always lists an MCP provider, exactly as it always lists
   * Eaglesoft, and this pill is the box's own answer.
   *
   * Mutation: drop `...mcpProviderIds()` from `list()`'s provider set → a box
   * with no Atlassian row reports nothing → the tile falls back to `absent`
   * and renders no pill → red.
   */
  it.each([
    ["CONNECTED" as const, "Connected"],
    ["NOT_CONFIGURED" as const, "Not connected"],
    ["NEEDS_RECONNECT" as const, "Paste a new key"],
  ])("renders %s as %s", async (status, label) => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn(MCP_ID, status)]);
    const { container } = renderHub();
    await settled(container);

    expect(within(mcpTile(container)).getByText(label)).toBeTruthy();
  });

  /**
   * The read-time expiry state (WARP-2650's `credentialExpiry`), rendered
   * ALONGSIDE the status rather than folded into it.
   *
   * That separation is the point: this connection is genuinely CONNECTED and
   * genuinely needs action, and `IntegrationStatus` has no EXPIRING_SOON
   * member to say both. The verdict is computed by the box; the tile only
   * chooses the sentence, through the same `credentialExpiryCopy` the
   * credential configurator uses.
   *
   * Mutation: stop passing `credentialExpiry` through `ConnectorCard` → red.
   */
  it("shows the expiry warning beside a CONNECTED pill", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([
      conn(MCP_ID, "CONNECTED", {
        credentialExpiry: { status: "EXPIRING_SOON", daysRemaining: 12 },
      }),
    ]);
    const { container } = renderHub();
    await settled(container);

    const card = mcpTile(container);
    expect(within(card).getByText("Connected")).toBeTruthy();
    expect(within(card).getByTestId("connector-expiry-line").textContent).toBe(
      "Expires in 12 days — create a replacement and paste it in.",
    );
  });

  /**
   * A stored credential with no recorded date is its own state with its own
   * remedy, and emphatically not VALID — no warning can ever fire for it.
   */
  it("says so when no expiry date was recorded", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([
      conn(MCP_ID, "CONNECTED", {
        credentialExpiry: { status: "EXPIRY_UNKNOWN", daysRemaining: null },
      }),
    ]);
    const { container } = renderHub();
    await settled(container);

    expect(
      within(mcpTile(container)).getByTestId("connector-expiry-line").textContent,
    ).toContain("No expiry date recorded");
  });

  /**
   * …and a comfortable date is silent. A footnote on every healthy tile is
   * noise that trains an owner to ignore the one that matters.
   */
  it("renders no expiry line for a VALID verdict or none at all", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([
      conn(MCP_ID, "CONNECTED", {
        credentialExpiry: { status: "VALID", daysRemaining: 240 },
      }),
    ]);
    const { container } = renderHub();
    await settled(container);

    expect(
      within(mcpTile(container)).queryByTestId("connector-expiry-line"),
    ).toBeNull();
  });
});
