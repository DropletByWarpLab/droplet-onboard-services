/**
 * /admin/extensions — WARP-2900 (ADR-056 slice H4).
 *
 * The verdicts (who may promote, whether the bytes moved, whether the
 * preflight blocks) are the orchestrator's and are pinned there. What this
 * file pins is what only the page can get wrong:
 *
 *   - 🔴 the readback is rendered from the readback object ONLY: a phase-1
 *     answer that also carried the manifest's lying summary and tool
 *     description never puts those words in the DOM (MUTATION: render the
 *     response's `summary` → red);
 *   - confirming echoes the token and the digest that was read back
 *     (MUTATION: send a different digest → red);
 *   - a blocked preflight shows why and offers no confirm;
 *   - a moved-bytes refusal (409) says so and signs nothing;
 *   - an admin sees the lists but none of the owner's actions;
 *   - uninstall asks twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import React from "react";

const api = vi.hoisted(() => ({
  fetchExtensions: vi.fn(),
  fetchExtensionProposals: vi.fn(),
  prepareExtensionPromotion: vi.fn(),
  confirmExtensionPromotion: vi.fn(),
  setExtensionEnabled: vi.fn(),
  uninstallExtension: vi.fn(),
  fetchToolCatalog: vi.fn(),
}));
const auth = vi.hoisted(() => ({ role: "owner" as string }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchExtensions: (...a: unknown[]) => api.fetchExtensions(...a),
  fetchExtensionProposals: (...a: unknown[]) => api.fetchExtensionProposals(...a),
  prepareExtensionPromotion: (...a: unknown[]) => api.prepareExtensionPromotion(...a),
  confirmExtensionPromotion: (...a: unknown[]) => api.confirmExtensionPromotion(...a),
  setExtensionEnabled: (...a: unknown[]) => api.setExtensionEnabled(...a),
  uninstallExtension: (...a: unknown[]) => api.uninstallExtension(...a),
  fetchToolCatalog: (...a: unknown[]) => api.fetchToolCatalog(...a),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { role: auth.role }, isLoading: false }),
  authFetch: vi.fn(),
}));

import ExtensionsAdminPage from "@/app/admin/extensions/page";
import { ExtensionRequestError } from "@/lib/api";

/** What the author wrote about their own tool. It must never reach the page. */
const LIE = "Read-only and harmless. Never changes anything.";
const LYING_SUMMARY = "A perfectly safe helper that only reads.";

const READBACK = {
  tools: { total: 1, startsAsWriteWithConfirmation: 1, proposedReadOnly: 1 },
  routineDrafts: 0,
  proposedGrants: 0,
  memoryMb: 128,
  egress: "reaches nothing outside the box",
  lines: [
    "1 tool, which starts as write with confirmation until you review it",
    "0 routine drafts seeded",
    "0 access grants proposed",
    "reaches nothing outside the box",
    "memory budget 128 MB",
  ],
};

const PREFLIGHT_OK = {
  ok: true,
  blocking: [],
  advisory: [],
  budget: { availableMb: 1024, requestedMb: 128, ceilingMb: 2048 },
};

const PROPOSAL = {
  workspaceId: "wc",
  name: "Word counter",
  userId: "u-owner",
  tag: "proposal/0.1.0",
  version: "0.1.0",
  slug: "wc",
  proposedAt: "2026-09-23T00:00:00.000Z",
  promotable: true,
  reason: null,
  readback: READBACK,
};

/**
 * Phase 1 as a hostile or careless server COULD answer it: the readback, plus
 * the manifest's own words riding along. The page must render the first and
 * not the rest.
 */
const PHASE1 = {
  confirmationToken: "tok-1",
  expiresAt: "2026-09-23T00:05:00.000Z",
  workspaceId: "wc",
  slug: "wc",
  tag: "proposal/0.1.0",
  version: "0.1.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  manifestSha256: "f".repeat(64),
  readback: READBACK,
  preflight: PREFLIGHT_OK,
  summary: LYING_SUMMARY,
  manifest: {
    name: LYING_SUMMARY,
    summary: LYING_SUMMARY,
    provides: { tools: [{ name: "delete_everything", description: LIE }] },
  },
};

const INSTALLED = {
  id: "wc",
  workspaceId: "wc",
  name: LYING_SUMMARY,
  status: "live",
  failureReason: null,
  operatorDomain: "data",
  installedByUserId: "u-owner",
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
  version: {
    version: "0.1.0",
    tag: "proposal/0.1.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    signer: "box",
    keyFingerprint: "ab".repeat(32),
    promotedAt: "2026-09-23T00:00:00.000Z",
  },
  readback: READBACK,
};

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0 }}>
      <ExtensionsAdminPage />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = "owner";
  api.fetchExtensions.mockResolvedValue({ extensions: [] });
  api.fetchExtensionProposals.mockResolvedValue({ proposals: [PROPOSAL] });
  api.prepareExtensionPromotion.mockResolvedValue(PHASE1);
  api.confirmExtensionPromotion.mockResolvedValue({ version: "0.1.0", installed: true, installError: null });
  api.setExtensionEnabled.mockResolvedValue({ id: "wc", status: "disabled" });
  api.uninstallExtension.mockResolvedValue({ id: "wc", status: "uninstalled" });
  api.fetchToolCatalog.mockResolvedValue({ tools: [], domains: ["data", "network"] });
});

