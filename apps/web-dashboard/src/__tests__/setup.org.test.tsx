/**
 * PR #380 — Org step (onboarding).
 *
 * Validates (per #380 spec + #371 handoff §3 + OnbWizard.jsx WizOrg):
 *   1. Renders the WizOrg surface — "Create your workspace" heading, the
 *      workspace-name field, the URL slug field with the `droplet.local /`
 *      prefix, time zone / industry / company size selects, and the
 *      "nothing is sent off the box" footnote.
 *   2. Org slots AFTER account: creating the account lands on org, not internet.
 *   3. Org is NOT skippable — there is no skip control.
 *   4. A valid submit → POST /api/setup/org → advance to the internet step.
 *   5. A taken slug → inline error on the URL field, stays on org, continue
 *      blocked.
 *   6. An invalid (client-side) slug → inline error, no network call, blocked.
 *   7. A too-large / wrong-type logo → inline error; the logo is OPTIONAL so a
 *      valid submit without a logo still proceeds.
 *
 * Same Vitest + JSDOM + assert-on-DOM-strings pattern as setup.claim.test.tsx;
 * the whole `@/lib/api` surface the wizard imports is mocked, and we walk
 * welcome → claim → account → org via the shared step helpers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

import { claimApiMocks, passClaimStep } from "./helpers/claim-step";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ setupState: undefined }),
}));

const postOrgMock = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    setupAdmin: vi.fn(async () => undefined),
    loginUser: vi.fn(async () => undefined),
    patchSetupStep: vi.fn(async () => undefined),
    ...claimApiMocks(),
    postOrg: (input: unknown) => postOrgMock(input),
    // Internet step (the step AFTER org) renders its form on an unconfigured
    // DuckDNS; keep it quiet so the advance assertion can see it.
    fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
    setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
    fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
    fetchDiscoveredCameras: vi.fn(async () => []),
    fetchVpnStatus: vi.fn(async () => ({
      configured: false,
      endpointConfigured: false,
    })),
    fetchModels: vi.fn(async () => ({ models: [] })),
  };
});

import SetupPage from "@/app/setup/page";

/** Walk welcome → claim → account → org. Fills + submits the account step so
 *  the wizard advances onto org. */
async function advanceToOrg() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  await passClaimStep();
  // Account form.
  fireEvent.change(screen.getByPlaceholderText(/your-username/i), {
    target: { value: "owner" },
  });
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByPlaceholderText(/min\. 8 characters/i), {
    target: { value: "longenoughpw" },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: "longenoughpw" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Fill the required workspace name + slug on the org step. */
function fillOrg({ name = "Acme HQ", slug = "acme" } = {}) {
  fireEvent.change(screen.getByLabelText(/workspace name/i), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText(/workspace url/i), {
    target: { value: slug },
  });
}

describe("setup Org step (PR #380)", () => {
  beforeEach(() => {
    postOrgMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lands on Org after the account step (not internet)", async () => {
    render(<SetupPage />);
    await advanceToOrg();
    expect(screen.getByText(/create your workspace/i)).toBeInTheDocument();
  });

  it("renders the WizOrg surface — name, slug-with-prefix, selects, footnote", async () => {
    render(<SetupPage />);
    await advanceToOrg();

    // Workspace name + URL fields.
    expect(screen.getByLabelText(/workspace name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/workspace url/i)).toBeInTheDocument();
    // The droplet.local / prefix is shown on the URL field. (Exact match — the
    // LearnMoreCard also mentions "droplet.local /your-workspace", so scope to
    // the standalone prefix.)
    expect(screen.getByText("droplet.local /")).toBeInTheDocument();
    // The three selects.
    expect(screen.getByLabelText(/time zone/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/industry/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/company size/i)).toBeInTheDocument();
    // The "nothing off the box" footnote (the privacy guarantee).
    expect(
      screen.getByText(/nothing is sent off the box/i),
    ).toBeInTheDocument();
  });

  it("is NOT skippable — no skip control", async () => {
    render(<SetupPage />);
    await advanceToOrg();
    expect(
      screen.queryByRole("button", { name: /skip/i }),
    ).not.toBeInTheDocument();
  });

  it("submits a valid workspace and advances to the internet step", async () => {
    postOrgMock.mockResolvedValue({
      ok: true,
      slug: "acme",
      reserved_host: "droplet.local/acme",
      next_step: "internet",
    });
    render(<SetupPage />);
    await advanceToOrg();

    fillOrg({ name: "Acme HQ", slug: "acme" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(postOrgMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme HQ", slug: "acme" }),
    );
    // Advanced off org — the heading is gone.
    expect(
      screen.queryByText(/create your workspace/i),
    ).not.toBeInTheDocument();
  });

  it("shows an inline error on a taken slug and stays on org", async () => {
    const { OrgError } = await vi.importActual<typeof import("@/lib/api")>(
      "@/lib/api",
    );
    postOrgMock.mockRejectedValue(
      new OrgError('Workspace URL "acme" is already taken. Pick another.', "ORG_SLUG_TAKEN"),
    );
    render(<SetupPage />);
    await advanceToOrg();

    fillOrg({ name: "Acme HQ", slug: "acme" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/already taken/i)).toBeInTheDocument();
    // Still on org.
    expect(screen.getByText(/create your workspace/i)).toBeInTheDocument();
  });

  it("blocks an invalid slug client-side without calling the API", async () => {
    render(<SetupPage />);
    await advanceToOrg();

    // Spaces + punctuation are not a legal slug.
    fillOrg({ name: "Acme HQ", slug: "Acme HQ!" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
      await Promise.resolve();
    });

    // Inline validation error, no network call, still on org.
    expect(postOrgMock).not.toHaveBeenCalled();
    expect(screen.getByText(/lowercase letters, numbers/i)).toBeInTheDocument();
    expect(screen.getByText(/create your workspace/i)).toBeInTheDocument();
  });

  it("blocks continue when the workspace name is empty", async () => {
    render(<SetupPage />);
    await advanceToOrg();

    // Only a slug, no name.
    fireEvent.change(screen.getByLabelText(/workspace url/i), {
      target: { value: "acme" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
      await Promise.resolve();
    });
    expect(postOrgMock).not.toHaveBeenCalled();
    expect(screen.getByText(/create your workspace/i)).toBeInTheDocument();
  });

  it("rejects a too-large logo with an inline error but keeps the logo optional", async () => {
    postOrgMock.mockResolvedValue({
      ok: true,
      slug: "acme",
      reserved_host: "droplet.local/acme",
      next_step: "internet",
    });
    render(<SetupPage />);
    await advanceToOrg();

    // Upload an oversized file → inline error on the logo tile.
    const bigFile = new File(
      [new Uint8Array(6 * 1024 * 1024)],
      "logo.png",
      { type: "image/png" },
    );
    const input = screen.getByTestId("org-logo-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [bigFile] } });
      await Promise.resolve();
    });
    expect(screen.getByText(/too large|under 5\s*MB/i)).toBeInTheDocument();

    // Logo is optional — a valid submit without it still advances.
    fillOrg({ name: "Acme HQ", slug: "acme" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(postOrgMock).toHaveBeenCalled();
  });
});
