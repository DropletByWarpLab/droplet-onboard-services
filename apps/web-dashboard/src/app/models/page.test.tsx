/**
 * WARP-836 — `/models` read-only status surface.
 *
 * The page shows local LLMs + opt-in cloud providers + KPIs, all read-only.
 * These tests drive the data states (loading / error / empty-degraded /
 * populated) against a mocked `useModelsPage` hook, and — critically — pin the
 * one-model-rule guardrail (architecture-guard #13) on the MEMBER-visible
 * surface: no pull / swap / benchmark / delete / add-model control renders
 * for a non-admin (useAuth defaults to user:null, so admin-gated controls —
 * "Measure speed" since WARP-836, "Download" since WARP-1827 — are exercised
 * by their own component tests, not here).
 * They also pin the honest-placeholder contract: not-yet-wired metrics render
 * as "—"/"Unavailable", and cloud spend as "$0.00", never fabricated values.
 *
 * WARP-2871 — the Cloud section is now the ONE place for cloud models: the
 * workspace cloud_model_escape switch (admin, double-confirmed on the way ON)
 * and per-provider key management. The `useAuth` mock is per-test so the
 * admin and member views are both covered here.
 *
 * WARP-1340 adds the indigo-shell scope contract: the page must render inside
 * ShellPage's `.droplet-shell` wrapper, because every class the child
 * components use (`.kpi`, `.card`, the `var(--…)` custom props) is
 * descendant-scoped to it in droplet-shell.css / indigo-tokens.css.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ModelsPagePayload } from "@/lib/types";

const useModelsPageMock = vi.fn();
vi.mock("@/lib/hooks/useModelsPage", () => ({
  useModelsPage: () => useModelsPageMock(),
}));

// WARP-1827 — the catalog hook is mocked per-test; the default (no data)
// renders no catalog section at all, keeping the pre-existing tests exact.
const useModelsCatalogMock = vi.fn();
vi.mock("@/lib/hooks/useModelsCatalog", () => ({
  useModelsCatalog: () => useModelsCatalogMock(),
}));

// WARP-1340 — ShellPage is mocked to a passthrough that renders the real
// wrapper's `.droplet-shell` scope class, same rationale as the audit/trust
// page tests (its SWR health chip + device hook are exercised by their own
// tests). The passthrough keeps the scope assertions below meaningful: the
// page only gets a `.droplet-shell` ancestor by actually rendering ShellPage.
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({
    title,
    sub,
    actions,
    children,
  }: {
    title?: ReactNode;
    sub?: ReactNode;
    actions?: ReactNode;
    children?: ReactNode;
  }) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {actions ? <div data-testid="phead-actions">{actions}</div> : null}
      {children}
    </div>
  ),
}));

// WARP-1112 — the active-model picker has its own tests
// (ActiveModelPicker.test.tsx); stubbed to null so model names aren't
// double-rendered. WARP-2871 — useAuth is a per-test fn (member by default,
// `asAdmin()` for the owner view).
const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => useAuthMock(),
}));
// WARP-2871 — the three cloud writes, hoisted so the mock factory can see
// them; everything else in @/lib/api stays real (LocalModelCard imports it).
const { setCloudModelEscapeMock, saveProviderKeyMock, deleteProviderKeyMock } =
  vi.hoisted(() => ({
    setCloudModelEscapeMock: vi.fn(),
    saveProviderKeyMock: vi.fn(),
    deleteProviderKeyMock: vi.fn(),
  }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  setCloudModelEscape: setCloudModelEscapeMock,
  saveProviderKey: saveProviderKeyMock,
  deleteProviderKey: deleteProviderKeyMock,
}));
vi.mock("@/components/models/ActiveModelPicker", () => ({
  ActiveModelPicker: () => null,
}));

import ModelsPage from "./page";

function payload(over: Partial<ModelsPagePayload> = {}): ModelsPagePayload {
  return {
    local: [
      {
        name: "llama3.1:70b",
        family: "llama",
        provider: "ollama",
        contextLength: 131072,
        gbOnDisk: null,
        role: null,
        status: "ready",
        tokensPerSec: null,
        diskBarPct: null,
      },
    ],
    cloud: [
      { provider: "anthropic", enabled: false, hasKey: true, lastUsedAt: null, spendUsd: 0 },
      { provider: "openai", enabled: false, hasKey: false, lastUsedAt: null, spendUsd: 0 },
    ],
    cloudAccess: {
      escapeEnabled: false,
      escapeChangedBy: null,
      escapeChangedAt: null,
      allowedForYou: false,
    },
    gpu: null,
    avgLatencyMs: 0,
    cloudSpendUsd: 0,
    ...over,
  };
}

function ready(over: Partial<ModelsPagePayload> = {}) {
  const refresh = vi.fn();
  useModelsPageMock.mockReturnValue({
    data: payload(over),
    error: undefined,
    isLoading: false,
    refresh,
  });
  return refresh;
}

/** WARP-2871 — a payload with cloud models allowed on the box. */
function escapeOn(over: Partial<ModelsPagePayload["cloudAccess"]> = {}) {
  return {
    cloudAccess: {
      escapeEnabled: true,
      escapeChangedBy: "romain",
      escapeChangedAt: "2026-09-01T10:00:00.000Z",
      allowedForYou: true,
      ...over,
    },
  };
}

