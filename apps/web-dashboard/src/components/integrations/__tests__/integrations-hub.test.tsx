/**
 * WARP-2291 — the Integrations hub's three shipped defects, pinned.
 *
 * Every one of these was invisible to the suite that shipped them, because the
 * only vendor the hub was hardcoded to (`eaglesoft`) was also the only one
 * whose catalog id happened to be byte-equal to a backend provider key. The
 * two defects masked each other perfectly, so each test below is written to go
 * **red against `74492c21`** — a regression test that would have passed before
 * the fix proves nothing.
 *
 *   (a) `openConnector`/`connectConnector` were `if (e.meta.id === "eaglesoft")`
 *       with no `else`. Connect on any other tile did nothing at all.
 *   (b) the status map was built on `c.provider` and read with `meta.id`, so a
 *       CONNECTED `quickbooks-online` row rendered NOT_CONFIGURED forever.
 *   (c) `entries` was `CONNECTORS.map(...)`, so a provider the box reports but
 *       the catalog does not list had no tile at all.
 *
 * Plus the no-guessing-state violation underneath all three: a `NOT_CONFIGURED`
 * synthesized from a `Map` miss, which made "not answered yet", "the read
 * failed" and "genuinely unconfigured" one indistinguishable state.
 *
 * These are component tests over an SWR fixture — the real `useIntegrations`
 * runs, only the module boundary (`fetchIntegrations`) is stubbed. No database,
 * mock or otherwise (team rule).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import type { IntegrationConnection, IntegrationStatus } from "@/lib/erp-types";

vi.mock("@/lib/api.erp", () => ({
  fetchIntegrations: vi.fn(),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/integrations",
  useSearchParams: () => new URLSearchParams(),
}));

// ShellPage does its own SWR health read and device-address lookup, both
// covered by their own tests. Passthrough keeps this file about the hub.
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ children }: { children?: ReactNode }) => (
    <div className="droplet-shell">{children}</div>
  ),
}));

// The wizard is a five-step form with its own suite. Here it only has to be
// observably open or shut, so "did the click do something" is unambiguous.
vi.mock("@/components/integrations/ConnectWizard", () => ({
  ConnectWizard: ({ open }: { open: boolean }) =>
    open ? <div data-testid="connect-wizard">wizard</div> : null,
}));

/**
 * Extra descriptors a test can add to the catalog.
 *
 * This is load-bearing, not convenience. Today exactly one catalog vendor is
 * `availability: "available"` and it is the one the hub used to be hardcoded
 * to, so with the shipped catalog the hardcode is *unobservable* — the other
 * three tiles have no live button either way. WARP-2123 is the story that
 * flips those flags, and until it lands the only honest way to test that
 * dispatch works for **any** vendor is to give the hub a second one. That is
 * also the real contract: the hub must work off descriptors, not off the four
 * names that happen to be in the catalog this week.
 */
const extraDescriptors: ProviderDescriptor[] = [];
vi.mock("@/components/integrations/provider-descriptors", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/integrations/provider-descriptors")>();
  return {
    ...actual,
    get PROVIDER_DESCRIPTORS() {
      return [...actual.PROVIDER_DESCRIPTORS, ...extraDescriptors];
    },
  };
});

import { fetchIntegrations } from "@/lib/api.erp";
import type { ProviderDescriptor } from "@/components/integrations/provider-descriptors";
import IntegrationsPage from "@/app/integrations/page";

/** A second connectable vendor, so dispatch is tested off data, not off a name. */
const ACME: ProviderDescriptor = {
  meta: {
    id: "acme-pms",
    name: "Acme PMS",
    category: "Practice management",
    description: "A second connectable vendor, for the dispatch contract.",
    availability: "available",
  },
  providerKeys: ["acme-pms", "acme-pms-export"],
  connect: { kind: "wizard" },
  open: { kind: "route", href: "/integrations/acme-pms" },
};

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

/** Every tile in the catalog grid, as its own DOM scope. */
function tiles(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".grid.c3 > .card"));
}

/** The tile whose headline is `name`. */
function tile(container: HTMLElement, name: string): HTMLElement {
  const found = tiles(container).find(
    (t) => within(t).queryByText(name) !== null,
  );
  if (!found) throw new Error(`no tile named ${name}. Rendered: ${renderedNames(container).join(", ")}`);
  return found;
}

