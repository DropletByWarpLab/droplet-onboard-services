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
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import React from "react";

import { claimApiMocks, passClaimStep } from "./helpers/claim-step";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ setupState: { appliance: "unclaimed", setupStep: "welcome", userTourCompleted: false } }),
}));

const postOrgMock = vi.fn();
// WARP-1301 — the Org step itself now reads the box's trusted address
// (DROPLET_PUBLIC_FQDN) via fetchVpnStatus for the workspace-URL preview, so
// the mock is per-test overridable (default: no FQDN → .local fallback).
const fetchVpnStatusMock = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    setupAdmin: vi.fn(async () => undefined),
    loginUser: vi.fn(async () => undefined),
    patchSetupStep: vi.fn(async () => undefined),
    ...claimApiMocks(),
    postOrg: (input: unknown) => postOrgMock(input),
    // The Org step (WARP-1301) and the Address step (after org) read the box's
    // web address via fetchVpnStatus; keep it quiet so assertions can see it.
    fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
    fetchDiscoveredCameras: vi.fn(async () => []),
    fetchVpnStatus: () => fetchVpnStatusMock(),
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
  fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
    target: { value: "owner@warp.test" },
  });
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByPlaceholderText(/create a password/i), {
    target: { value: "Abcdefghijk1" },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: "Abcdefghijk1" },
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
    fetchVpnStatusMock.mockReset();
    fetchVpnStatusMock.mockResolvedValue({
      configured: false,
      endpointConfigured: false,
    });
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

  // WARP-1301 (spec §5 FQDN-everywhere): the workspace-URL preview prints the
  // box's trusted address when DROPLET_PUBLIC_FQDN is known, and only falls
  // back to the droplet.local typing shortcut when it isn't.
  describe("workspace URL host (WARP-1301)", () => {
    it("prefixes the slug with the trusted FQDN when the box knows one", async () => {
      fetchVpnStatusMock.mockResolvedValue({
        configured: false,
        endpointConfigured: false,
        publicFqdn: "studio.droplet-us.com",
      });
      render(<SetupPage />);
      await advanceToOrg();
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText("studio.droplet-us.com /")).toBeInTheDocument();
      // The .local prefix must NOT be the previewed host anymore…
      expect(screen.queryByText("droplet.local /")).not.toBeInTheDocument();
      // …but the name survives in copy as the typing shortcut.
      expect(screen.getByText(/droplet\.local/)).toBeInTheDocument();
    });

    it("falls back to the droplet.local shortcut when no FQDN is known", async () => {
      fetchVpnStatusMock.mockResolvedValue({
        configured: false,
        endpointConfigured: false,
        publicFqdn: null,
      });
      render(<SetupPage />);
      await advanceToOrg();
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText("droplet.local /")).toBeInTheDocument();
    });

    it("keeps the .local fallback when the status read fails (best-effort)", async () => {
      fetchVpnStatusMock.mockRejectedValue(new Error("orchestrator starting"));
      render(<SetupPage />);
      await advanceToOrg();
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText("droplet.local /")).toBeInTheDocument();
    });
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

  // Live logo preview in the 68x68 tile (fix/setup-image-preview).
  // jsdom ships no URL.createObjectURL/revokeObjectURL — stub them so we can
  // both render the preview and assert the object-URL lifecycle.
  describe("logo preview in the tile", () => {
    let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
    let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;
    let urlSeq: number;

    beforeEach(() => {
      urlSeq = 0;
      createObjectURL = vi.fn<(blob: Blob) => string>(() => `blob:preview-${++urlSeq}`);
      revokeObjectURL = vi.fn<(url: string) => void>();
      // URL.createObjectURL is absent in jsdom; define it on the global URL.
      (URL as unknown as { createObjectURL: unknown }).createObjectURL =
        createObjectURL;
      (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL =
        revokeObjectURL;
    });

    afterEach(() => {
      // Unmount any still-mounted tree FIRST so its useEffect cleanup can revoke
      // its object URL while the stubs are still installed — then remove them so
      // the stubs don't leak to other test files (jsdom has no native impl).
      cleanup();
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
      delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    });

    function validLogo(name = "logo.png") {
      return new File([new Uint8Array(8)], name, { type: "image/png" });
    }

    it("renders a thumbnail preview and drops the placeholder icon after a valid select", async () => {
      render(<SetupPage />);
      await advanceToOrg();

      // Placeholder present before any select: the "Logo" label is shown.
      expect(screen.getByText(/^Logo$/)).toBeInTheDocument();

      const input = screen.getByTestId("org-logo-input") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { files: [validLogo()] } });
        await Promise.resolve();
      });

      // The preview <img> renders with the object-URL src + sensible alt.
      const preview = screen.getByAltText(/logo preview/i) as HTMLImageElement;
      expect(preview).toBeInTheDocument();
      expect(preview.getAttribute("src")).toBe("blob:preview-1");
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      // Placeholder "Logo" label is gone once the preview is showing.
      expect(screen.queryByText(/^Logo$/)).not.toBeInTheDocument();
    });

    it("shows no preview and keeps the error path on an invalid (too-large) select", async () => {
      render(<SetupPage />);
      await advanceToOrg();

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

      // Error renders; no preview; placeholder stays.
      expect(screen.getByText(/too large|under 5\s*MB/i)).toBeInTheDocument();
      expect(screen.queryByAltText(/logo preview/i)).not.toBeInTheDocument();
      expect(screen.getByText(/^Logo$/)).toBeInTheDocument();
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it("revokes the previous object URL when the logo is replaced", async () => {
      render(<SetupPage />);
      await advanceToOrg();

      const input = screen.getByTestId("org-logo-input") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { files: [validLogo("a.png")] } });
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.change(input, { target: { files: [validLogo("b.png")] } });
        await Promise.resolve();
      });

      // Two creates, one revoke of the first URL; preview now shows the second.
      expect(createObjectURL).toHaveBeenCalledTimes(2);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
      const preview = screen.getByAltText(/logo preview/i) as HTMLImageElement;
      expect(preview.getAttribute("src")).toBe("blob:preview-2");
    });

    it("revokes the object URL on unmount (no leak)", async () => {
      const { unmount } = render(<SetupPage />);
      await advanceToOrg();

      const input = screen.getByTestId("org-logo-input") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { files: [validLogo()] } });
        await Promise.resolve();
      });
      expect(revokeObjectURL).not.toHaveBeenCalled();

      await act(async () => {
        unmount();
      });
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    });
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