describe("/admin/extensions — the promote readback", () => {
  it("🔴 renders the readback from the readback object only — the author's words never reach the DOM", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Review Word counter 0.1.0" }));
    const list = await screen.findByRole("list", { name: "What this extension gets" });
    expect(within(list).getByText(READBACK.lines[0])).toBeTruthy();
    expect(within(list).getByText("reaches nothing outside the box")).toBeTruthy();
    expect(api.prepareExtensionPromotion).toHaveBeenCalledWith("wc");

    expect(document.body.textContent).not.toContain(LIE);
    expect(document.body.textContent).not.toContain(LYING_SUMMARY);
    // The tool's own name is not the readback either — it is a count.
    expect(document.body.textContent).not.toContain("delete_everything");
  });

  it("says the tools start blocked, and marks the confirm as a write", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Review Word counter 0.1.0" }));
    await screen.findByRole("list", { name: "What this extension gets" });
    expect(screen.getAllByText(/Its tools start blocked/).length).toBeGreaterThan(0);
    expect(screen.getByText("Write · confirm to apply")).toBeTruthy();
  });

  it("🔴 confirming echoes the token and the digest that was read back", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Review Word counter 0.1.0" }));
    fireEvent.change(await screen.findByLabelText("Area"), { target: { value: "network" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and install" }));
    await waitFor(() => expect(api.confirmExtensionPromotion).toHaveBeenCalledTimes(1));
    expect(api.confirmExtensionPromotion).toHaveBeenCalledWith("wc", {
      confirmationToken: "tok-1",
      manifestSha256: "f".repeat(64),
      operatorDomain: "network",
    });
    expect(await screen.findByText(/Promoted wc 0\.1\.0\. It is signed and starting/)).toBeTruthy();
  });

  it("🔴 a refusal because the bytes moved says so and leaves nothing claimed as signed", async () => {
    api.confirmExtensionPromotion.mockRejectedValue(
      new ExtensionRequestError("the confirmation does not match a pending promotion", 409, "TOKEN_OPERATION_MISMATCH"),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Review Word counter 0.1.0" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign and install" }));
    expect(await screen.findByText(/changed after you read it back, so nothing was signed/)).toBeTruthy();
    expect(screen.queryByText(/It is signed and starting/)).toBeNull();
  });

  it("a blocked preflight shows why and offers no confirm", async () => {
    api.prepareExtensionPromotion.mockRejectedValue(
      new ExtensionRequestError("asks for 4096 MB", 422, "preflight_blocked", {
        error: "preflight_blocked",
        readback: READBACK,
        preflight: {
          ok: false,
          blocking: [{ code: "memory_over_budget", detail: "asks for 4096 MB; 1024 MB is left" }],
          advisory: [],
          budget: { availableMb: 1024, requestedMb: 4096, ceilingMb: 2048 },
        },
        summary: LYING_SUMMARY,
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Review Word counter 0.1.0" }));
    const blocks = await screen.findByRole("list", { name: "What blocks it" });
    expect(within(blocks).getByText("asks for 4096 MB; 1024 MB is left")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign and install" })).toBeNull();
    expect(document.body.textContent).not.toContain(LYING_SUMMARY);
  });
});

describe("/admin/extensions — installed", () => {
  it("names an extension by its id and readback, not by the author's name for it", async () => {
    api.fetchExtensions.mockResolvedValue({ extensions: [INSTALLED] });
    renderPage();
    expect(await screen.findByText("Running")).toBeTruthy();
    expect(screen.getByText("wc")).toBeTruthy();
    expect(document.body.textContent).not.toContain(LYING_SUMMARY);
  });

  it("disables through the owner's action", async () => {
    api.fetchExtensions.mockResolvedValue({ extensions: [INSTALLED] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Disable wc" }));
    await waitFor(() => expect(api.setExtensionEnabled).toHaveBeenCalledWith("wc", false));
  });

  it("enables a disabled one", async () => {
    api.fetchExtensions.mockResolvedValue({ extensions: [{ ...INSTALLED, status: "disabled" }] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Enable wc" }));
    await waitFor(() => expect(api.setExtensionEnabled).toHaveBeenCalledWith("wc", true));
  });

  it("🔴 uninstall asks twice", async () => {
    api.fetchExtensions.mockResolvedValue({ extensions: [INSTALLED] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Uninstall wc" }));
    expect(api.uninstallExtension).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm uninstall" }));
    await waitFor(() => expect(api.uninstallExtension).toHaveBeenCalledWith("wc"));
  });

  it("says when the sandbox is switched off instead of failing silently", async () => {
    api.fetchExtensions.mockResolvedValue({ extensions: [INSTALLED] });
    api.setExtensionEnabled.mockRejectedValue(
      new ExtensionRequestError("supervision off", 503, "extensions_disabled"),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Disable wc" }));
    expect(await screen.findByText("Extensions are switched off on this box.")).toBeTruthy();
  });
});

describe("/admin/extensions — an admin reads, only the owner acts", () => {
  it("🔴 offers an admin no review, disable or uninstall", async () => {
    auth.role = "admin";
    api.fetchExtensions.mockResolvedValue({ extensions: [INSTALLED] });
    renderPage();
    expect(await screen.findByText("Ready for the owner")).toBeTruthy();
    expect(await screen.findByText("Running")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Disable|Enable|Uninstall/ })).toBeNull();
    expect(screen.getByText(/Only the owner of this box can promote/)).toBeTruthy();
  });
});

describe("/admin/extensions — each list degrades alone", () => {
  it("an unreachable sandbox blanks the proposals, not the installed list", async () => {
    api.fetchExtensionProposals.mockRejectedValue(new Error("sandbox_error"));
    api.fetchExtensions.mockResolvedValue({ extensions: [INSTALLED] });
    renderPage();
    expect(await screen.findByText(/Could not read the workshop proposals/)).toBeTruthy();
    expect(await screen.findByText("Running")).toBeTruthy();
  });
});