function renderedNames(container: HTMLElement): string[] {
  return tiles(container).map(
    (t) => t.querySelector(".type-headline")?.textContent ?? "?",
  );
}

/**
 * Read a dashboard source file. `import.meta.url` is not a `file:` URL under
 * vite's transform, so resolve from the package root instead and fail loudly
 * if the walk misses — a source assertion that silently reads the wrong file
 * would pass forever.
 */
function readSource(relative: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    dir = resolve(dir, "..");
  }
  const fromRepoRoot = resolve(process.cwd(), "apps/web-dashboard", relative);
  if (existsSync(fromRepoRoot)) return readFileSync(fromRepoRoot, "utf8");
  throw new Error(`could not locate ${relative} from ${process.cwd()}`);
}

beforeEach(() => {
  push.mockReset();
  vi.mocked(fetchIntegrations).mockReset();
});

afterEach(() => {
  vi.mocked(fetchIntegrations).mockReset();
  extraDescriptors.length = 0;
});

// ---------------------------------------------------------------------------
// (a) Dispatch — WARP-2324
// ---------------------------------------------------------------------------

describe("hub dispatch", () => {
  /**
   * The headline assertion. Not "Eaglesoft works" — every tile the hub renders
   * must answer a click with something the owner can see.
   *
   * Mutation: restore `if (e.meta.id === "eaglesoft")` on `connectConnector`
   * and every non-Eaglesoft tile with a live button goes red here, because a
   * click that returns silently changes nothing in the DOM.
   */
  it("every rendered tile answers its action with a route, a wizard, or a stated reason", async () => {
    extraDescriptors.push(ACME);
    const rows = [
      conn("eaglesoft", "NOT_CONFIGURED"),
      conn("quickbooks-online", "CONNECTED"),
      conn("m365", "PROVISIONING"),
      conn("acme-pms", "NOT_CONFIGURED"),
    ];
    vi.mocked(fetchIntegrations).mockResolvedValue(rows);

    const first = renderHub();
    await waitFor(() => expect(renderedNames(first.container)).toContain("M365"));
    const names = renderedNames(first.container);
    first.unmount();
    expect(names.length).toBeGreaterThan(1);

    // Each tile gets its own render. A shared one would let the wizard opened
    // by the previous tile stand in as "this tile acted" — which is exactly
    // the false pass the shipped hardcode would have earned.
    for (const name of names) {
      vi.mocked(fetchIntegrations).mockResolvedValue(rows);
      push.mockReset();
      const { container, unmount } = renderHub();
      await waitFor(() => expect(renderedNames(container)).toContain(name));

      const card = tile(container, name);
      const button = within(card).queryByRole("button");

      if (!button || (button as HTMLButtonElement).disabled) {
        // No live affordance is fine — but only if the tile says why, in
        // words, next to the thing that cannot be clicked.
        expect(
          /Available in a future update|can't be set up|no detail view|no setup flow/i.test(
            card.textContent ?? "",
          ),
          `${name} offers no action and no reason for it`,
        ).toBe(true);
        unmount();
        continue;
      }

      fireEvent.click(button);
      const acted =
        push.mock.calls.length > 0 ||
        within(container).queryByTestId("connect-wizard") !== null ||
        within(container).queryByTestId("hub-blocked-reason") !== null;
      expect(acted, `clicking ${name}'s "${button.textContent}" did nothing`).toBe(true);
      unmount();
    }
  });

  /**
   * WARP-2466 — the same dispatch contract, on the three SHIPPED vendors.
   *
   * The test above proves dispatch works for a vendor registered by the test
   * itself. That was the only way to prove it while Eaglesoft was the sole
   * `available` descriptor — and wave 1 recorded exactly this trap: a
   * regression test that is vacuously green because the shipped data cannot
   * make the defect observable.
   *
   * Stripe, HubSpot and Mailchimp are `available` in the SHIPPED registry, so
   * this version needs no fixture at all. Mutation: reinstate
   * `if (e.meta.id === "eaglesoft")` on `connectConnector` and all three go
   * red against production data.
   */
  it("dispatches Connect for the three shipped SaaS vendors", async () => {
    for (const name of ["Stripe", "HubSpot", "Mailchimp"]) {
      vi.mocked(fetchIntegrations).mockResolvedValue([]);
      push.mockReset();
      const { container, unmount } = renderHub();
      await waitFor(() => expect(renderedNames(container)).toContain(name));

      const card = tile(container, name);
      const button = within(card).getByRole("button");
      expect((button as HTMLButtonElement).disabled, `${name}'s action is disabled`).toBe(false);

      fireEvent.click(button);
      const acted =
        push.mock.calls.length > 0 ||
        within(container).queryByTestId("connect-wizard") !== null ||
        within(container).queryByTestId("hub-blocked-reason") !== null;
      expect(acted, `clicking ${name}'s "${button.textContent}" did nothing`).toBe(true);
      unmount();
    }
  });

  /**
   * The mutation this whole story exists to kill, made observable.
   *
   * Mutation: `const connectConnector = (e) => { if (e.meta.id === <one
   * vendor>) setWizardOpen(true); }` — the shipped code — and this goes red,
   * because Acme's Connect then does nothing at all.
   */
  it("a second connectable vendor's Connect opens its flow, with no vendor name in the dispatch", async () => {
    extraDescriptors.push(ACME);
    vi.mocked(fetchIntegrations).mockResolvedValue([]);
    const { container } = renderHub();
    await waitFor(() => expect(renderedNames(container)).toContain("Acme PMS"));

    expect(screen.queryByTestId("connect-wizard")).toBeNull();
    fireEvent.click(within(tile(container, "Acme PMS")).getByRole("button"));
    expect(screen.getByTestId("connect-wizard")).toBeTruthy();
  });

  /**
   * The same for the `route` branch, and for `openConnector`.
   *
   * Mutation: restore the hardcoded id test on `openConnector` → red, because
   * a connected Acme row's Open then pushes nowhere.
   */
  it("a connected vendor's Open routes to its own detail surface", async () => {
    extraDescriptors.push(ACME);
    vi.mocked(fetchIntegrations).mockResolvedValue([conn("acme-pms", "CONNECTED")]);
    const { container } = renderHub();
    await waitFor(() => expect(renderedNames(container)).toContain("Acme PMS"));

    fireEvent.click(within(tile(container, "Acme PMS")).getByRole("button"));
    expect(push).toHaveBeenCalledWith("/integrations/acme-pms");
  });

  it("the Eaglesoft tile opens the connect wizard", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn("eaglesoft", "NOT_CONFIGURED")]);
    const { container } = renderHub();
    await screen.findByText("Eaglesoft");

    expect(screen.queryByTestId("connect-wizard")).toBeNull();
    fireEvent.click(within(tile(container, "Eaglesoft")).getByRole("button"));
    expect(screen.getByTestId("connect-wizard")).toBeTruthy();
  });

  /**
   * A connected row in the Connected strip is always clickable, so it is the
   * one place an `unavailable` dispatch can actually be reached. It must say
   * why rather than return silently.
   *
   * Mutation: make `run()`'s `unavailable` branch a bare `return` → red.
   */
  it("a connected provider with no detail view says so instead of doing nothing", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn("quickbooks-online", "CONNECTED")]);
    renderHub();
    const row = await screen.findByRole("button", { name: /QuickBooks/ });

    fireEvent.click(row);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId("hub-blocked-reason").textContent).toContain("QuickBooks");
  });

  /**
   * The AC's grep, as a test. The hub page may not name a vendor id, and
   * neither file may hold a provider id list of its own — the catalog comes
   * from one adapter module that WARP-2217 deletes.
   *
   * Mutation: re-add `if (e.meta.id === "eaglesoft")` or a hardcoded id array
   * to either file → red.
   */
  it("neither the hub page nor the hook names a provider id", () => {
    const page = readSource("src/app/integrations/page.tsx");
    const hook = readSource("src/lib/hooks/useIntegrations.ts");
    for (const id of ["eaglesoft", "dentrix", "quickbooks", "opendental"]) {
      expect(page, `page.tsx names "${id}"`).not.toContain(`"${id}"`);
      expect(hook, `useIntegrations.ts names "${id}"`).not.toContain(`"${id}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Status merge — WARP-2327
// ---------------------------------------------------------------------------

describe("status merge on the provider key the backend emits", () => {
  /**
   * THE regression proof. `quickbooks-online` is not byte-equal to the catalog
   * id `quickbooks`, so against `74492c21` this row was fetched, dropped on a
   * `Map` miss, and rendered as the synthesized NOT_CONFIGURED — forever, at a
   * faithful 30-second refresh.
   *
   * Mutation: revert the lookup to `byId.get(meta.id)` → red.
   */
  it("a CONNECTED quickbooks-online row lights up the QuickBooks tile", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn("quickbooks-online", "CONNECTED")]);
    const { container } = renderHub();
    await screen.findByText("QuickBooks");

    expect(within(tile(container, "QuickBooks")).getByText("Connected")).toBeTruthy();
    expect(within(tile(container, "QuickBooks")).queryByText("Not connected")).toBeNull();
    // …and it reaches the Connected strip, which is what the owner actually
    // looks at first.
    expect(screen.getByRole("button", { name: /QuickBooks/ })).toBeTruthy();
  });

  /**
   * Mutation: map only the exact catalog id (drop `DIRECT_PROVIDER_KEYS`) →
   * both cases go red.
   */
  it("dentrix-ascend reaches Dentrix and eaglesoft-api reaches Eaglesoft", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([
      conn("dentrix-ascend", "CONNECTED"),
      conn("eaglesoft-api", "CONNECTED"),
    ]);
    const { container } = renderHub();
    await screen.findByText("Dentrix");

    expect(within(tile(container, "Dentrix")).getByText("Connected")).toBeTruthy();
    expect(within(tile(container, "Eaglesoft")).getByText("Connected")).toBeTruthy();
  });

  /**
   * A vendor connected by two tracks at once resolves to one tile, and the
   * live track is the one shown — `list()` always returns both Eaglesoft keys,
   * so this is the shape a real box emits.
   */
  it("a vendor connected on one of two tracks shows the live one, on a single tile", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([
      conn("eaglesoft", "NOT_CONFIGURED"),
      conn("eaglesoft-api", "CONNECTED"),
    ]);
    const { container } = renderHub();
    await screen.findByText("Eaglesoft");

    expect(renderedNames(container).filter((n) => n === "Eaglesoft")).toHaveLength(1);
    expect(within(tile(container, "Eaglesoft")).getByText("Connected")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (c) Entries from the API — WARP-2333
// ---------------------------------------------------------------------------

describe("entries are the union of the catalog and the response", () => {
  /**
   * Mutation: revert `entries` to `CONNECTORS.map(...)` → red, because the
   * catalog has no M365 and no generic-export.
   */
  it("a provider the box reports but the catalog does not list still gets a tile", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([
      conn("m365", "CONNECTED"),
      conn("generic-export", "ERROR"),
    ]);
    const { container } = renderHub();
    await waitFor(() => expect(renderedNames(container)).toContain("M365"));

    expect(within(tile(container, "M365")).getByText("Connected")).toBeTruthy();
    expect(within(tile(container, "Generic Export")).getByText("Can't connect")).toBeTruthy();
  });

  it("catalog-only providers still render when nothing is connected", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([]);
    const { container } = renderHub();
    await waitFor(() => expect(renderedNames(container)).toContain("Open Dental"));

    expect(renderedNames(container)).toEqual([
      "Eaglesoft",
      "Dentrix",
      "QuickBooks",
      "Open Dental",
      // WARP-2466 — the three WARP-2214 SaaS vendors. They appear here with no
      // hub code change at all: the grid is DERIVED from the descriptor
      // catalog (#1809 + #1808), so registering a descriptor is what puts a
      // tile on the page. Mutation: delete a `catalog` block from one of the
      // three descriptors → red.
      "Stripe",
      "HubSpot",
      "Mailchimp",
    ]);
  });

  /**
   * Ordering is deterministic: catalog order, then reported-only providers
   * sorted by key. A response arriving must not reshuffle the grid under the
   * owner's cursor.
   *
   * Mutation: append reported-only entries in response order → red, because
   * the fixture is deliberately out of sorted order.
   */
  it("orders the grid deterministically regardless of response order", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([
      conn("m365", "CONNECTED"),
      conn("generic-export", "CONNECTED"),
    ]);
    const { container } = renderHub();
    await waitFor(() => expect(renderedNames(container)).toContain("M365"));

    expect(renderedNames(container)).toEqual([
      "Eaglesoft",
      "Dentrix",
      "QuickBooks",
      "Open Dental",
      // WARP-2466 — the three WARP-2214 SaaS vendors. They appear here with no
      // hub code change at all: the grid is DERIVED from the descriptor
      // catalog (#1809 + #1808), so registering a descriptor is what puts a
      // tile on the page. Mutation: delete a `catalog` block from one of the
      // three descriptors → red.
      "Stripe",
      "HubSpot",
      "Mailchimp",
      "Generic Export",
      "M365",
    ]);
  });

  /**
   * Nothing the API says about a connection may vanish from the UI without a
   * trace — the alarm the AC asks for, expressed as the property it protects.
   *
   * Mutation: skip rows whose provider matches no descriptor → red.
   */
  it("every row in the response reaches some tile", async () => {
    const rows = [
      conn("eaglesoft-export", "CONNECTED"),
      conn("dentrix-ascend", "DEGRADED"),
      conn("quickbooks-online", "CONNECTED"),
      conn("opendental-export", "ERROR"),
      conn("m365", "PROVISIONING"),
      conn("something-nobody-wrote-a-tile-for", "DISABLED"),
    ];
    vi.mocked(fetchIntegrations).mockResolvedValue(rows);
    const { container } = renderHub();
    await waitFor(() => expect(renderedNames(container)).toContain("M365"));

    // Seven catalog tiles (four original + the three WARP-2214 vendors) absorb
    // four of the rows; the two the catalog knows nothing about each get their
    // own.
    expect(tiles(container)).toHaveLength(9);
    for (const name of [
      "Eaglesoft",
      "Dentrix",
      "QuickBooks",
      "Open Dental",
      "Stripe",
      "HubSpot",
      "Mailchimp",
      "M365",
      "Something Nobody Wrote A Tile For",
    ]) {
      expect(renderedNames(container), `${name} vanished`).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// State discrimination — WARP-2337
// ---------------------------------------------------------------------------

describe("loading, fetch-error and not-configured are three states", () => {
  /**
   * Mutation: collapse any of the three back into a synthesized
   * `{ status: "NOT_CONFIGURED" }` — the shipped fallback — and the three
   * assertions below stop being distinguishable.
   */
  it("renders a distinct state while the read is still in flight", async () => {
    vi.mocked(fetchIntegrations).mockReturnValue(new Promise(() => {}));
    const { container } = renderHub();

    const eaglesoft = tile(container, "Eaglesoft");
    expect(within(eaglesoft).getAllByText("Checking…").length).toBeGreaterThan(0);
    expect(within(eaglesoft).queryByText("Not connected")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a failed read as a failure, not as an empty healthy hub", async () => {
    const err = Object.assign(new Error("nope"), { code: "NETWORK_ERROR", status: 0 });
    vi.mocked(fetchIntegrations).mockRejectedValue(err);
    const { container } = renderHub();

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Couldn't check connection status");
    expect(banner.textContent).toContain("NETWORK_ERROR");

    const eaglesoft = tile(container, "Eaglesoft");
    expect(within(eaglesoft).getByText("Status unavailable")).toBeTruthy();
    expect(within(eaglesoft).queryByText("Not connected")).toBeNull();
    expect(within(eaglesoft).queryByText("Checking…")).toBeNull();
  });

  /**
   * The box answered and said nothing about this provider. That is a fourth
   * fact again — `absent`, not `NOT_CONFIGURED` — and it renders as the
   * first-run "Connect" affordance with no status pill: neither the loading
   * caption nor the failure badge, and no alarm.
   */
  it("renders an empty successful response as an offered connector, with no alarm", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([]);
    const { container } = renderHub();
    await waitFor(() =>
      expect(within(tile(container, "Eaglesoft")).queryByText("Checking…")).toBeNull(),
    );

    const eaglesoft = tile(container, "Eaglesoft");
    expect(within(eaglesoft).getByRole("button").textContent).toBe("Connect");
    expect(eaglesoft.querySelector(".badge")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(eaglesoft).queryByText("Status unavailable")).toBeNull();
  });

  /**
   * …and the box explicitly saying NOT_CONFIGURED is a fifth, distinct
   * rendering — it gets a pill, because the box actually answered about it.
   *
   * Mutation: fabricate `{ status: "NOT_CONFIGURED" }` for a Map miss (the
   * shipped fallback) and this stops being distinguishable from the test
   * above.
   */
  it("distinguishes an explicit NOT_CONFIGURED from a provider the box never mentioned", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([conn("eaglesoft", "NOT_CONFIGURED")]);
    const { container } = renderHub();
    await waitFor(() =>
      expect(within(tile(container, "Eaglesoft")).queryByText("Checking…")).toBeNull(),
    );

    expect(within(tile(container, "Eaglesoft")).getByText("Not connected")).toBeTruthy();
    // Open Dental was never mentioned by the box, so it carries no pill at all.
    expect(tile(container, "Open Dental").querySelector(".badge")).toBeNull();
  });

  /**
   * Fixing the status merge made five of the seven `IntegrationStatus` values
   * reachable in the hub for the first time. None may fall through to a
   * default that reads as healthy. WARP-2458 adds the eighth,
   * `NEEDS_RECONNECT`, which is the one this rule was written for: it is where
   * a revoked credential lands, and before it existed such a connection
   * rendered as "Connected".
   *
   * Mutation: fold DRIFT_LOCKED back into DEGRADED's "Needs attention" → red.
   * Mutation: delete the NEEDS_RECONNECT case so it falls through to
   * `statusView`'s `default` → the tile reads "Unknown state" → red.
   */
  it("gives all eight IntegrationStatus values their own rendering", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([
      conn("eaglesoft", "CONNECTED"),
      conn("dentrix-ascend", "DEGRADED"),
      conn("quickbooks-online", "DRIFT_LOCKED"),
      conn("opendental-export", "ERROR"),
      conn("m365", "PROVISIONING"),
      conn("aaa-export", "DISABLED"),
      conn("zzz-export", "NOT_CONFIGURED"),
      conn("mmm-export", "NEEDS_RECONNECT"),
    ]);
    const { container } = renderHub();
    await waitFor(() => expect(renderedNames(container)).toContain("M365"));

    const labels: Array<[string, string]> = [
      ["Eaglesoft", "Connected"],
      ["Dentrix", "Needs attention"],
      ["QuickBooks", "Locked — schema changed"],
      ["Open Dental", "Can't connect"],
      ["M365", "Setting up"],
      ["Aaa Export", "Turned off"],
      ["Zzz Export", "Not connected"],
      ["Mmm Export", "Paste a new key"],
    ];
    for (const [name, label] of labels) {
      expect(within(tile(container, name)).getByText(label), `${name} → ${label}`).toBeTruthy();
    }
    expect(new Set(labels.map(([, l]) => l)).size).toBe(8);
  });

  /**
   * The triple ADR-042 §6 requires to stay pairwise distinguishable. All three
   * look identical to a "does a credential decrypt?" check and mean opposite
   * things to the person reading the dashboard: one was never set up, one was
   * turned off on purpose, one is broken and waiting for a human to act.
   *
   * Mutation: give NEEDS_RECONNECT either of the other two labels → red.
   */
  it("keeps DISABLED, NOT_CONFIGURED and NEEDS_RECONNECT pairwise distinct", async () => {
    vi.mocked(fetchIntegrations).mockResolvedValue([
      conn("aaa-export", "DISABLED"),
      conn("zzz-export", "NOT_CONFIGURED"),
      conn("mmm-export", "NEEDS_RECONNECT"),
    ]);
    const { container } = renderHub();
    await waitFor(() => expect(renderedNames(container)).toContain("Mmm Export"));

    const seen = ["Aaa Export", "Zzz Export", "Mmm Export"].map(
      (n) => tile(container, n).textContent ?? "",
    );
    expect(seen.some((t) => t.includes("Turned off"))).toBe(true);
    expect(seen.some((t) => t.includes("Not connected"))).toBe(true);
    expect(seen.some((t) => t.includes("Paste a new key"))).toBe(true);
    expect(new Set(seen).size).toBe(3);
  });
});
