/**
 * WARP-2451 — the connect wizard renders from the provider descriptor.
 *
 * The defect these pin: the wizard WAS one vendor's LAN flow — host, TCP port,
 * reachability probe, SQL-Anywhere DBA script — with no OAuth or
 * credential-paste affordance anywhere in it. WARP-2291 made the hub's dispatch
 * total, so the moment a second vendor declared `connect: { kind: "wizard" }`
 * its owner would be asked for a hostname and a database port for a cloud API
 * that has neither. Not a crash: a form that cannot be completed truthfully,
 * which is worse, because the owner will try.
 *
 * Every test below is written to go RED against the shipped wizard, and each
 * carries the mutation that turns it red again — a regression test that passes
 * before the fix proves nothing.
 *
 * The fixtures are registered at RUNTIME through
 * `registerProviderDescriptor`, not added to the shipped registry. That is the
 * claim under test: a new provider is a descriptor, and the wizard needs no
 * change to render it. WARP-2466 adds Stripe, HubSpot and Mailchimp exactly
 * this way; if any of them needed a line here, this file would be a lie.
 *
 * Nothing is stubbed except the two module boundaries that would reach the
 * network (`@/lib/api`, `@/lib/api.erp`). The real descriptors, the real
 * `Dialog`, and the real field rendering all run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import {
  providerDescriptor,
  registerProviderDescriptor,
  __resetRegisteredProvidersForTest,
  type ProviderDescriptor,
} from "@droplet/shared-types";

vi.mock("@/lib/api", () => ({
  fetchSaasCredentials: vi.fn(),
  saveSaasCredential: vi.fn(),
}));

vi.mock("@/lib/api.erp", () => ({
  testLanConnection: vi.fn(),
  connectLanProvider: vi.fn(),
}));

import { fetchSaasCredentials, saveSaasCredential } from "@/lib/api";
import { testLanConnection, connectLanProvider } from "@/lib/api.erp";
import { ConnectWizard } from "../ConnectWizard";
import type { ErpScope } from "@/lib/erp-types";

/**
 * A cloud vendor whose entire credential is one pasted secret — the shape
 * three of the five v1 vendors have (Stripe `rk_live_…`, HubSpot `pat-na1-…`,
 * Mailchimp `…-us14`).
 *
 * The key shape is composed from parts at runtime, never written as one
 * literal: GitHub's push protection has vendor detectors that reject a
 * realistic-looking key at `git push` even when local gitleaks is clean
 * (WARP-2379).
 */
const PASTE_ONLY: ProviderDescriptor = {
  id: "fixture-paste",
  displayName: "Fixture Payments",
  category: "Payments",
  track: "cloud",
  credentialFields: [
    {
      name: "apiKey",
      label: "Restricted API key",
      type: "string",
      required: true,
      secret: true,
      storage: "encrypted",
      pattern: "^fk_(live|test)_",
      help: "Create a restricted key in the vendor console.",
    },
  ],
  egressHosts: ["api.fixture-payments.invalid"],
  datasets: ["charge"],
  catalog: {
    id: "fixture-paste",
    name: "Fixture Payments",
    category: "Payments",
    description: "One pasted key, nothing else.",
    availability: "available",
    setupGuideHref: "/docs/integrations/fixture-paste",
    order: 90,
  },
};

/** A vendor whose credential is a PAIR — a merchant-owned client id and secret
 *  (Shopify's shape). */
const PAIR: ProviderDescriptor = {
  id: "fixture-pair",
  displayName: "Fixture Commerce",
  category: "Commerce",
  track: "cloud",
  credentialFields: [
    {
      name: "clientId",
      label: "Client ID",
      type: "string",
      required: true,
      secret: false,
      storage: "providerConfig",
    },
    {
      name: "clientSecret",
      label: "Client secret",
      type: "string",
      required: true,
      secret: true,
      storage: "encrypted",
    },
  ],
  egressHosts: ["api.fixture-commerce.invalid"],
  datasets: ["order"],
  catalog: {
    id: "fixture-pair",
    name: "Fixture Commerce",
    category: "Commerce",
    description: "Two fields, both required.",
    availability: "available",
    // A DIFFERENT href from PASTE_ONLY's — the WARP-2342 assertion is that two
    // providers link to two places, which a hardcoded link would fail.
    setupGuideHref: "/docs/integrations/fixture-pair",
    order: 91,
  },
};

