/**
 * WARP-519 — /admin/rag-eval page.
 *
 * Operator surface for ad-hoc RAGAS runs. Two actions ("Run RAG eval now",
 * "Bootstrap baselines") plus a list of recent runs with their top-level
 * metric means. All calls go through the orchestrator proxy at
 * /api/admin/rag-eval/* (auth-gated; admin/owner only).
 *
 * When the proxy returns 503 (rag_eval_unavailable) the rag-eval service
 * isn't running — the `eval` Compose profile is inactive — so we render a
 * banner explaining how to enable it rather than a generic error.
 *
 * `"use client"` + useAuth() gate, mirroring /admin/claude-activity.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Layers, ShieldOff, AlertTriangle, RefreshCw } from "lucide-react";
import { useAuth, authFetch } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";

const POLL_MS = 10_000;

function isAdminRole(role?: string): boolean {
  return role === "owner" || role === "admin";
}

type RunStatus = "running" | "succeeded" | "failed" | "unknown";

interface RunWire {
  runId: string;
  kind?: string;
  status: RunStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string;
  metrics?: Record<string, unknown> | null;
  runsTotal?: number | null;
  runsDone?: number;
}

const STATUS_STYLE: Record<RunStatus, string> = {
  running: "text-system-blue",
  succeeded: "text-system-green",
  failed: "text-system-red",
  unknown: "text-label-quaternary",
};

function formatMetric(v: unknown): string {
  if (typeof v === "number") return v.toFixed(3);
  return String(v);
}

/** Pull the numeric top-level metric means out of a results `metrics`
 * block for compact display. RAGAS metric shapes vary (mean nested vs
 * flat number); handle both without guessing a fixed key set. */
function metricPairs(
  metrics: Record<string, unknown> | null | undefined,
): Array<[string, string]> {
  if (!metrics) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v === "number") {
      out.push([k, formatMetric(v)]);
    } else if (v && typeof v === "object" && "mean" in (v as object)) {
      out.push([k, formatMetric((v as { mean: unknown }).mean)]);
    }
  }
  return out;
}