function asAdmin() {
  useAuthMock.mockReturnValue({ user: { role: "owner" } });
}

/** All the model-mutation verbs the one-model rule forbids. The page must
 *  expose NONE of these as a control (button/link/menuitem). */
const FORBIDDEN_MUTATION = /pull|swap|benchmark|delete|remove|add model|install|download|uninstall/i;

/** WARP-1827 — one eligible catalog entry (not yet installed). */
function catalogEntry(over: Record<string, unknown> = {}) {
  return {
    name: "qwen3:14b",
    pull_tag: "qwen3:14b",
    min_vram_gb: 12,
    class: "flagship",
    default: false,
    display_name: "Qwen3 14B",
    maker: "Alibaba",
    description: "A capable multilingual model.",
    capabilities: ["chat"],
    roles: ["chat"],
    disk_gb: 9,
    pulled: false,
    ...over,
  };
}

function catalogReady(models: unknown[]) {
  useModelsCatalogMock.mockReturnValue({
    data: { detected_vram_gb: 16, models },
    error: undefined,
    isLoading: false,
    refresh: vi.fn(),
  });
}

beforeEach(() => {
  useModelsPageMock.mockReset();
  useModelsCatalogMock.mockReset();
  useAuthMock.mockReset();
  useAuthMock.mockReturnValue({ user: null });
  setCloudModelEscapeMock.mockReset();
  saveProviderKeyMock.mockReset();
  deleteProviderKeyMock.mockReset();
  // Default: catalog not loaded → the section renders nothing, and every
  // pre-WARP-1827 test sees exactly the page it always did.
  useModelsCatalogMock.mockReturnValue({
    data: undefined,
    error: undefined,
    isLoading: false,
    refresh: vi.fn(),
  });
});