/**
 * A vendor with a DISCRIMINATED CHOICE — two genuinely different flows with
 * different fields (Xero's Custom Connection vs a customer-owned PKCE app).
 * Rendering the union of both asks for values that cannot coexist.
 */
const TWO_PATH: ProviderDescriptor = {
  id: "fixture-ledger",
  displayName: "Fixture Ledger",
  category: "Accounting",
  track: "cloud",
  credentialFields: [
    {
      name: "tenantId",
      label: "Tenant ID",
      type: "string",
      required: true,
      secret: false,
      storage: "providerConfig",
    },
  ],
  credentialVariants: [
    {
      id: "custom-connection",
      label: "Custom Connection",
      description: "A machine-to-machine app on a paid plan.",
      fields: [
        {
          name: "customClientSecret",
          label: "Custom Connection secret",
          type: "string",
          required: true,
          secret: true,
          storage: "encrypted",
        },
      ],
    },
    {
      id: "pkce-app",
      label: "Your own PKCE app",
      description: "An app you created, with no client secret.",
      fields: [
        {
          name: "pkceClientId",
          label: "PKCE client ID",
          type: "string",
          required: true,
          secret: false,
          storage: "providerConfig",
        },
      ],
    },
  ],
  egressHosts: ["api.fixture-ledger.invalid"],
  datasets: ["invoice"],
  catalog: {
    id: "fixture-ledger",
    name: "Fixture Ledger",
    category: "Accounting",
    description: "Two ways in, one account.",
    availability: "available",
    setupGuideHref: "/docs/integrations/fixture-ledger",
    order: 92,
  },
};

function renderWizard(catalogId: string) {
  return render(
    <ConnectWizard catalogId={catalogId} onClose={vi.fn()} onConnected={vi.fn()} />,
  );
}

/** Every text input the wizard put on screen, in DOM order. */
function inputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>("input"));
}

