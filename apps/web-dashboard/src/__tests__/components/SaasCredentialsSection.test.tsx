/**
 * WARP-2289 — the descriptor-driven credential configurator.
 *
 * The two claims worth the most here:
 *
 *  1. **The admin gate precedes the fetch effects.** Asserting "renders
 *     nothing" alone is not enough: a gate placed *after* the effects renders
 *     exactly the same nothing while having already issued an admin-only
 *     request. So both are asserted, and only the second one catches that
 *     ordering bug.
 *  2. **The form is generic.** Two structurally different providers are
 *     rendered from their descriptors by ONE component, with no vendor branch
 *     between them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { useAuthMock } = vi.hoisted(() => ({ useAuthMock: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => useAuthMock() }));

const { fetchSaasCredentialsMock, saveSaasCredentialMock } = vi.hoisted(() => ({
  fetchSaasCredentialsMock: vi.fn(),
  saveSaasCredentialMock: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  fetchSaasCredentials: fetchSaasCredentialsMock,
  saveSaasCredential: saveSaasCredentialMock,
}));

// WARP-2518 — the page now carries a Disconnect control, and the control makes
// the call itself. Stubbed at the module boundary like every other API here.
const { disconnectProviderMock } = vi.hoisted(() => ({ disconnectProviderMock: vi.fn() }));
vi.mock("@/lib/api.erp", () => ({ disconnectProvider: disconnectProviderMock }));

import {
  SaasCredentialsSection,
  stateCopyFor,
} from "@/components/integrations/SaasCredentialsSection";
import { statusView } from "@/components/integrations/connector-visuals";
import {
  CREDENTIAL_PURGED_LINE,
  CREDENTIAL_RETAINED_LINE,
} from "@/lib/credential-purge";
import type { IntegrationStatus } from "@/lib/erp-types";
import type { SaasConnectionState, SaasCredentialView } from "@/lib/api";

/** Two providers with deliberately different field sets — the generic claim is
 *  only meaningful if they do not look alike. */
const BILLING: SaasCredentialView = {
  provider: "fixture-billing",
  displayName: "Fixture Billing",
  category: "Accounting",
  state: "CONNECTED",
  hasCredentials: true,
  configured: true,
  fields: [
    {
      name: "accountId",
      label: "Account id",
      type: "string",
      required: true,
      secret: false,
      storage: "providerConfig",
      help: "Found in the vendor console.",
      pattern: null,
      hasValue: null,
    },
    {
      name: "apiKey",
      label: "Restricted API key",
      type: "string",
      required: true,
      secret: true,
      storage: "encrypted",
      help: null,
      pattern: "^rk_(live|test)_",
      hasValue: true,
    },
  ],
  values: { accountId: "acct-1" },
  updatedAt: "2026-08-27T00:00:00.000Z",
};

const CRM: SaasCredentialView = {
  provider: "fixture-crm",
  displayName: "Fixture CRM",
  category: "CRM",
  state: "NOT_CONFIGURED",
  hasCredentials: false,
  configured: false,
  fields: [
    {
      name: "privateToken",
      label: "Private app token",
      type: "string",
      required: true,
      secret: true,
      storage: "encrypted",
      help: null,
      pattern: null,
      hasValue: false,
    },
  ],
  values: {},
  updatedAt: null,
};

function setRole(role: string | null) {
  useAuthMock.mockReturnValue({ user: role ? { id: "u1", role } : null });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSaasCredentialsMock.mockResolvedValue([BILLING, CRM]);
  saveSaasCredentialMock.mockResolvedValue(BILLING);
  disconnectProviderMock.mockResolvedValue({});
});

