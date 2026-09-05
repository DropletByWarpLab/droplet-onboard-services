/**
 * WARP-2731 (ADR-048) — "Stop filing things here", on the customer record.
 *
 * Two properties, and both are about what this control CANNOT do.
 *
 * 🔴 It writes NOT_SAME and nothing else. `ALWAYS_HERE` is the strongest thing
 * in this feature — it forces every future document matching a key onto one
 * customer, ahead of the matcher's own search — and it must not be reachable
 * from a one-click chip on a drawer. Telling Droplet where something does NOT
 * go is a correction; telling it where something DOES go is a decision, and
 * only the first belongs here.
 *
 * 🔴 It is not rendered for a reader who could not use it. A control that
 * exists to say no is worse than no control: it teaches the person that the
 * feature is broken rather than that it is not theirs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const authFetchMock = vi.hoisted(() => vi.fn());
const useAuthMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ authFetch: authFetchMock, useAuth: useAuthMock }));

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import { StopFilingHere } from "./StopFilingHere";

const COMPANY = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  authFetchMock.mockReset();
  authFetchMock.mockResolvedValue({ ok: true, json: async () => ({ rule: {} }) });
  toastMock.mockReset();
  useAuthMock.mockReturnValue({ user: { role: "owner" } });
});

describe("🔴 the correction it writes", () => {
  it("MUTATION: send a verdict — a one-click chip could mint ALWAYS_HERE", async () => {
    render(<StopFilingHere companyId={COMPANY} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop filing things here" }));
    fireEvent.change(screen.getByLabelText(/stop filing here/i), {
      target: { value: "acme-dental.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalled());
    const body = JSON.parse(authFetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({
      keyKind: "EMAIL_DOMAIN",
      keyValue: "acme-dental.example",
      companyId: COMPANY,
    });
    // The route refuses a body carrying `verdict`; the client must not send
    // one either, so the two halves of the rule agree.
    expect(body).not.toHaveProperty("verdict");
  });

  it("reads an address as an address and a domain as a domain", async () => {
    render(<StopFilingHere companyId={COMPANY} suggestion="@Acme-Dental.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Stop filing things here" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalled());
    // The leading `@` is stripped and the value lowercased, so the key matches
    // what the matcher looks up rather than what the owner happened to type.
    expect(JSON.parse(authFetchMock.mock.calls[0][1].body as string)).toMatchObject({
      keyKind: "EMAIL_DOMAIN",
      keyValue: "acme-dental.example",
    });
  });

  it("sends an address when one is typed", async () => {
    render(<StopFilingHere companyId={COMPANY} suggestion="Someone@Acme.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Stop filing things here" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalled());
    expect(JSON.parse(authFetchMock.mock.calls[0][1].body as string)).toMatchObject({
      keyKind: "EMAIL_ADDRESS",
      keyValue: "someone@acme.example",
    });
  });

  it("says the customer itself is left alone", async () => {
    render(<StopFilingHere companyId={COMPANY} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop filing things here" }));
    // The reassurance is the point: an owner who thinks this might delete the
    // customer will not click it.
    expect(screen.getByText(/keep this customer exactly as it is/i)).toBeTruthy();
  });
});

describe("🔴 it is not shown to someone who could not use it", () => {
  it("MUTATION: render for family — a control that exists to say no", () => {
    useAuthMock.mockReturnValue({ user: { role: "family" } });
    const { container } = render(<StopFilingHere companyId={COMPANY} />);
    expect(container.textContent).toBe("");
  });

  it("is shown to an admin", () => {
    useAuthMock.mockReturnValue({ user: { role: "admin" } });
    render(<StopFilingHere companyId={COMPANY} />);
    expect(screen.getByRole("button", { name: "Stop filing things here" })).toBeTruthy();
  });
});
