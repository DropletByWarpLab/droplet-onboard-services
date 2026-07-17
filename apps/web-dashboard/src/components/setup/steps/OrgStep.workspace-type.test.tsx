/**
 * WARP-1325 — the ADR-007 §2 first-run Home/Business pick on the Org step.
 *
 * Before this, NOTHING in the product ever set `Workspace.type`: the org step
 * wrote the profile fields but not the type, the Phase-4 settings switcher
 * never shipped, and the dashboard re-hydrates the type from the orchestrator
 * on every load — so every install was stuck at the `HOME` default and the
 * Business-gated surfaces (Departments & teams, WARP-1270) were unreachable.
 *
 * These tests pin the wizard-side contract:
 *   - the pick renders as an explicit two-option radiogroup (no preselection —
 *     no-guessing rule: a silent default would strand a business in Home mode);
 *   - Continue without a pick blocks with an inline error and NO network call;
 *   - a made pick rides the org POST as `workspaceType`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OrgStep } from "./OrgStep";

const postOrgMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    postOrg: postOrgMock,
    // The FQDN preview read is best-effort decoration — keep it inert here.
    fetchVpnStatus: vi.fn().mockResolvedValue({ publicFqdn: null }),
  };
});

describe("OrgStep — Home/Business pick (WARP-1325)", () => {
  beforeEach(() => {
    postOrgMock.mockReset();
    postOrgMock.mockResolvedValue({
      ok: true,
      slug: "acme",
      reserved_host: "droplet.local/acme",
      next_step: "internet",
    });
  });

  function fillRequiredFields() {
    fireEvent.change(screen.getByPlaceholderText("Acme HQ"), {
      target: { value: "Acme HQ" },
    });
    fireEvent.change(screen.getByLabelText(/workspace url/i), {
      target: { value: "acme" },
    });
  }

  it("renders an explicit two-option radiogroup with NO preselection", () => {
    render(<OrgStep onComplete={() => {}} />);
    const group = screen.getByRole("radiogroup", { name: /workspace kind/i });
    expect(group).toBeInTheDocument();
    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option).toHaveAttribute("aria-checked", "false");
    }
  });

  it("blocks Continue with an inline error and NO network call until a pick is made", async () => {
    render(<OrgStep onComplete={() => {}} />);
    fillRequiredFields();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText(/choose whether this droplet runs your home or your business/i),
    ).toBeInTheDocument();
    expect(postOrgMock).not.toHaveBeenCalled();
  });

  it("sends workspaceType: business on the org POST and completes", async () => {
    const onComplete = vi.fn();
    render(<OrgStep onComplete={onComplete} />);
    fillRequiredFields();

    fireEvent.click(screen.getByRole("radio", { name: /my business/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(postOrgMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceType: "business" }),
    );
  });

  it("sends workspaceType: home when the household card is picked", async () => {
    const onComplete = vi.fn();
    render(<OrgStep onComplete={onComplete} />);
    fillRequiredFields();

    fireEvent.click(screen.getByRole("radio", { name: /my home/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(postOrgMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceType: "home" }),
    );
  });

  it("clears the pick error as soon as a card is chosen", async () => {
    render(<OrgStep onComplete={() => {}} />);
    fillRequiredFields();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText(/choose whether this droplet runs/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /my home/i }));
    expect(
      screen.queryByText(/choose whether this droplet runs/i),
    ).toBeNull();
  });
});