describe("the admin gate", () => {
  it("renders nothing for a family user AND issues no fetch", async () => {
    setRole("family");
    const { container } = render(<SaasCredentialsSection />);

    expect(container).toBeEmptyDOMElement();
    // Mutation: move `if (!isAdmin) return null` below the effects — i.e.
    // inline the panel into the gated component — and the null assertion above
    // still passes while THIS one goes red. That asymmetry is exactly why both
    // are asserted.
    await waitFor(() => {
      expect(fetchSaasCredentialsMock).not.toHaveBeenCalled();
    });
  });

  it("renders nothing for a guest, and nothing for a signed-out visitor", () => {
    setRole("guest");
    expect(render(<SaasCredentialsSection />).container).toBeEmptyDOMElement();
    setRole(null);
    expect(render(<SaasCredentialsSection />).container).toBeEmptyDOMElement();
    expect(fetchSaasCredentialsMock).not.toHaveBeenCalled();
  });

  it("renders and fetches for an owner and for an admin", async () => {
    setRole("owner");
    render(<SaasCredentialsSection />);
    await waitFor(() => expect(fetchSaasCredentialsMock).toHaveBeenCalledTimes(1));

    vi.clearAllMocks();
    fetchSaasCredentialsMock.mockResolvedValue([BILLING]);
    setRole("admin");
    render(<SaasCredentialsSection />);
    await waitFor(() => expect(fetchSaasCredentialsMock).toHaveBeenCalledTimes(1));
  });
});

describe("descriptor-driven rendering", () => {
  it("renders two different providers' fields from their descriptors alone", async () => {
    setRole("owner");
    render(<SaasCredentialsSection />);

    // One component, two structurally different providers, no branch between.
    expect(await screen.findByLabelText(/Account id/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Restricted API key/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Private app token/)).toBeInTheDocument();
    expect(screen.getByText("Fixture Billing")).toBeInTheDocument();
    expect(screen.getByText("Fixture CRM")).toBeInTheDocument();
  });

  it("renders secret fields as password inputs and non-secrets as text", async () => {
    setRole("owner");
    render(<SaasCredentialsSection />);

    expect(await screen.findByLabelText(/Restricted API key/)).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByLabelText(/Account id/)).toHaveAttribute("type", "text");
  });

  it("drives the secret placeholder off hasValue, not off a vendor rule", async () => {
    setRole("owner");
    render(<SaasCredentialsSection />);

    // hasValue: true — an admin can see one is set without it being sent here.
    expect(await screen.findByLabelText(/Restricted API key/)).toHaveAttribute(
      "placeholder",
      "Saved — replace to change",
    );
    // hasValue: false — nothing stored yet.
    expect(screen.getByLabelText(/Private app token/)).toHaveAttribute(
      "placeholder",
      "Paste the value",
    );
  });

  it("pre-fills non-secret values and never a secret", async () => {
    setRole("owner");
    render(<SaasCredentialsSection />);

    expect(await screen.findByLabelText(/Account id/)).toHaveValue("acct-1");
    expect(screen.getByLabelText(/Restricted API key/)).toHaveValue("");
  });

  it("renders the descriptor's help text", async () => {
    setRole("owner");
    render(<SaasCredentialsSection />);
    expect(await screen.findByText("Found in the vendor console.")).toBeInTheDocument();
  });
});

