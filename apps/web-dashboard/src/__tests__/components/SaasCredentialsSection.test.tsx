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

import { SaasCredentialsSection } from "@/components/integrations/SaasCredentialsSection";
import type { SaasCredentialView } from "@/lib/api";

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
   * WARP-2483 — the same two disconnected states the hub tile shows.
   *
   * ADR-041 §2 promises that disconnecting removes the key. `DISABLED` alone
   * used to render as a flat "Turned off", which is true of both a connection
   * whose credential was destroyed and one whose credential is still sitting
   * in Postgres — and those are opposite facts to the admin standing on the
   * one page in the product where credentials are handed over.
   *
   * The presence half comes from `hasCredentials`, the SAME `hasX` boolean the
   * rest of this surface is built on. No value, prefix or length is added to
   * the payload to support this rendering, and none could be: the view type
   * has nowhere to put one.
   */
  describe("a disconnected connector says whether the credential was removed", () => {
    const OFF = (hasCredentials: boolean): SaasCredentialView => ({
      ...CRM,
      provider: "fixture-off",
      displayName: "Fixture Off",
      state: "DISABLED",
      hasCredentials,
      configured: true,
      fields: [{ ...CRM.fields[0], hasValue: hasCredentials }],
    });

    async function stateLine(hasCredentials: boolean): Promise<string> {
      vi.clearAllMocks();
      setRole("owner");
      fetchSaasCredentialsMock.mockResolvedValue([OFF(hasCredentials)]);
      const { unmount } = render(<SaasCredentialsSection />);
      const card = await screen.findByTestId("provider-fixture-off");
      const text = card.textContent ?? "";
      unmount();
      return text;
    }

    /** Mutation: keep `STATE_COPY.DISABLED`'s "Turned off" → red. */
    it("says the credential is gone when the box holds none", async () => {
      const text = await stateLine(false);
      expect(text).toContain("Disconnected · credential removed");
      expect(text).not.toContain("Turned off");
    });

    /**
     * The honest one. Mutation: render the purged sentence for both → red,
     * and the admin is told a key was destroyed while it is still decryptable
     * on the row.
     */
    it("admits the credential is still stored when it is", async () => {
      const text = await stateLine(true);
      expect(text).toContain(
        "Disconnected · credential still stored — reconnect or remove",
      );
    });

    /** THE mutation: ignore the flag → both renders identical → red. */
    it("does not render the two states identically", async () => {
      expect(await stateLine(false)).not.toEqual(await stateLine(true));
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
      fetchSaasCredentialsMock.mockResolvedValue([OFF(true)]);
      render(<SaasCredentialsSection />);

      const input = await screen.findByLabelText(/Private app token/);
      expect(input).toHaveAttribute("type", "password");
      expect(input).toHaveValue("");
      expect(input).toHaveAttribute("placeholder", "Saved — replace to change");
    });
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
