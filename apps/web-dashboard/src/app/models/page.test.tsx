/**
 * WARP-836 — `/models` read-only status surface.
 *
 * The page shows local LLMs + opt-in cloud providers + KPIs, all read-only.
 * These tests drive the data states (loading / error / empty-degraded /
 * populated) against a mocked `useModelsPage` hook, and — critically — pin the
 * one-model-rule guardrail (architecture-guard #13): there must be NO
 * pull / swap / benchmark / delete / add-model control anywhere on the page.
 * They also pin the honest-placeholder contract: not-yet-wired metrics render
 * as "—"/"Unavailable", and cloud spend as "$0.00", never fabricated values.
 *
 * WARP-1340 adds the indigo-shell scope contract: the page must render inside
 * ShellPage's `.droplet-shell` wrapper, because every class the child
 * components use (`.kpi`, `.card`, the `var(--…)` custom props) is
 * descendant-scoped to it in droplet-shell.css / indigo-tokens.css.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ModelsPagePayload } from "@/lib/types";

const useModelsPageMock = vi.fn();
vi.mock("@/lib/hooks/useModelsPage", () => ({
  useModelsPage: () => useModelsPageMock(),
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
      { provider: "anthropic", enabled: false, lastUsedAt: null, spendUsd: 0 },
      { provider: "openai", enabled: false, lastUsedAt: null, spendUsd: 0 },
      { provider: "gemini", enabled: false, lastUsedAt: null, spendUsd: 0 },
    ],
    gpu: null,
    avgLatencyMs: 0,
    cloudSpendUsd: 0,
    ...over,
  };
}

function ready(over: Partial<ModelsPagePayload> = {}) {
  useModelsPageMock.mockReturnValue({
    data: payload(over),
    error: undefined,
    isLoading: false,
    refresh: vi.fn(),
  });
}

/** All the model-mutation verbs the one-model rule forbids. The page must
 *  expose NONE of these as a control (button/link/menuitem). */
const FORBIDDEN_MUTATION = /pull|swap|benchmark|delete|remove|add model|install|download|uninstall/i;

beforeEach(() => {
  useModelsPageMock.mockReset();
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

  it("renders the three cloud provider rows (Anthropic, OpenAI, Gemini)", () => {
    ready();
    render(<ModelsPage />);
    expect(screen.getByText(/anthropic/i)).toBeInTheDocument();
    expect(screen.getByText(/openai/i)).toBeInTheDocument();
    expect(screen.getByText(/gemini/i)).toBeInTheDocument();
  });

  it("renders cloud toggles as read-only/disabled (enabling happens in settings)", () => {
    ready();
    render(<ModelsPage />);
    // The cloud toggles are switches reflecting enabled:false; on this surface
    // they are non-interactive (disabled). There must be one per provider.
    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBe(3);
    for (const sw of switches) {
      expect(sw).toBeDisabled();
      expect(sw).toHaveAttribute("aria-checked", "false");
    }
    // Copy points the user at settings to actually enable a provider.
    expect(screen.getByText(/settings/i)).toBeInTheDocument();
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

  it("the only switches are the disabled cloud toggles — none are operable", () => {
    ready();
    render(<ModelsPage />);
    const switches = screen.getAllByRole("switch");
    // Every switch on the page is disabled — there is no actionable toggle.
    expect(switches.every((s) => (s as HTMLButtonElement).disabled)).toBe(true);
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