describe("<ModelsPage /> (WARP-836)", () => {
  it("shows a loading state while fetching", () => {
    useModelsPageMock.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      refresh: vi.fn(),
    });
    render(<ModelsPage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an error state with a retry affordance", () => {
    const refresh = vi.fn();
    useModelsPageMock.mockReturnValue({
      data: undefined,
      error: new Error("boom"),
      isLoading: false,
      refresh,
    });
    render(<ModelsPage />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /retry|try again/i });
    expect(retry).toBeInTheDocument();
  });

  it("renders the KPI strip with model store, GPU, avg latency and cloud spend", () => {
    ready();
    render(<ModelsPage />);
    expect(screen.getByText(/model store/i)).toBeInTheDocument();
    expect(screen.getByText(/^GPU$/i)).toBeInTheDocument();
    expect(screen.getByText(/avg latency/i)).toBeInTheDocument();
    expect(screen.getByText(/cloud spend/i)).toBeInTheDocument();
    // Cloud spend is the one KPI with a real (zero) value — shown as $0.00.
    expect(screen.getByText(/\$0\.00/)).toBeInTheDocument();
  });

  it("renders a local model card with name, family, context length and the local-only shield", () => {
    ready();
    render(<ModelsPage />);
    expect(screen.getByText("llama3.1:70b")).toBeInTheDocument();
    // family shown somewhere on the card
    expect(screen.getAllByText(/llama/i).length).toBeGreaterThanOrEqual(1);
    // context length humanised (131072 → 128k); accept either exact or k-form.
    expect(screen.getByText(/128k|131072|131,072/i)).toBeInTheDocument();
    // the "local-only" shield copy
    expect(screen.getByText(/local-only/i)).toBeInTheDocument();
  });

  it("maps status 'ready' to a 'running' chip on the local card", () => {
    ready();
    render(<ModelsPage />);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it("maps status 'loading' and 'error' to the right chips", () => {
    useModelsPageMock.mockReturnValue({
      data: payload({
        local: [
          {
            name: "qwen2.5-coder:32b",
            family: "qwen",
            provider: "ollama",
            contextLength: 65536,
            gbOnDisk: null,
            role: null,
            status: "loading",
            tokensPerSec: null,
            diskBarPct: null,
          },
          {
            name: "broken-model",
            family: "other",
            provider: "ollama",
            contextLength: null,
            gbOnDisk: null,
            role: null,
            status: "error",
            tokensPerSec: null,
            diskBarPct: null,
          },
        ],
      }),
      error: undefined,
      isLoading: false,
      refresh: vi.fn(),
    });
    render(<ModelsPage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });

  it("renders the cloud provider rows (Anthropic, OpenAI) and no Gemini", () => {
    ready();
    render(<ModelsPage />);
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.queryByText(/gemini/i)).toBeNull();
  });

  it("member sees the cloud state read-only: no switch, no key buttons (WARP-2871)", () => {
    ready();
    render(<ModelsPage />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Cloud models are off on this Droplet")).toBeInTheDocument();
    expect(screen.getByText("Only an admin can change this.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add key|replace key|remove .* key/i })).toBeNull();
  });

  it("renders honest placeholders for not-yet-wired metrics (no fabricated values)", () => {
    ready();
    render(<ModelsPage />);
    // gbOnDisk / tokensPerSec / role / gpu / avgLatency are all null/0 in the
    // fixture — the page must show an em-dash / "unavailable", never a number.
    const dashes = screen.getAllByText(/—|unavailable|not available|n\/a/i);
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it("renders a degraded/empty local state when local is [] (ai-gateway down)", () => {
    ready({ local: [] });
    render(<ModelsPage />);
    // The page still renders (KPIs + cloud), and shows an explicit empty note
    // for the local section rather than a blank gap. Query the heading by role
    // so it's unambiguous (the KPI tiles also legitimately say "Unavailable").
    expect(screen.getByText(/cloud spend/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /no local models/i }),
    ).toBeInTheDocument();
    // Cloud rows still render in the degraded state.
    expect(screen.getByText(/anthropic/i)).toBeInTheDocument();
  });

  // ── WARP-1289 — honest degraded state (same pattern as the wizard's
  //    WARP-1284 model-degraded note): an empty local list WITH
  //    `degraded: true` means "can't reach the AI service", and must NOT
  //    render as "no local models". ──

  it("renders the AI-service-unreachable state when degraded + empty local (WARP-1289)", () => {
    ready({ local: [], degraded: true });
    render(<ModelsPage />);
    expect(
      screen.getByRole("heading", { name: /can’t reach your ai service/i }),
    ).toBeInTheDocument();
    // The genuine-empty copy must NOT show — that's the exact dishonesty
    // this ticket removes.
    expect(
      screen.queryByRole("heading", { name: /no local models/i }),
    ).not.toBeInTheDocument();
    // The rest of the page still renders (KPIs + cloud).
    expect(screen.getByText(/cloud spend/i)).toBeInTheDocument();
    expect(screen.getByText(/anthropic/i)).toBeInTheDocument();
  });

  it("keeps the genuine-empty copy when local is [] and NOT degraded (WARP-1289)", () => {
    ready({ local: [], degraded: false });
    render(<ModelsPage />);
    expect(
      screen.getByRole("heading", { name: /no local models/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /can’t reach your ai service/i }),
    ).not.toBeInTheDocument();
  });

  it("shows an incomplete-list note when degraded but some models still listed (WARP-1289)", () => {
    ready({ degraded: true }); // fixture keeps one local model
    render(<ModelsPage />);
    // The card still renders…
    expect(screen.getByText("llama3.1:70b")).toBeInTheDocument();
    // …with an honest note that the list may be incomplete.
    expect(screen.getByText(/may be missing/i)).toBeInTheDocument();
  });
});

// ── One-model rule (architecture-guard #13) — status-only, NO mutations ──

describe("<ModelsPage /> one-model-rule guardrail (WARP-836)", () => {
  it("exposes NO model-mutation controls (no pull/swap/benchmark/delete/add)", () => {
    ready();
    render(<ModelsPage />);
    const buttons = screen.queryAllByRole("button");
    for (const b of buttons) {
      expect(b).not.toHaveTextContent(FORBIDDEN_MUTATION);
      expect(b.getAttribute("aria-label") ?? "").not.toMatch(FORBIDDEN_MUTATION);
    }
    const links = screen.queryAllByRole("link");
    for (const l of links) {
      expect(l).not.toHaveTextContent(FORBIDDEN_MUTATION);
    }
  });

  it("exposes no mutation controls even in the degraded (local empty) state", () => {
    ready({ local: [] });
    render(<ModelsPage />);
    const buttons = screen.queryAllByRole("button");
    for (const b of buttons) {
      expect(b).not.toHaveTextContent(FORBIDDEN_MUTATION);
    }
  });

  it("exposes no mutation controls in the AI-service-unreachable state (WARP-1289)", () => {
    ready({ local: [], degraded: true });
    render(<ModelsPage />);
    const buttons = screen.queryAllByRole("button");
    for (const b of buttons) {
      expect(b).not.toHaveTextContent(FORBIDDEN_MUTATION);
      expect(b.getAttribute("aria-label") ?? "").not.toMatch(FORBIDDEN_MUTATION);
    }
  });

  it("a member has no operable switch on the page", () => {
    ready();
    render(<ModelsPage />);
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

// ── WARP-2871 — the Cloud section: escape switch + provider keys ──

describe("<ModelsPage /> cloud section (WARP-2871)", () => {
  it("admin sees the switch and the key buttons", () => {
    asAdmin();
    ready();
    render(<ModelsPage />);
    const sw = screen.getByRole("switch", { name: /allow cloud models on this droplet/i });
    expect(sw).toBeEnabled();
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Allow cloud models on this Droplet")).toBeInTheDocument();
    // anthropic has a key, openai does not
    expect(screen.getByRole("button", { name: /replace key/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Anthropic key" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add key/i })).toBeInTheDocument();
  });

  it("badges: Not set up / Key saved · cloud off when escape is off", () => {
    ready();
    render(<ModelsPage />);
    expect(screen.getByText("Not set up")).toBeInTheDocument();
    expect(screen.getByText("Key saved · cloud off")).toBeInTheDocument();
  });

  it("badges: Ready when escape is on and the caller is allowed", () => {
    ready(escapeOn());
    render(<ModelsPage />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("badges: Blocked for your role when escape is on but the role says no", () => {
    ready(escapeOn({ allowedForYou: false }));
    render(<ModelsPage />);
    expect(screen.getByText("Blocked for your role")).toBeInTheDocument();
  });

  it("hasKey null renders Unknown and never 'Not set up'", () => {
    ready({
      cloud: [
        { provider: "anthropic", enabled: false, hasKey: null, lastUsedAt: null, spendUsd: 0 },
        { provider: "openai", enabled: false, hasKey: null, lastUsedAt: null, spendUsd: 0 },
      ],
    });
    render(<ModelsPage />);
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    expect(screen.queryByText("Not set up")).toBeNull();
    expect(screen.getAllByText(/key status unavailable/i)).toHaveLength(2);
  });

  it("turning ON opens a red double-confirm; only 'Turn on' calls the API", async () => {
    asAdmin();
    setCloudModelEscapeMock.mockResolvedValue(undefined);
    const refresh = ready();
    render(<ModelsPage />);
    fireEvent.click(screen.getByRole("switch"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Turn cloud models on?");
    expect(dialog).toHaveTextContent(/logged to Activity/);
    expect(setCloudModelEscapeMock).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Turn on" });
    expect(confirm.className).toMatch(/\bdanger\b/);
    fireEvent.click(confirm);
    await waitFor(() => expect(setCloudModelEscapeMock).toHaveBeenCalledWith(true));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("cancelling the double-confirm calls nothing", async () => {
    asAdmin();
    ready();
    render(<ModelsPage />);
    fireEvent.click(screen.getByRole("switch"));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(setCloudModelEscapeMock).not.toHaveBeenCalled();
  });

  it("a failed turn-on keeps the dialog open and shows the error", async () => {
    asAdmin();
    setCloudModelEscapeMock.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );
    ready();
    render(<ModelsPage />);
    fireEvent.click(screen.getByRole("switch"));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Only owners and admins can change this.",
      ),
    );
    // ConfirmDialog contract: a rejected onConfirm stays open for a retry.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Add key hides while its editor is open", async () => {
    asAdmin();
    ready();
    render(<ModelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect(screen.queryByRole("button", { name: "Add key" })).toBeNull();
    expect(screen.getByRole("link", { name: /Get a key from OpenAI/ })).toHaveAttribute(
      "href",
      "https://platform.openai.com/api-keys",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Add key" })).toBeInTheDocument();
  });

  it("turning OFF is a plain flip — no dialog", async () => {
    asAdmin();
    setCloudModelEscapeMock.mockResolvedValue(undefined);
    ready(escapeOn());
    render(<ModelsPage />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    await waitFor(() => expect(setCloudModelEscapeMock).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a 403 on the switch says who can change it", async () => {
    asAdmin();
    setCloudModelEscapeMock.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );
    ready(escapeOn());
    render(<ModelsPage />);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Only owners and admins can change this.",
      ),
    );
  });

  it("shows who turned cloud on, and when", () => {
    ready(escapeOn());
    render(<ModelsPage />);
    expect(screen.getByText(/Turned on by romain ·/)).toBeInTheDocument();
    expect(screen.getByText("On")).toBeInTheDocument();
  });

  it("says 'Off since setup' when never changed", () => {
    ready();
    render(<ModelsPage />);
    expect(screen.getByText(/Off since setup · Nothing has left this Droplet/)).toBeInTheDocument();
  });

  it("add-key flow: expand → type → Save → saveProviderKey → refresh", async () => {
    asAdmin();
    saveProviderKeyMock.mockResolvedValue(undefined);
    const refresh = ready();
    render(<ModelsPage />);
    fireEvent.click(screen.getByRole("button", { name: /add key/i }));
    const save = screen.getByRole("button", { name: /save key/i });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Paste the key"), {
      target: { value: "sk-live-123" },
    });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(saveProviderKeyMock).toHaveBeenCalledWith("openai", "sk-live-123"),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // editor collapsed
    expect(screen.queryByPlaceholderText("Paste the key")).toBeNull();
  });

  it("remove-key confirm → deleteProviderKey → refresh", async () => {
    asAdmin();
    deleteProviderKeyMock.mockResolvedValue(undefined);
    const refresh = ready();
    render(<ModelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Anthropic key" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Remove Anthropic key?");
    expect(deleteProviderKeyMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(deleteProviderKeyMock).toHaveBeenCalledWith("anthropic"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("member strip when cloud is on but the role blocks the viewer", () => {
    ready(escapeOn({ allowedForYou: false }));
    render(<ModelsPage />);
    expect(screen.getByText("Cloud keys are managed by an admin")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /roles & access/i })).toHaveAttribute(
      "href",
      "/users",
    );
  });

  it("no member strip for an admin, nor while cloud is off", () => {
    ready(); // off
    const { unmount } = render(<ModelsPage />);
    expect(screen.queryByText("Cloud keys are managed by an admin")).toBeNull();
    unmount();
    asAdmin();
    ready(escapeOn({ allowedForYou: false }));
    render(<ModelsPage />);
    expect(screen.queryByText("Cloud keys are managed by an admin")).toBeNull();
  });

  it("caption variants: admin/off, admin/on, member", () => {
    asAdmin();
    ready();
    const r1 = render(<ModelsPage />);
    expect(screen.getByText(/You can add keys while cloud is off/)).toBeInTheDocument();
    r1.unmount();
    ready(escapeOn());
    const r2 = render(<ModelsPage />);
    expect(screen.getByText(/Keys are managed by admins, stored encrypted/)).toBeInTheDocument();
    r2.unmount();
    useAuthMock.mockReturnValue({ user: { role: "member" } });
    ready(escapeOn());
    render(<ModelsPage />);
    expect(screen.getByText(/^Keys are stored encrypted on your Droplet/)).toBeInTheDocument();
  });

  it("the old 'enable them in Settings' caption is gone", () => {
    ready();
    render(<ModelsPage />);
    expect(screen.queryByText(/enable them in Settings/i)).toBeNull();
  });
});

// ── WARP-1340 — the page must mount the indigo shell scope. The `.kpi` /
//    `.card` classes the child components (KpiStrip, LocalModelCard,
//    CloudProviderRow) render are DESCENDANT-SCOPED in droplet-shell.css
//    (`.droplet-shell .kpi { … }`), and the indigo custom properties are
//    scoped the same way in indigo-tokens.css. Without a `.droplet-shell`
//    ancestor (ShellPage) they match nothing and the tiles collapse to bare
//    concatenated text — the exact live-box bug this ticket fixes. ──

describe("<ModelsPage /> indigo shell scope (WARP-1340)", () => {
  it("mounts the .droplet-shell scope around the KPI strip", () => {
    ready();
    const { container } = render(<ModelsPage />);
    // All four KPI tiles must sit inside the shell scope, or their `.kpi` /
    // `.k` / `.v` / `.d` spans render as unstyled inline text.
    expect(container.querySelectorAll(".droplet-shell .kpi").length).toBe(4);
  });

  it("keeps the local-model + cloud cards inside the shell scope", () => {
    ready();
    const { container } = render(<ModelsPage />);
    // LocalModelCard + the cloud rows' wrapper both render `.card`, which is
    // also descendant-scoped.
    expect(
      container.querySelectorAll(".droplet-shell .card").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps the shell scope in the loading state", () => {
    useModelsPageMock.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      refresh: vi.fn(),
    });
    const { container } = render(<ModelsPage />);
    expect(container.querySelector(".droplet-shell")).not.toBeNull();
  });

  it("keeps the shell scope in the error state", () => {
    useModelsPageMock.mockReturnValue({
      data: undefined,
      error: new Error("boom"),
      isLoading: false,
      refresh: vi.fn(),
    });
    const { container } = render(<ModelsPage />);
    expect(container.querySelector(".droplet-shell")).not.toBeNull();
  });

  // The legacy Topbar's per-page status chip is replaced by a visible status
  // element in the shell header — same signal, same tone logic.
  it("surfaces the page status — model count when healthy", () => {
    ready();
    render(<ModelsPage />);
    expect(screen.getByText("1 local model")).toBeInTheDocument();
  });

  it("surfaces the page status — 'Local models unavailable' when local is empty", () => {
    ready({ local: [] });
    render(<ModelsPage />);
    expect(screen.getByText("Local models unavailable")).toBeInTheDocument();
  });

  it("surfaces the page status — 'AI service unreachable' when degraded (WARP-1289)", () => {
    ready({ local: [], degraded: true });
    render(<ModelsPage />);
    expect(screen.getByText("AI service unreachable")).toBeInTheDocument();
  });
});

// ── WARP-1827 — "Available to install" catalog section + placement banner ──

describe("<ModelsPage /> catalog section (WARP-1827)", () => {
  it("renders eligible not-yet-pulled entries under 'Available to install'", () => {
    ready();
    catalogReady([
      catalogEntry(),
      catalogEntry({ name: "gpt-oss:20b", display_name: "GPT-OSS 20B", pulled: true }),
    ]);
    render(<ModelsPage />);
    expect(
      screen.getByRole("heading", { name: /available to install/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Qwen3 14B")).toBeInTheDocument();
    // Already-installed entries don't show as installable.
    expect(screen.queryByText("GPT-OSS 20B")).toBeNull();
    // The honesty note: where downloads come from, where they run.
    expect(screen.getByText(/model registry/i)).toBeInTheDocument();
  });

  it("renders NOTHING when every eligible model is already pulled (no empty shell)", () => {
    ready();
    catalogReady([catalogEntry({ pulled: true })]);
    render(<ModelsPage />);
    expect(screen.queryByText(/available to install/i)).toBeNull();
    expect(screen.queryByText(/model registry/i)).toBeNull();
  });

  it("renders NOTHING while the catalog is unavailable (error/loading)", () => {
    ready();
    useModelsCatalogMock.mockReturnValue({
      data: undefined,
      error: new Error("503"),
      isLoading: false,
      refresh: vi.fn(),
    });
    render(<ModelsPage />);
    expect(screen.queryByText(/available to install/i)).toBeNull();
  });

  it("member (no admin role) sees the metadata but NO download control", () => {
    // useAuth is mocked to user:null at module level — a member-shaped view.
    ready();
    catalogReady([catalogEntry()]);
    render(<ModelsPage />);
    expect(screen.getByText("Qwen3 14B")).toBeInTheDocument();
    for (const b of screen.queryAllByRole("button")) {
      expect(b).not.toHaveTextContent(/download/i);
      expect(b.getAttribute("aria-label") ?? "").not.toMatch(/download/i);
    }
  });
});

describe("<ModelsPage /> placement banner (WARP-1827)", () => {
  const cpuRow = {
    name: "llama3.1:70b",
    family: "llama",
    provider: "ollama",
    contextLength: 131072,
    gbOnDisk: null,
    role: null,
    status: "ready" as const,
    tokensPerSec: null,
    diskBarPct: null,
    loaded: true,
    placement: "cpu" as const,
    gpuFraction: 0,
    placementState: "measured" as const,
  };

  it("warns once when the active model runs on the CPU", () => {
    ready({ local: [cpuRow], activeModel: "llama3.1:70b" });
    render(<ModelsPage />);
    const banner = screen.getByText(/running on the CPU/i);
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/active model/i);
    expect(banner.textContent).toMatch(/llama3\.1:70b/);
    expect(banner.textContent).toMatch(/slower/i);
  });

  it("says 'partly on the GPU' for a partial placement", () => {
    ready({
      local: [{ ...cpuRow, placement: "partial" as const, gpuFraction: 0.5 }],
      activeModel: "llama3.1:70b",
    });
    render(<ModelsPage />);
    expect(screen.getByText(/partly on the GPU/i)).toBeInTheDocument();
  });

  it("shows NO banner when placement is absent — absence of data is not health", () => {
    ready(); // fixture row carries no placement fields
    render(<ModelsPage />);
    expect(screen.queryByText(/running on the CPU|partly on the GPU/i)).toBeNull();
  });

  it("shows NO banner when the loaded model is fully on the GPU", () => {
    ready({
      local: [{ ...cpuRow, placement: "gpu" as const, gpuFraction: 1 }],
    });
    render(<ModelsPage />);
    expect(screen.queryByText(/running on the CPU|partly on the GPU/i)).toBeNull();
  });
});
