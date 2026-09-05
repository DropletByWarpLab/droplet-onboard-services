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
 * shared descriptors run; only `fetchIntegrations`, `disconnectProvider`, the
 * session and the router are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { mcpProviderIds, providerDescriptor } from "@droplet/shared-types";
import type { IntegrationConnection, IntegrationStatus } from "@/lib/erp-types";
import { CONNECTORS, MCP_CONNECTORS } from "@/lib/connectors";
import { PROVIDER_DESCRIPTORS } from "@/components/integrations/provider-descriptors";

/**
 * WARP-2518 — stage's `ConnectorCard` mounts `DisconnectControl` on every
 * reported non-`NOT_CONFIGURED` row, and that control reads `useAuth`, which
 * throws outside an `AuthProvider`. The session is stubbed the way the hub
 * suite stubs it — a mutable role in a hoisted holder — so the control's own
 * admin gate is something these tests can exercise rather than merely
 * satisfy.
 */
const { session, disconnectProviderMock } = vi.hoisted(() => ({
  session: { role: "owner" as string | undefined },
  disconnectProviderMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: session.role ? { id: "u-1", role: session.role } : null }),
}));

vi.mock("@/lib/api.erp", () => ({
  fetchIntegrations: vi.fn(),
  disconnectProvider: disconnectProviderMock,
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
  session.role = "owner";
  disconnectProviderMock.mockReset().mockResolvedValue({});
});

describe("the card is derived from the mcp track, not from a catalog block", () => {
  /**
   * The premise. If this ever goes red the rest of the file is testing a
   * fixture rather than the product.
   *
   * MEMBERSHIP, not a count. This file promises to keep working for the
   * second MCP provider without being edited, and a `toHaveLength(1)` would
   * have broken that promise the day it landed. The card set is asserted
   * equal to the registry's `mcp` set, in order, so a descriptor that gains
   * no card — or a card with no descriptor — is what goes red.
   *
   * Mutation: delete the `atlassian` descriptor from `provider-registry.ts` →
   * `MCP_CONNECTORS` is empty and every test in this file fails.
   */
  it("ships one card per MCP-track descriptor, keyed on the descriptor id", () => {
    expect(MCP_CONNECTORS.length).toBeGreaterThan(0);
    expect(MCP_CONNECTORS.map((c) => c.id)).toEqual(mcpProviderIds());
    for (const card of MCP_CONNECTORS) {
      const descriptor = providerDescriptor(card.id);
      expect(descriptor?.track).toBe("mcp");
      // The card id IS the connection row's `provider` key, which is what lets
      // the hub's status join work with no mapping entry.
      expect(card.id).toBe(descriptor!.id);
    }
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

    const button = within(mcpTile(container)).getByRole("button", { name: "Open" });
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

    const button = within(mcpTile(container)).getByRole("button", { name: "Connect" });
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
    // The button SET, named, rather than counted: a connected tile carries
    // exactly its primary action and stage's WARP-2518 Disconnect control, and
    // nothing else that could be a wizard, a probe or a sync. Counting would
    // let a second primary action hide behind a missing Disconnect.
    expect(
      within(card)
        .getAllByRole("button")
        .map((b) => (b.textContent ?? "").trim()),
    ).toEqual(["Open", `Disconnect ${MCP_CONNECTORS[0]!.name}`]);
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

  /**
   * WARP-2659 — the "On this box only" badge on the Connected strip describes
   * the synced copy of a connector's data, and this track keeps no copy: the
   * tile's own line says "nothing is copied onto the box". `syncs` fixed the
   * sub-line; the badge has to follow the same fact, or the strip claims a
   * residency for data the box never holds while the tile beneath it denies
   * one.
   *
   * Asserted on BOTH rows, so the gate cannot pass by dropping the badge
   * everywhere. Mutation: render the badge unconditionally → red on the MCP
   * row; invert the gate → red on the Eaglesoft row.
   */
  it("shows no on-this-box badge for a track that copies nothing onto the box", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([
      conn(MCP_ID, "CONNECTED"),
      conn("eaglesoft", "CONNECTED"),
    ]);
    const { container } = renderHub();
    await settled(container);

    const rows = Array.from(container.querySelectorAll<HTMLElement>(".rows .lrow"));
    const mcpRow = rows.find((r) => r.textContent?.includes(MCP_CONNECTORS[0]!.name));
    const lanRow = rows.find((r) => r.textContent?.includes("Eaglesoft"));
    expect(mcpRow, "the MCP row is on the Connected strip").toBeTruthy();
    expect(lanRow, "the Eaglesoft row is on the Connected strip").toBeTruthy();
    expect(mcpRow!.textContent).not.toContain("On this box only");
    expect(lanRow!.textContent).toContain("On this box only");
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
   * NOT a gate on `list()`, and it cannot be one: this suite stubs
   * `fetchIntegrations` and hands the hub the row directly, so dropping
   * `...mcpProviderIds()` from `list()`'s provider set leaves every case here
   * green. That mutation is caught by `integrations.mcp-listing.test.ts` on
   * the orchestrator side — the only place the join between the two can be
   * observed. What this proves is that the tile can SAY "not connected" when
   * the box says it; never that the box says it.
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
   *
   * Three silences, each a different fact and each covered: a VALID verdict,
   * an explicit `null` (the provider declares no expiry policy — every cloud
   * and LAN row), and no key at all (a box older than the field). The last
   * two are the "none at all" half this test used to name without
   * exercising; `credentialExpiryCopy` treats them alike, and a tile that
   * rendered a line for either would be a warning nothing can ever clear.
   */
  const SILENT: ReadonlyArray<[string, Partial<IntegrationConnection>]> = [
    ["a VALID verdict", { credentialExpiry: { status: "VALID", daysRemaining: 240 } }],
    ["an explicit null — the provider declares no expiry policy", { credentialExpiry: null }],
    ["no key at all — an older box that never computed one", {}],
  ];
  it.each(SILENT)("renders no expiry line for %s", async (_label, over) => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn(MCP_ID, "CONNECTED", over)]);
    const { container } = renderHub();
    await settled(container);

    expect(
      within(mcpTile(container)).queryByTestId("connector-expiry-line"),
    ).toBeNull();
  });
});

describe("Disconnect on the MCP tile reaches the box's purge (WARP-2659)", () => {
  /**
   * Stage's WARP-2518 control renders on this tile as on every other, and
   * until this PR its click 404'd: `disconnect()` gated on
   * `isKnownErpProvider`, an explicit `lan | cloud` allow-list, so the one
   * surface that could remove an Atlassian token rendered an action that
   * could not finish. The box admits the track now
   * (`integrations.disconnect-purge.test.ts`); this pins the dashboard half —
   * the tile posts the descriptor id, which IS the row's `provider` key, and
   * only after the confirmation.
   *
   * Mutation: pass `meta.id` where `ConnectorCard` passes `reported.provider`
   * → still green here, because for this track the two are byte-equal by
   * construction — which is the point of `providerKeys: [id]`, and is pinned
   * above. The hub suite covers the divergent case with QuickBooks.
   */
  it("offers Disconnect on a connected tile and posts the descriptor id after confirmation", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn(MCP_ID, "CONNECTED")]);
    const { container } = renderHub();
    await settled(container);

    fireEvent.click(within(mcpTile(container)).getByRole("button", { name: /^Disconnect / }));
    // A step, not a courtesy: nothing is purged until the confirmation.
    expect(disconnectProviderMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("disconnect-confirm").textContent).toContain(
      "removes the stored credential",
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnectProviderMock).toHaveBeenCalledTimes(1));
    expect(disconnectProviderMock).toHaveBeenCalledWith(MCP_ID);
  });

  /**
   * The two exclusions the control inherits: nothing to disconnect on a
   * NOT_CONFIGURED row, and nothing offered to a session the route would 403.
   */
  it("offers no Disconnect on a not-configured tile", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn(MCP_ID, "NOT_CONFIGURED")]);
    const { container } = renderHub();
    await settled(container);
    expect(
      within(mcpTile(container)).queryByRole("button", { name: /^Disconnect / }),
    ).toBeNull();
  });

  it("offers no Disconnect to a non-admin session", async () => {
    session.role = "family";
    vi.mocked(fetchIntegrations).mockResolvedValue([conn(MCP_ID, "CONNECTED")]);
    const { container } = renderHub();
    await settled(container);
    expect(
      within(mcpTile(container)).queryByRole("button", { name: /^Disconnect / }),
    ).toBeNull();
    // The primary action is untouched by the role gate.
    expect(within(mcpTile(container)).getByRole("button", { name: "Open" })).toBeTruthy();
  });
});