export default function RagEvalPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [runs, setRuns] = useState<RunWire[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<null | "run" | "bootstrap">(null);
  const [confirmBootstrap, setConfirmBootstrap] = useState(false);
  const cancelledRef = useRef(false);

  const loadRuns = useCallback(async () => {
    try {
      const res = await authFetch("/api/admin/rag-eval/runs");
      if (cancelledRef.current) return;
      if (res.status === 503) {
        setUnavailable(true);
        setError(null);
        setLoading(false);
        return;
      }
      if (res.status === 403) {
        setError("Admin access required");
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      setUnavailable(false);
      const json = (await res.json()) as { runs?: RunWire[] };
      setRuns(json.runs ?? []);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (cancelledRef.current) return;
      setError(translateError(err, "knowledge"));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading || !isAdminRole(user?.role)) return;
    cancelledRef.current = false;
    loadRuns();
    const id = setInterval(loadRuns, POLL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [authLoading, user?.role, loadRuns]);

  const triggerRun = useCallback(async () => {
    setBusyAction("run");
    setActionMsg(null);
    try {
      const res = await authFetch("/api/admin/rag-eval/run", { method: "POST" });
      if (res.status === 503) {
        setUnavailable(true);
      } else if (res.status === 409) {
        const j = (await res.json()) as { runId?: string };
        setActionMsg(`A run is already in progress (${j.runId ?? "unknown"}).`);
      } else if (res.status === 202) {
        const j = (await res.json()) as { runId?: string };
        setActionMsg(`Run started: ${j.runId ?? "(id pending)"}`);
        loadRuns();
      } else {
        setActionMsg(`Unexpected response: HTTP ${res.status}`);
      }
    } catch {
      setActionMsg("Failed to start run.");
    } finally {
      setBusyAction(null);
    }
  }, [loadRuns]);

  const triggerBootstrap = useCallback(async () => {
    setConfirmBootstrap(false);
    setBusyAction("bootstrap");
    setActionMsg(null);
    try {
      const res = await authFetch("/api/admin/rag-eval/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runs: 5 }),
      });
      if (res.status === 503) {
        setUnavailable(true);
      } else if (res.status === 409) {
        const j = (await res.json()) as { runId?: string };
        setActionMsg(`A run is already in progress (${j.runId ?? "unknown"}).`);
      } else if (res.status === 202) {
        const j = (await res.json()) as { runId?: string; runs?: number };
        setActionMsg(
          `Bootstrap started: ${j.runs ?? 5} runs (${j.runId ?? "(id pending)"}). This can take ~1h.`,
        );
        loadRuns();
      } else {
        setActionMsg(`Unexpected response: HTTP ${res.status}`);
      }
    } catch {
      setActionMsg("Failed to start bootstrap.");
    } finally {
      setBusyAction(null);
    }
  }, [loadRuns]);

  if (authLoading || (loading && !unavailable && runs.length === 0 && !error)) {
    return (
      <div className="p-6 lg:p-8 max-w-4xl">
        <h1 className="type-large-title text-label-primary mb-6">RAG eval</h1>
        <div className="dp-card p-12 text-center text-label-tertiary type-subheadline">
          Loading…
        </div>
      </div>
    );
  }

  if (!isAdminRole(user?.role)) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl">
        <h1 className="type-large-title text-label-primary mb-4">RAG eval</h1>
        <div className="dp-card py-16 flex flex-col items-center text-label-tertiary">
          <ShieldOff size={32} className="mb-3 text-label-quaternary" />
          <p className="type-subheadline">Admin access required</p>
          <p className="type-caption-1 mt-1 text-label-quaternary max-w-sm text-center">
            This page is only visible to <code>admin</code> / <code>owner</code>{" "}
            roles.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="type-large-title text-label-primary">RAG eval</h1>
          <p className="type-caption-1 text-label-tertiary mt-1">
            Fire ad-hoc RAGAS retrieval-quality runs and bootstrap baselines.
            Runs go through the on-appliance rag-eval service.
          </p>
        </div>
        <button
          onClick={loadRuns}
          className="dp-btn-secondary inline-flex items-center gap-1.5 type-footnote"
          aria-label="Refresh runs"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </header>

      {unavailable ? (
        <div className="dp-card p-5 mb-6 border border-system-orange/30">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="text-system-orange shrink-0 mt-0.5" />
            <div>
              <p className="type-subheadline text-label-primary">
                rag-eval service is not reachable
              </p>
              <p className="type-caption-1 text-label-tertiary mt-1">
                The eval service runs under the <code>eval</code> Compose
                profile, which is off by default. Enable it on the appliance:
              </p>
              <pre className="mt-2 text-label-secondary type-caption-2 bg-surface-secondary rounded-lg p-3 overflow-x-auto">
{`echo 'COMPOSE_PROFILES=linux,display,eval' >> .env
docker compose -f docker/docker-compose.yml --env-file .env up -d rag-eval`}
              </pre>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-3 mb-4">
            <button
              onClick={triggerRun}
              disabled={busyAction !== null}
              className="dp-btn-primary inline-flex items-center gap-2 disabled:opacity-50"
            >
              <Play size={16} />
              {busyAction === "run" ? "Starting…" : "Run RAG eval now"}
            </button>
            <button
              onClick={() => setConfirmBootstrap(true)}
              disabled={busyAction !== null}
              className="dp-btn-secondary inline-flex items-center gap-2 disabled:opacity-50"
            >
              <Layers size={16} />
              {busyAction === "bootstrap" ? "Starting…" : "Bootstrap baselines (5 runs)"}
            </button>
          </div>

          {actionMsg && (
            <div className="dp-card p-3 mb-4 type-footnote text-label-secondary">
              {actionMsg}
            </div>
          )}
          {error && (
            <div className="dp-card p-3 mb-4 type-footnote text-system-red">
              {error}
            </div>
          )}

          <h2 className="type-headline text-label-primary mb-3">Recent runs</h2>
          {runs.length === 0 ? (
            <div className="dp-card p-8 text-center text-label-tertiary type-subheadline">
              No runs yet.
            </div>
          ) : (
            <ul className="space-y-2">
              {runs.map((r) => {
                const pairs = metricPairs(r.metrics);
                return (
                  <li key={r.runId} className="dp-card p-4">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3">
                        <span className="type-callout text-label-primary font-mono">
                          {r.runId}
                        </span>
                        <span
                          className={`type-caption-1 font-medium ${STATUS_STYLE[r.status] ?? STATUS_STYLE.unknown}`}
                        >
                          {r.status}
                          {r.kind === "bootstrap" && r.runsTotal
                            ? ` (${r.runsDone ?? 0}/${r.runsTotal})`
                            : ""}
                        </span>
                      </div>
                      {r.startedAt && (
                        <span className="type-caption-2 text-label-quaternary">
                          {new Date(r.startedAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    {r.error && (
                      <p className="type-caption-2 text-system-red mt-2">
                        {r.error}
                      </p>
                    )}
                    {pairs.length > 0 && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                        {pairs.map(([k, v]) => (
                          <span
                            key={k}
                            className="type-caption-2 text-label-secondary"
                          >
                            <span className="text-label-quaternary">{k}:</span>{" "}
                            {v}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {confirmBootstrap && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="dp-card p-6 max-w-md w-full">
            <h3 className="type-headline text-label-primary mb-2">
              Bootstrap baselines?
            </h3>
            <p className="type-footnote text-label-tertiary mb-5">
              This runs RAGAS 5 times sequentially and aggregates the results
              into <code>baselines.candidate.json</code>. It is GPU-bound and
              can take roughly an hour on the appliance. Only one run or
              bootstrap can be in flight at a time.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmBootstrap(false)}
                className="dp-btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={triggerBootstrap}
                className="dp-btn-primary"
              >
                Start bootstrap
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