/**
 * Read a dashboard source file. `import.meta.url` is not a `file:` URL under
 * vite's transform, so walk up from the cwd and fail loudly if the walk misses
 * — a source assertion that silently reads the wrong file passes forever.
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
  __resetRegisteredProvidersForTest();
  vi.mocked(fetchSaasCredentials).mockReset().mockResolvedValue([]);
  vi.mocked(saveSaasCredential).mockReset();
  vi.mocked(testLanConnection).mockReset();
  vi.mocked(connectLanProvider).mockReset();
});

afterEach(() => {
  __resetRegisteredProvidersForTest();
});

// ---------------------------------------------------------------------------
// The generic credential flow
// ---------------------------------------------------------------------------

describe("a provider that needs one pasted secret", () => {
  /**
   * THE headline regression. Against the shipped wizard this vendor was asked
   * "Where is <vendor> running?", for a server address and a TCP port, and was
   * blocked behind a reachability probe that can never succeed for a cloud API.
   *
   * Mutation: fall back to the shipped LAN step list when a descriptor
   * declares no `lanProvisioning` —
   *   `const lan = descriptor?.lanProvisioning
   *      ?? descriptorForCatalogId("eaglesoft")?.lanProvisioning;`
   * — and every assertion below goes red.
   */
  it("gets a one-field paste step: no host, no port, no reachability test", async () => {
    registerProviderDescriptor(PASTE_ONLY);
    renderWizard("fixture-paste");

    await screen.findByText("Restricted API key *");

    // Exactly one input, and it is the secret. Not "no host field visible" —
    // one field, total, because a second question the owner cannot answer is
    // the failure whether or not it is about a host.
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0].type).toBe("password");

    expect(screen.queryByLabelText(/server address/i)).toBeNull();
    expect(screen.queryByLabelText(/^port$/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /test connection/i })).toBeNull();
    expect(screen.queryByText(/database account/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/2638/);
  });

  /**
   * The descriptor is the whole specification: label, help text and
   * requiredness all arrive from it, none of them from this component.
   *
   * Mutation: render a hardcoded label (or drop `field.help`) → red.
   */
  it("renders the descriptor's own label, help and required marker", async () => {
    registerProviderDescriptor(PASTE_ONLY);
    renderWizard("fixture-paste");

    await screen.findByText("Restricted API key *");
    expect(screen.getByText("Create a restricted key in the vendor console.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Fixture Payments" })).toBeTruthy();
  });

  /**
   * A pair renders as a pair, with the non-secret half visible and the secret
   * half masked. Same component, no per-vendor branch.
   *
   * Mutation: render only `credentialFields[0]` → red.
   */
  it("renders a two-field shape with only the secret masked", async () => {
    registerProviderDescriptor(PAIR);
    renderWizard("fixture-pair");

    await screen.findByText("Client ID *");
    const rendered = inputs();
    expect(rendered).toHaveLength(2);
    expect(rendered[0].type).toBe("text");
    expect(rendered[1].type).toBe("password");
    expect(screen.getByText("Client secret *")).toBeTruthy();
  });

  /**
   * Requiredness is enforced, and it is enforced from the descriptor.
   *
   * Mutation: leave the Connect button always enabled → red on the first
   * assertion; treat `required` as advisory → red on the same.
   */
  it("will not submit until every required field is answered", async () => {
    registerProviderDescriptor(PAIR);
    vi.mocked(saveSaasCredential).mockResolvedValue({} as never);
    renderWizard("fixture-pair");

    await screen.findByText("Client ID *");
    const connect = screen.getByRole("button", { name: "Connect Fixture Commerce" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(inputs()[0], { target: { value: "merchant-1" } });
    expect((connect as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(inputs()[1], { target: { value: "s3cret-value" } });
    expect((connect as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * The declared `pattern` is applied to what was typed — the descriptor's
   * validation slot, which no shipped provider used before the vendor stories.
   *
   * Mutation: ignore `field.pattern` → red, because a wrong-prefix key would
   * then submit.
   */
  it("refuses a value that does not match the declared pattern", async () => {
    registerProviderDescriptor(PASTE_ONLY);
    renderWizard("fixture-paste");

    await screen.findByText("Restricted API key *");
    const connect = screen.getByRole("button", { name: "Connect Fixture Payments" });

    fireEvent.change(inputs()[0], { target: { value: "sk_live_wrong_prefix" } });
    expect((connect as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(inputs()[0], { target: { value: "fk_test_" + "abc123" } });
    expect((connect as HTMLButtonElement).disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The discriminated choice
// ---------------------------------------------------------------------------

describe("a provider with two authentication paths", () => {
  /**
   * Mutation: render the union of both paths' fields —
   *   `return [...descriptor.credentialFields,
   *      ...(descriptor.credentialVariants ?? []).flatMap((v) => v.fields)];`
   * in `credentialFieldsFor` — and both assertions below go red, because the
   * owner is then asked for a secret that does not exist on their path.
   */
  it("renders the chosen path's fields only, and switches on selection", async () => {
    registerProviderDescriptor(TWO_PATH);
    renderWizard("fixture-ledger");

    await screen.findByText("Tenant ID *");

    // First variant is selected by default — an unselected radiogroup would be
    // a form with no answerable state.
    expect(screen.getByText("Custom Connection secret *")).toBeTruthy();
    expect(screen.queryByText("PKCE client ID *")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Your own PKCE app/ }));

    expect(screen.getByText("PKCE client ID *")).toBeTruthy();
    expect(screen.queryByText("Custom Connection secret *")).toBeNull();
    // The common field survives the switch — it belongs to the account, not to
    // either path.
    expect(screen.getByText("Tenant ID *")).toBeTruthy();
  });

  /**
   * The chosen path is part of what is saved. Reopening a connection that was
   * made one way must not reopen on the other.
   *
   * Mutation: drop `payload[VARIANT_FIELD]` → red.
   */
  it("sends which path was chosen alongside the fields", async () => {
    registerProviderDescriptor(TWO_PATH);
    vi.mocked(saveSaasCredential).mockResolvedValue({} as never);
    renderWizard("fixture-ledger");

    await screen.findByText("Tenant ID *");
    fireEvent.click(screen.getByRole("radio", { name: /Your own PKCE app/ }));
    fireEvent.change(screen.getByLabelText("Tenant ID *"), { target: { value: "t-1" } });
    fireEvent.change(screen.getByLabelText("PKCE client ID *"), { target: { value: "c-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Fixture Ledger" }));

    await waitFor(() => expect(saveSaasCredential).toHaveBeenCalled());
    const [provider, fields] = vi.mocked(saveSaasCredential).mock.calls[0];
    expect(provider).toBe("fixture-ledger");
    expect(fields).toMatchObject({
      tenantId: "t-1",
      pkceClientId: "c-1",
      credentialVariant: "pkce-app",
    });
    // The path NOT chosen contributes nothing.
    expect(fields).not.toHaveProperty("customClientSecret");
  });
});

// ---------------------------------------------------------------------------
// Secret handling — the house pattern
// ---------------------------------------------------------------------------

describe("a secret field never leaks its value back into the DOM", () => {
  /**
   * The read view carries `hasValue` booleans and no values at all, so the
   * placeholder is the ONLY thing that can tell an owner a credential is
   * stored.
   *
   * Mutation: echo the typed value into the placeholder —
   *   `placeholder={field.secret ? (drafts[field.name] || secretPlaceholder(...)) : ""}`
   * — and the first assertion goes red.
   */
  it("keeps the typed secret out of every attribute the component renders", async () => {
    registerProviderDescriptor(PASTE_ONLY);
    renderWizard("fixture-paste");

    await screen.findByText("Restricted API key *");
    const secret = "fk_test_" + "notarealkey";
    fireEvent.change(inputs()[0], { target: { value: secret } });

    const field = inputs()[0];
    expect(field.getAttribute("placeholder")).toBe("Paste the value");
    // The input's own `value` is where the owner typed it and is the one place
    // it belongs. NOTHING else the component renders may carry it — not the
    // placeholder, not a title, not an aria-label, not a data attribute.
    for (const attr of Array.from(field.attributes)) {
      if (attr.name === "value") continue;
      expect(attr.value, `attribute ${attr.name} echoes the secret`).not.toContain(secret);
    }
    expect(document.body.textContent).not.toContain(secret);
  });

  /**
   * A stored credential announces itself through the placeholder and NOTHING
   * else — in particular, nothing pre-fills the input.
   *
   * Mutation: pre-fill secrets from the read view (`view.values`) → red,
   * because the input would no longer be empty.
   */
  it("says a stored secret exists without ever holding it", async () => {
    registerProviderDescriptor(PASTE_ONLY);
    vi.mocked(fetchSaasCredentials).mockResolvedValue([
      {
        provider: "fixture-paste",
        displayName: "Fixture Payments",
        category: "Payments",
        state: "CONNECTED",
        hasCredentials: true,
        configured: true,
        fields: [
          {
            name: "apiKey",
            label: "Restricted API key",
            type: "string",
            required: true,
            secret: true,
            storage: "encrypted",
            help: null,
            pattern: null,
            hasValue: true,
          },
        ],
        values: {},
        updatedAt: null,
      },
    ]);
    renderWizard("fixture-paste");

    await waitFor(() =>
      expect(inputs()[0].getAttribute("placeholder")).toBe("Saved — replace to change"),
    );
    expect(inputs()[0].value).toBe("");
  });

  /**
   * On a successful save the typed secret is dropped from component state.
   * Keeping it only widens where the plaintext lives, and a second save would
   * resend a value the owner never re-entered.
   *
   * Mutation: skip the `setDrafts` clear after `saveSaasCredential` resolves →
   * red.
   */
  it("clears the typed secret once the box holds it", async () => {
    registerProviderDescriptor(PAIR);
    vi.mocked(saveSaasCredential).mockResolvedValue({} as never);
    renderWizard("fixture-pair");

    await screen.findByText("Client ID *");
    const secret = "shh-" + "value";
    fireEvent.change(inputs()[0], { target: { value: "merchant-1" } });
    fireEvent.change(inputs()[1], { target: { value: secret } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Fixture Commerce" }));

    await screen.findByText("Connected");
    expect(document.body.textContent).not.toContain(secret);
    // …and the value did reach the server, which is the point of the form.
    expect(vi.mocked(saveSaasCredential).mock.calls[0][1]).toMatchObject({
      clientSecret: secret,
    });
  });

  /**
   * An untouched secret is OMITTED from the save, never sent as "" — the
   * client half of the three-way rule (WARP-2275). Sending "" would clear the
   * very credential the owner left alone while editing something else.
   *
   * Mutation: send every field unconditionally → red.
   */
  it("omits a stored secret the owner did not retype", async () => {
    registerProviderDescriptor(PAIR);
    vi.mocked(saveSaasCredential).mockResolvedValue({} as never);
    vi.mocked(fetchSaasCredentials).mockResolvedValue([
      {
        provider: "fixture-pair",
        displayName: "Fixture Commerce",
        category: "Commerce",
        state: "CONNECTED",
        hasCredentials: true,
        configured: true,
        fields: [
          {
            name: "clientSecret",
            label: "Client secret",
            type: "string",
            required: true,
            secret: true,
            storage: "encrypted",
            help: null,
            pattern: null,
            hasValue: true,
          },
        ],
        values: {},
        updatedAt: null,
      },
    ]);
    renderWizard("fixture-pair");

    await waitFor(() =>
      expect(inputs()[1].getAttribute("placeholder")).toBe("Saved — replace to change"),
    );
    fireEvent.change(inputs()[0], { target: { value: "merchant-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Fixture Commerce" }));

    await waitFor(() => expect(saveSaasCredential).toHaveBeenCalled());
    expect(vi.mocked(saveSaasCredential).mock.calls[0][1]).not.toHaveProperty("clientSecret");
  });

  /**
   * A failed save is a failure the owner is told about, and nothing typed is
   * lost.
   *
   * Mutation: land on the success screen regardless of the outcome → red.
   */
  it("reports a failed save instead of claiming a connection", async () => {
    registerProviderDescriptor(PASTE_ONLY);
    vi.mocked(saveSaasCredential).mockRejectedValue(
      Object.assign(new Error("nope"), { code: "NETWORK_ERROR" }),
    );
    renderWizard("fixture-paste");

    await screen.findByText("Restricted API key *");
    fireEvent.change(inputs()[0], { target: { value: "fk_test_" + "abc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Fixture Payments" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Fixture Payments");
    expect(screen.queryByText("Connected")).toBeNull();
    expect(inputs()[0].value).toBe("fk_test_abc123");
  });
});

// ---------------------------------------------------------------------------
// The LAN flow — unchanged
// ---------------------------------------------------------------------------

describe("the shipped LAN flow still has its four steps", () => {
  /**
   * The generalisation is not allowed to cost the one flow that works today.
   *
   * Mutation: route it through the generic renderer by dropping the LAN branch
   * — `const lan = undefined;` in `ConnectWizard`, or deleting
   * `lanProvisioning` from the descriptor — and this goes red at step 1,
   * because the generic flow asks for a credential, not a server.
   */
  it("walks find-the-server → provision → scopes → confirm → connected", async () => {
    vi.mocked(testLanConnection).mockResolvedValue({ reachable: true });
    vi.mocked(connectLanProvider).mockResolvedValue({} as never);
    renderWizard("eaglesoft");

    // Step 1 — find the server.
    expect(screen.getByText("Where is Eaglesoft running?")).toBeTruthy();
    const host = screen.getByLabelText("Eaglesoft server address");
    fireEvent.change(host, { target: { value: "10.0.1.5" } });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    await screen.findByText(/Found an Eaglesoft database at/);
    expect(testLanConnection).toHaveBeenCalledWith("eaglesoft", {
      host: "10.0.1.5",
      port: 2638,
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Step 2 — provision the read-only account.
    expect(screen.getByText("Create Droplet’s database account")).toBeTruthy();
    expect(screen.getByText("droplet_ro")).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy setup script/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /I have Eaglesoft admin access/ }));
    fireEvent.click(screen.getByRole("button", { name: /verify account/i }));

    // Step 3 — scopes, five of them, plus the write opt-in that is off.
    expect(screen.getByText("What should Droplet read?")).toBeTruthy();
    for (const label of [
      "Schedule & appointments",
      "Patients & contact info",
      "Providers & chairs",
      "Production & accounts receivable",
      "Recall / recare",
    ]) {
      expect(screen.getByText(label), label).toBeTruthy();
    }
    const writeToggle = screen.getByLabelText(
      "Let Droplet schedule appointments back into Eaglesoft",
    ) as HTMLInputElement;
    expect(writeToggle.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Step 4 — confirm, with the facts the descriptor declares.
    expect(screen.getByText("Confirm and connect")).toBeTruthy();
    expect(screen.getByText("10.0.1.5:2638")).toBeTruthy();
    expect(screen.getByText("PattersonPM")).toBeTruthy();
    expect(screen.getByText("5 of 5 data types")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect Eaglesoft" }));

    await screen.findByText("Connected");
    expect(connectLanProvider).toHaveBeenCalledWith("eaglesoft", {
      host: "10.0.1.5",
      port: 2638,
      scopes: ["schedule", "patients", "providers", "financials", "recall"],
      enableWrites: false,
    });
  });

  /**
   * The LAN flow never asks the credential question, and the credential flow
   * never asks the LAN one. Stated as its own test because the two failures
   * are symmetric and only one of them was ever visible.
   *
   * Mutation: render both flows' fields → red.
   */
  it("shows no credential-paste field", () => {
    vi.mocked(testLanConnection).mockResolvedValue({ reachable: true });
    renderWizard("eaglesoft");

    expect(screen.queryByText("Paste the value")).toBeNull();
    expect(inputs().every((i) => i.type !== "password")).toBe(true);
  });

  /**
   * The scope ids the wizard posts ARE the `ErpScope` vocabulary the connect
   * endpoint accepts. The descriptor lives in `@droplet/shared-types`, which
   * cannot import the dashboard's union, so the correspondence is PINNED here
   * rather than asserted by a cast — "types can lie" is the wave-1 lesson.
   *
   * Mutation: rename any scope id in the descriptor → red.
   */
  it("offers exactly the scopes the connect endpoint accepts", () => {
    // Typed as `ErpScope[]`, so renaming a member of the union without
    // renaming it in the descriptor is a `tsc` error here as well as a runtime
    // failure below.
    const expected: ErpScope[] = [
      "schedule",
      "patients",
      "providers",
      "financials",
      "recall",
    ];
    const declared = providerDescriptor("eaglesoft")?.lanProvisioning?.scopes ?? [];
    expect(declared.map((s) => s.id)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Extension seam + the setup guide (WARP-2342)
// ---------------------------------------------------------------------------

describe("the wizard is closed to vendors and open to descriptors", () => {
  /**
   * The AC's grep, as a test. WARP-2291 achieved this for `page.tsx`; the
   * wizard is the surface underneath it.
   *
   * Mutation: re-introduce any vendor id or vendor-specific copy → red.
   */
  it("names no provider id", () => {
    const source = readSource("src/components/integrations/ConnectWizard.tsx");
    for (const id of ["eaglesoft", "dentrix", "quickbooks", "opendental", "stripe"]) {
      expect(source.toLowerCase(), `ConnectWizard.tsx names "${id}"`).not.toContain(id);
    }
  });

  /**
   * The extension seam WARP-2466 depends on: a descriptor registered at
   * runtime renders with NO change to this component. Registering it inside
   * the test is what makes that claim falsifiable.
   *
   * Mutation: resolve fields from a hand-kept map instead of the registry →
   * red, because a fixture provider is in no such map.
   */
  it("renders a provider it has never heard of, from its descriptor alone", async () => {
    expect(screen.queryByText("Fixture Payments")).toBeNull();
    registerProviderDescriptor(PASTE_ONLY);
    renderWizard("fixture-paste");

    await screen.findByText("Restricted API key *");
    expect(screen.getByRole("button", { name: "Connect Fixture Payments" })).toBeTruthy();
  });

  /**
   * A tile the dashboard has no descriptor for says so, rather than opening an
   * empty dialog with a live-looking button.
   *
   * Mutation: render the credential flow with an empty field list → red.
   */
  it("says so when it cannot resolve a descriptor", () => {
    renderWizard("nobody-wrote-this-one");
    expect(screen.getByText(/can’t be set up here yet/)).toBeTruthy();
  });

  /**
   * WARP-2342 — the guide is reachable at the moment of use, and it is the
   * provider's own guide.
   *
   * Mutation: hardcode one href (or read it from the first descriptor) → red,
   * because the two providers below must resolve to two different documents.
   */
  it("links each provider to its OWN setup guide", async () => {
    registerProviderDescriptor(PASTE_ONLY);
    registerProviderDescriptor(PAIR);

    const first = renderWizard("fixture-paste");
    await screen.findByText("Restricted API key *");
    const a = screen.getByTestId("setup-guide-link").getAttribute("href");
    first.unmount();

    renderWizard("fixture-pair");
    await screen.findByText("Client ID *");
    const b = screen.getByTestId("setup-guide-link").getAttribute("href");

    expect(a).toBe("/docs/integrations/fixture-paste");
    expect(b).toBe("/docs/integrations/fixture-pair");
    expect(a).not.toBe(b);
  });

  /**
   * A provider with no guide gets no link — better than a link to nowhere.
   *
   * Mutation: always render the anchor → red.
   */
  it("renders no guide link for a provider that declares none", () => {
    vi.mocked(testLanConnection).mockResolvedValue({ reachable: true });
    renderWizard("eaglesoft");
    expect(screen.queryByTestId("setup-guide-link")).toBeNull();
  });
});