describe("connection state honesty", () => {
  it("tells a rejected credential apart from an absent one", async () => {
    setRole("owner");
    fetchSaasCredentialsMock.mockResolvedValue([
      { ...BILLING, state: "NEEDS_RECONNECT" as const },
      CRM,
    ]);
    render(<SaasCredentialsSection />);

    // Not "Not connected" — the admin already pasted something, and being told
    // to connect again is what leaves a broken connection broken.
    expect(await screen.findByText(/Credential rejected/)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  /**
   * WARP-2517 — a persisted `ERROR` row must render, not crash.
   *
   * The box's own union has carried `ERROR` since WARP-2458 (the service
   * folds status `ERROR` straight through), but the dashboard's mirror union
   * lacked the member, so `STATE_COPY[view.state]` was `undefined` and the
   * first `.label` threw — the one page for repairing a broken connection
   * was the page a broken connection took down.
   */
  it("renders a persisted ERROR row instead of crashing on it", async () => {
    setRole("owner");
    fetchSaasCredentialsMock.mockResolvedValue([
      { ...BILLING, state: "ERROR" as const },
      CRM,
    ]);
    render(<SaasCredentialsSection />);

    // Distinct from NEEDS_RECONNECT on purpose: ERROR is the state a NEW KEY
    // WILL NOT FIX (a vendor-side refusal — an IP access policy, a plan
    // limit), so the copy must not send the admin off to mint another one.
    expect(await screen.findByText(/Can't connect/)).toBeInTheDocument();
    expect(screen.queryByText(/Credential rejected/)).not.toBeInTheDocument();
  });

  /**
   * WARP-2623 — a capability-limited row is a WORKING connection.
   *
   * The four capability codes (Mailchimp's `CAPABILITY_MISSING`, HubSpot's
   * `CAPABILITY_NOT_AVAILABLE`, Shopify's `SCOPE_MISSING` and
   * `PROTECTED_CUSTOMER_DATA_DENIED`) all persisted as `ERROR`, so a Basic-plan
   * Shopify store reading orders, products and inventory perfectly rendered
   * here as "Can't connect — check the vendor's settings". This is the page an
   * owner lands on to REPAIR a connection, and there was nothing on it to
   * repair: the credential is valid and stored.
   */
  it("renders a capability-limited row as connected, with no reconnect prompt", async () => {
    setRole("owner");
    fetchSaasCredentialsMock.mockResolvedValue([
      { ...BILLING, state: "CAPABILITY_LIMITED" as const },
      CRM,
    ]);
    render(<SaasCredentialsSection />);

    // Mutation: delete the CAPABILITY_LIMITED row from `STATE_COPY` → `tsc`
    // red (the Record is total) AND this red at runtime, because
    // `STATE_COPY[view.state]` is `undefined` and `.label` throws.
    const line = await screen.findByText(/Connected · limited/);
    expect(line).toBeInTheDocument();

    // The remediation names where the fix actually is. Mutation: drop the
    // second half of the label → red, and the owner is told a dataset is
    // missing with nowhere to go about it.
    expect(line.textContent).toMatch(/plan or permission change/i);

    // NO reconnect affordance — the whole point. A new key changes nothing,
    // and both of the neighbouring states' copy sends the admin after one.
    // Mutation: reuse NEEDS_RECONNECT's or ERROR's copy here → red.
    const card = screen.getByTestId(`provider-${BILLING.provider}`);
    expect(card.textContent).not.toMatch(/Credential rejected/);
    expect(card.textContent).not.toMatch(/replace it/);
    expect(card.textContent).not.toMatch(/Can't connect/);
  });

  /**
   * WARP-2483 — the same two disconnected states the hub tile shows.
   *
   * ADR-041 §2 promises that disconnecting removes the key. `DISABLED` alone
   * used to render as a flat "Turned off", which is true of both a connection
   * whose credential was destroyed and one whose credential is still sitting
   * in Postgres — and those are opposite facts to the admin standing on the
   * one page in the product where credentials are handed over.
   *
   * The presence half is `credentialsPurged` — the box's own answer, derived
   * there from the status enum and both credential columns, and the same field
   * the hub tile reads. WARP-2489 corrected it: it used to be
   * `!hasCredentials`, which asks whether the connection is USABLE, not
   * whether the key was removed. No value, prefix or length is added to the
   * payload to support this rendering, and none could be: the view type has
   * nowhere to put one.
   */
  describe("a disconnected connector says whether the credential was removed", () => {
    /**
     * `purged` is the box's answer; the other two fields follow from it the
     * way a real payload's do. `CRM` declares ONE secret, so here — and only
     * here — "no credential stored" and "the credential was purged" coincide.
     * That coincidence is what made `!hasCredentials` look right; see the
     * two-secret fixture below, where they come apart.
     */
    const OFF = (purged: boolean): SaasCredentialView => ({
      ...CRM,
      provider: "fixture-off",
      displayName: "Fixture Off",
      state: "DISABLED",
      hasCredentials: !purged,
      credentialsPurged: purged,
      configured: true,
      fields: [{ ...CRM.fields[0], hasValue: !purged }],
    });

    async function stateLine(purged: boolean): Promise<string> {
      vi.clearAllMocks();
      setRole("owner");
      fetchSaasCredentialsMock.mockResolvedValue([OFF(purged)]);
      const { unmount } = render(<SaasCredentialsSection />);
      const card = await screen.findByTestId("provider-fixture-off");
      const text = card.textContent ?? "";
      unmount();
      return text;
    }

    /** Mutation: keep `STATE_COPY.DISABLED`'s "Turned off" → red. */
    it("says the credential is gone when the box says it purged it", async () => {
      const text = await stateLine(true);
      expect(text).toContain("Disconnected · credential removed");
      expect(text).not.toContain("Turned off");
    });

    /**
     * The honest one. Mutation: render the purged sentence for both → red,
     * and the admin is told a key was destroyed while it is still decryptable
     * on the row.
     */
    it("admits the credential is still stored when it is", async () => {
      const text = await stateLine(false);
      expect(text).toContain(
        "Disconnected · credential still stored — reconnect or remove",
      );
    });

    /** THE mutation: ignore the flag → both renders identical → red. */
    it("does not render the two states identically", async () => {
      expect(await stateLine(true)).not.toEqual(await stateLine(false));
    });

    /**
     * WARP-2489 — the fixture that would have caught the defect.
     *
     * Every case above uses `CRM`, which declares ONE secret. There,
     * `!hasCredentials` and "the blob is gone" are the same bit, so reading the
     * first as the answer to the second was green over a real defect.
     *
     * `hasCredentials` is an `every()` over the DECLARED secrets. A provider
     * declaring two with one stored reports `false` while that one is still
     * sealed on the row — and the page told the admin the key had been
     * destroyed. The box is the only thing that knows; it now says so in
     * `credentialsPurged`, and the page renders that.
     */
    const TWO_SECRETS_ONE_STORED: SaasCredentialView = {
      ...CRM,
      provider: "fixture-partial",
      displayName: "Fixture Partial",
      state: "DISABLED",
      // Two declared secrets, one of them stored: `every()` says false…
      hasCredentials: false,
      // …and the box, reading the row, says the credential is still there.
      credentialsPurged: false,
      configured: true,
      fields: [
        { ...CRM.fields[0], name: "apiKey", label: "Restricted API key", hasValue: true },
        {
          ...CRM.fields[0],
          name: "webhookSecret",
          label: "Webhook signing secret",
          required: false,
          hasValue: false,
        },
      ],
    };

    async function cardText(view: SaasCredentialView): Promise<string> {
      vi.clearAllMocks();
      setRole("owner");
      fetchSaasCredentialsMock.mockResolvedValue([view]);
      const { unmount } = render(<SaasCredentialsSection />);
      const card = await screen.findByTestId(`provider-${view.provider}`);
      const text = card.textContent ?? "";
      unmount();
      return text;
    }

    /**
     * Mutation: `stateCopyFor` reading `!view.hasCredentials` again → the page
     * says "credential removed" about a key Postgres can still open → red.
     * This is the exact row on which the old suite's one-secret fixture and
     * this two-secret one disagree.
     */
    it("does not claim a purge when one of two declared secrets is still stored", async () => {
      const text = await cardText(TWO_SECRETS_ONE_STORED);
      expect(text).toContain(CREDENTIAL_RETAINED_LINE);
      expect(text).not.toContain(CREDENTIAL_PURGED_LINE);
    });

    /**
     * The third case, which `!hasCredentials` could never reach: that
     * expression is always a boolean, so the page ALWAYS claimed one of the two
     * sentences, including against a box too old to have an opinion. Reading
     * the box's own optional field restores the refusal.
     *
     * Mutation: `view.credentialsPurged ?? !view.hasCredentials` → the page
     * invents "credential removed" for a payload that never said so → red.
     */
    it("claims neither sentence when the box sent no purge fact", async () => {
      const text = await cardText({
        ...TWO_SECRETS_ONE_STORED,
        provider: "fixture-silent",
        credentialsPurged: undefined,
      });
      expect(text).not.toContain(CREDENTIAL_PURGED_LINE);
      expect(text).not.toContain(CREDENTIAL_RETAINED_LINE);
      expect(text).toContain("Turned off");
    });

    /**
     * …and `hasX` stays the ONLY secret-presence signal. The still-stored
     * state is exactly where a surface is tempted to prove itself by showing
     * something of the credential; the input is still empty and still driven
     * by the placeholder alone.
     *
     * Mutation: pre-fill a secret input from anything → red.
     */
    it("adds no new secret-presence signal to the still-stored state", async () => {
      vi.clearAllMocks();
      setRole("owner");
      // Not purged — the key IS still on the row, which is the state a surface
      // is most tempted to prove by showing something of it.
      fetchSaasCredentialsMock.mockResolvedValue([OFF(false)]);
      render(<SaasCredentialsSection />);

      const input = await screen.findByLabelText(/Private app token/);
      expect(input).toHaveAttribute("type", "password");
      expect(input).toHaveValue("");
      expect(input).toHaveAttribute("placeholder", "Saved — replace to change");
    });
  });
});

/**
 * WARP-2489 — the hub tile and the credentials page must make the SAME claim
 * about the same row.
 *
 * They render from two different payloads (`IntegrationConnection` and
 * `SaasCredentialView`) through two different copy functions, and until now
 * they answered "was the credential removed" from two different facts: the hub
 * from the box's `credentialsPurged`, the page from `!hasCredentials`. Those
 * agree on every one-secret provider and diverge the moment a provider declares
 * two — which is how an owner could read "credential removed" on one page of
 * this product and "credential still stored" on another.
 *
 * The table is driven over (status × stored-secret count) because the count is
 * the axis the defect lives on and the axis every prior fixture pinned at
 * "all or nothing".
 */
describe("hub and credentials page agree about the credential", () => {
  const STATUSES: IntegrationStatus[] = [
    "NOT_CONFIGURED",
    "PROVISIONING",
    "CONNECTED",
    "CAPABILITY_LIMITED",
    "DEGRADED",
    "DRIFT_LOCKED",
    "NEEDS_RECONNECT",
    "ERROR",
    "DISABLED",
  ];

  /** Of TWO declared secret fields. `1` is the row no earlier fixture had. */
  const SECRETS_STORED = [0, 1, 2] as const;

  /**
   * Fixture data, not the thing under test: the correspondence
   * `saas-credential.service.ts`'s `saasConnectionState` produces, so the views
   * fed to `stateCopyFor` are the ones the box actually emits. Keyed by
   * `IntegrationStatus`, so a new status is a compile error rather than a row
   * that silently goes untested.
   */
  const WITH_CREDENTIAL: Record<IntegrationStatus, SaasConnectionState> = {
    NOT_CONFIGURED: "PROVISIONING",
    PROVISIONING: "PROVISIONING",
    CONNECTED: "CONNECTED",
    // WARP-2623 — folded straight through, like ERROR and NEEDS_RECONNECT.
    CAPABILITY_LIMITED: "CAPABILITY_LIMITED",
    DEGRADED: "DEGRADED",
    DRIFT_LOCKED: "DRIFT_LOCKED",
    NEEDS_RECONNECT: "NEEDS_RECONNECT",
    // Honest since WARP-2517 gave the dashboard union the `ERROR` member the
    // service has folded straight through since WARP-2458. This line was
    // deliberately KNOWN-STALE ("NEEDS_RECONNECT") until then, because
    // correcting it ahead of the union crashed the suite on the missing
    // `STATE_COPY` entry — the same crash a real persisted-ERROR row caused.
    ERROR: "ERROR",
    DISABLED: "DISABLED",
  };

  function pageState(status: IntegrationStatus, hasCredentials: boolean): SaasConnectionState {
    // Same order the service uses: DISABLED wins, then "no credential".
    if (status === "DISABLED") return "DISABLED";
    if (!hasCredentials) return "NOT_CONFIGURED";
    return WITH_CREDENTIAL[status];
  }

  type PurgeClaim = "removed" | "still-stored" | "none";

  /** What a rendered line asserts about the credential, in three values. */
  function claimIn(line: string | undefined): PurgeClaim {
    if (line === CREDENTIAL_PURGED_LINE) return "removed";
    if (line === CREDENTIAL_RETAINED_LINE) return "still-stored";
    return "none";
  }

  const rows = STATUSES.flatMap((status) =>
    SECRETS_STORED.map((stored) => {
      const hasCredentials = stored === 2;
      // What the box derives: explicitly DISABLED and no credential blob left.
      const credentialsPurged = status === "DISABLED" && stored === 0;
      const view: SaasCredentialView = {
        ...CRM,
        provider: `fixture-${status}-${stored}`,
        state: pageState(status, hasCredentials),
        hasCredentials,
        credentialsPurged,
        configured: status !== "NOT_CONFIGURED",
      };
      return {
        status,
        stored,
        hub: claimIn(statusView(status, credentialsPurged).detail),
        page: claimIn(stateCopyFor(view).label),
      };
    }),
  );

  /**
   * Mutation: `stateCopyFor` back to `!view.hasCredentials` → the
   * (DISABLED, 1) row alone disagrees — hub "still-stored", page "removed" —
   * and the assertion names it. Every other row in the table stays green,
   * which is exactly how the defect passed review.
   */
  it("makes the same claim on every (status × stored-secret count) pair", () => {
    expect(rows.filter((r) => r.page !== r.hub)).toEqual([]);
  });

  /**
   * Non-vacuity. Two functions that both said nothing would agree perfectly,
   * so the table has to be shown to exercise all three claims before its
   * agreement means anything.
   */
  it("actually exercises all three claims", () => {
    expect(new Set(rows.map((r) => r.hub))).toEqual(
      new Set<PurgeClaim>(["none", "removed", "still-stored"]),
    );
    expect(new Set(rows.map((r) => r.page))).toEqual(
      new Set<PurgeClaim>(["none", "removed", "still-stored"]),
    );
  });

  /** Only a disconnected connection may claim anything about the credential. */
  it("claims nothing about the credential unless the connection is disconnected", () => {
    const live = rows.filter((r) => r.status !== "DISABLED");
    expect(live.map((r) => r.page)).toEqual(live.map(() => "none"));
  });
});

describe("the three-way rule, client half", () => {
  it("OMITS an untouched secret rather than sending an empty string", async () => {
    setRole("owner");
    render(<SaasCredentialsSection />);
    await screen.findByLabelText(/Account id/);

    fireEvent.change(screen.getByLabelText(/Account id/), {
      target: { value: "acct-2" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /Save/ })[0]);

    await waitFor(() => expect(saveSaasCredentialMock).toHaveBeenCalled());
    const [, fields] = saveSaasCredentialMock.mock.calls[0];
    // Sending "" here would clear a working credential belonging to an admin
    // who only came to fix a typo in the account id.
    expect(fields).not.toHaveProperty("apiKey");
    expect(fields.accountId).toBe("acct-2");
  });

  it("sends a secret the admin actually typed", async () => {
    setRole("owner");
    render(<SaasCredentialsSection />);
    await screen.findByLabelText(/Restricted API key/);

    fireEvent.change(screen.getByLabelText(/Restricted API key/), {
      target: { value: "rk_live_new" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /Save/ })[0]);

    await waitFor(() => expect(saveSaasCredentialMock).toHaveBeenCalled());
    expect(saveSaasCredentialMock.mock.calls[0][1].apiKey).toBe("rk_live_new");
  });

  it("clears the typed secret from the form once it is saved", async () => {
    setRole("owner");
    render(<SaasCredentialsSection />);
    await screen.findByLabelText(/Restricted API key/);

    fireEvent.change(screen.getByLabelText(/Restricted API key/), {
      target: { value: "rk_live_new" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /Save/ })[0]);

    // The saved view replaces the old one, so the input remounts empty — the
    // typed key does not linger in the DOM after the round trip.
    await waitFor(() =>
      expect(screen.getByLabelText(/Restricted API key/)).toHaveValue(""),
    );
  });
});

describe("the Status union", () => {
  it("shows an error WITHOUT losing what the admin typed", async () => {
    setRole("owner");
    saveSaasCredentialMock.mockRejectedValue(new Error("Restricted API key is not in the expected format."));
    render(<SaasCredentialsSection />);
    await screen.findByLabelText(/Restricted API key/);

    fireEvent.change(screen.getByLabelText(/Restricted API key/), {
      target: { value: "sk_live_wrong" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /Save/ })[0]);

    // Mutation: collapse `Status` to a `loading: boolean` and the error variant
    // has nowhere to live — this goes red.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /not in the expected format/,
    );
    // Never lose edits on a failure.
    expect(screen.getByLabelText(/Restricted API key/)).toHaveValue("sk_live_wrong");
    // And "saved" must not be showing at the same time.
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("reports a failed load explicitly rather than as an empty list", async () => {
    setRole("owner");
    fetchSaasCredentialsMock.mockRejectedValue(new Error("boom"));
    render(<SaasCredentialsSection />);

    // An empty list standing in for a broken load is the dishonesty this whole
    // surface exists to prevent.
    expect(await screen.findByText(/Couldn’t load the connector list/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// WARP-2518 — Disconnect on the credentials page
// ---------------------------------------------------------------------------

/**
 * This is the one surface in the product where a person hands over a
 * credential, which makes it the surface that most owes them a way to take it
 * back. Before this it had none: an admin could paste a key here and could
 * only remove it by calling the API.
 *
 * The `offersDisconnect` rule is asserted through the DOM rather than as a
 * pure-function unit, because the defect being prevented is a *rendered*
 * control appearing on the wrong card.
 */
describe("disconnecting a configured provider", () => {
  const disconnectFor = (name: string) =>
    screen.queryByRole("button", { name: `Disconnect ${name}` });

  /**
   * Mutation: drop the `<DisconnectControl>` block from `ProviderForm` → red,
   * which is the shipped state.
   */
  it("offers Disconnect on a configured provider", async () => {
    setRole("admin");
    render(<SaasCredentialsSection />);
    await screen.findByTestId("provider-fixture-billing");

    expect(disconnectFor("Fixture Billing")).not.toBeNull();
  });

  /**
   * …and not on one that was never configured. `fixture-crm` is
   * `NOT_CONFIGURED`, so there is no credential for the button to purge.
   *
   * Mutation: make `offersDisconnect` return `true` unconditionally → red.
   */
  it("does not offer it for a provider that was never configured", async () => {
    setRole("owner");
    render(<SaasCredentialsSection />);
    await screen.findByTestId("provider-fixture-crm");

    expect(disconnectFor("Fixture CRM")).toBeNull();
  });

  /**
   * The rule is NOT `hasCredentials`.
   *
   * `hasCredentials` is an `every()` over the DECLARED secret fields, so a
   * provider declaring two with one stored answers `false` while a live key
   * sits sealed on the row — the exact question WARP-2489 proved is the wrong
   * one for the state line. Gating the button that PURGES the key by it would
   * bring that confusion straight back, and in the direction where the admin
   * cannot remove a credential the box is still holding.
   *
   * Mutation: gate on `view.hasCredentials` → red, because this CONNECTED row
   * reports `false` and loses its Disconnect.
   */
  it("offers it for a connected row whose declared secrets are only partly stored", async () => {
    setRole("admin");
    fetchSaasCredentialsMock.mockResolvedValue([
      { ...BILLING, hasCredentials: false },
    ]);
    render(<SaasCredentialsSection />);
    await screen.findByTestId("provider-fixture-billing");

    expect(disconnectFor("Fixture Billing")).not.toBeNull();
  });

  /**
   * Mutation: drop the `credentialsPurged === true` clause → red, because the
   * card then offers to remove a key it has just told the admin is gone.
   */
  it("does not offer it once the box says the credential is purged", async () => {
    setRole("admin");
    fetchSaasCredentialsMock.mockResolvedValue([
      { ...BILLING, state: "DISABLED" as SaasConnectionState, credentialsPurged: true },
    ]);
    render(<SaasCredentialsSection />);
    await screen.findByTestId("provider-fixture-billing");

    expect(screen.getByText(CREDENTIAL_PURGED_LINE)).toBeTruthy();
    expect(disconnectFor("Fixture Billing")).toBeNull();
  });

  /**
   * …and still offers it when the box says the key is STILL THERE, which is
   * the unfinished state the page's own copy tells the admin to act on.
   *
   * Mutation: exclude every DISABLED row → red, and the card then says
   * "reconnect or remove" while offering neither.
   */
  it("offers it when the box says the credential is still stored", async () => {
    setRole("admin");
    fetchSaasCredentialsMock.mockResolvedValue([
      { ...BILLING, state: "DISABLED" as SaasConnectionState, credentialsPurged: false },
    ]);
    render(<SaasCredentialsSection />);
    await screen.findByTestId("provider-fixture-billing");

    expect(screen.getByText(CREDENTIAL_RETAINED_LINE)).toBeTruthy();
    expect(disconnectFor("Fixture Billing")).not.toBeNull();
  });

  /**
   * The confirmation gate, and the provider actually posted.
   *
   * Mutation: call `disconnectProvider` from the trigger's own `onClick` → red
   * on the first assertion, because one click on the page where credentials
   * live would then destroy one.
   */
  it("confirms first, then posts the provider key", async () => {
    setRole("admin");
    render(<SaasCredentialsSection />);
    await screen.findByTestId("provider-fixture-billing");

    fireEvent.click(disconnectFor("Fixture Billing")!);
    expect(disconnectProviderMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnectProviderMock).toHaveBeenCalledWith("fixture-billing"));
  });

  /**
   * The result arrives by RE-READING, not by mapping the disconnect response
   * onto the row: the two payloads are different shapes and hand-mapping is
   * how the hub and this page would come to disagree about `credentialsPurged`.
   *
   * Mutation: drop `onDisconnected={() => void load()}` from the panel → red,
   * because the card keeps saying "Connected" after a confirmed purge.
   */
  it("re-reads afterwards, so the purge line replaces the connected state", async () => {
    setRole("admin");
    fetchSaasCredentialsMock.mockResolvedValueOnce([BILLING]).mockResolvedValue([
      { ...BILLING, state: "DISABLED" as SaasConnectionState, credentialsPurged: true },
    ]);
    render(<SaasCredentialsSection />);
    await screen.findByTestId("provider-fixture-billing");
    expect(screen.getByText("Connected")).toBeTruthy();

    fireEvent.click(disconnectFor("Fixture Billing")!);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(screen.getByText(CREDENTIAL_PURGED_LINE)).toBeTruthy());
  });

  /**
   * A refusal is surfaced, and carries nothing the server echoed (rule 19).
   *
   * Mutation: replace the control's `catch` body with `{}` → red, because the
   * admin is then shown nothing and believes the credential was removed.
   */
  it("surfaces a refusal without echoing the response body", async () => {
    setRole("admin");
    render(<SaasCredentialsSection />);
    await screen.findByTestId("provider-fixture-billing");
    disconnectProviderMock.mockRejectedValueOnce(
      Object.assign(new Error("rk_live_leaky_message"), {
        code: "CONFLICT",
        body: { key: "rk_live_should_never_render" },
      }),
    );

    fireEvent.click(disconnectFor("Fixture Billing")!);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't disconnect Fixture Billing (CONFLICT)");
    expect(document.body.textContent).not.toContain("rk_live_should_never_render");
    expect(document.body.textContent).not.toContain("rk_live_leaky_message");
  });
});
