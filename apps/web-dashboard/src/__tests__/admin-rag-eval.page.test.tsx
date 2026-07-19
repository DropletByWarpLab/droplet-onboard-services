/**
 * /admin/rag-eval — RAGAS run-results visibility during transient 503s.
 *
 * The proxy returns 503 both when the rag-eval service is genuinely absent
 * (`eval` Compose profile off) AND when it merely times out while a RAGAS
 * run hogs the container. Contract under test:
 *   1. a 503 on the FIRST poll (no runs loaded) renders the full
 *      enable-the-profile banner, not a stuck "Loading…";
 *   2. a 503 arriving AFTER runs are on screen keeps the toolbar + runs
 *      list and shows the slim "may be busy" notice instead of the
 *      full-page banner;
 *   3. a later successful poll clears the notice;
 *   4. null/NaN metric stats are omitted, never rendered as "null";
 *   5. a failed run with an error string and null metrics renders its
 *      badge + error without crashing.
 *
 * ShellPage is mocked to a passthrough (same as admin-audit.page.test) —
 * its SWR health chip would only add noise here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";

const authFetchMock = vi.fn();
let mockRole: string = "owner";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", role: mockRole }, isLoading: false }),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, actions, children }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {actions ? <div data-testid="phead-actions">{actions}</div> : null}
      {children}
    </div>
  ),
}));

import RagEvalPage from "@/app/admin/rag-eval/page";

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const unavailable503 = { ok: false, status: 503, json: async () => ({ error: "rag_eval_unavailable" }) };

/** Queue of responses for GET /api/admin/rag-eval/runs — the last entry
 *  repeats so the 10 s poll can't drain past the script. FeedbackPanel's
 *  chat-feedback fetch is wired to an empty ok so it stays out of the way. */
function wireApi(runsQueue: unknown[]) {
  authFetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/admin/chat-feedback")) {
      return okJson({ counts: { up: 0, down: 0 }, items: [] });
    }
    if (url.startsWith("/api/admin/rag-eval/runs")) {
      return runsQueue.length > 1 ? runsQueue.shift() : runsQueue[0];
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const goodRun = {
  runId: "run-2026-07-18",
  status: "succeeded",
  startedAt: "2026-07-18T09:00:00.000Z",
  metrics: { faithfulness: { mean: 0.8123 } },
};

beforeEach(() => {
  cleanup();
  authFetchMock.mockReset();
  mockRole = "owner";
});

describe("/admin/rag-eval transient 503 handling", () => {
  it("shows the full enable-profile banner when the FIRST poll 503s (no data)", async () => {
    wireApi([unavailable503]);
    render(<RagEvalPage />);

    expect(await screen.findByText(/rag-eval service is not reachable/i)).toBeInTheDocument();
    expect(screen.getByText(/COMPOSE_PROFILES/)).toBeInTheDocument();
    // Not the transient notice, and no toolbar to mislead with.
    expect(screen.queryByText(/didn't respond to the last poll/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /run rag eval now/i })).toBeNull();
  });

  it("keeps the toolbar + runs list on a 503 AFTER runs loaded, with the slim notice", async () => {
    wireApi([okJson({ runs: [goodRun] }), unavailable503]);
    render(<RagEvalPage />);
    await screen.findByText("run-2026-07-18");

    fireEvent.click(screen.getByRole("button", { name: /refresh runs/i }));

    expect(await screen.findByText(/didn't respond to the last poll/i)).toBeInTheDocument();
    // Past runs and actions stay visible — the service is busy, not absent.
    expect(screen.getByText("run-2026-07-18")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run rag eval now/i })).toBeInTheDocument();
    // The misleading enable-profile instructions must NOT replace the page.
    expect(screen.queryByText(/rag-eval service is not reachable/i)).toBeNull();
    expect(screen.queryByText(/COMPOSE_PROFILES/)).toBeNull();
  });

  it("clears the notice once a later poll succeeds", async () => {
    wireApi([okJson({ runs: [goodRun] }), unavailable503, okJson({ runs: [goodRun] })]);
    render(<RagEvalPage />);
    await screen.findByText("run-2026-07-18");

    fireEvent.click(screen.getByRole("button", { name: /refresh runs/i }));
    await screen.findByText(/didn't respond to the last poll/i);

    fireEvent.click(screen.getByRole("button", { name: /refresh runs/i }));
    await waitFor(() => {
      expect(screen.queryByText(/didn't respond to the last poll/i)).toBeNull();
    });
    expect(screen.getByText("run-2026-07-18")).toBeInTheDocument();
  });
});

describe("/admin/rag-eval metric rendering", () => {
  it("omits null/NaN metric stats instead of rendering 'null'", async () => {
    wireApi([
      okJson({
        runs: [
          {
            runId: "run-mixed",
            status: "succeeded",
            metrics: {
              faithfulness: { mean: 0.8123 },
              answer_relevancy: { mean: null },
              context_precision: NaN,
              overall: 0.5,
            },
          },
        ],
      }),
    ]);
    render(<RagEvalPage />);
    await screen.findByText("run-mixed");

    expect(screen.getByText(/0\.812/)).toBeInTheDocument();
    expect(screen.getByText(/0\.500/)).toBeInTheDocument();
    expect(screen.queryByText(/null/)).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryByText(/answer_relevancy/)).toBeNull();
    expect(screen.queryByText(/context_precision/)).toBeNull();
  });

  it("renders a failed run's badge + error with metrics null, without crashing", async () => {
    wireApi([
      okJson({
        runs: [{ runId: "run-bad", status: "failed", error: "RAGAS crashed: OOM", metrics: null }],
      }),
    ]);
    render(<RagEvalPage />);

    expect(await screen.findByText("run-bad")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText(/RAGAS crashed: OOM/)).toBeInTheDocument();
  });
});
