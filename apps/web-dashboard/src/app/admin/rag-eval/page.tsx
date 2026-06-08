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
 * Re-skinned to the indigo `.droplet-shell` design language (WARP design
 * handoff); the polling, run/bootstrap, and 503 logic are unchanged.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Layers, ShieldOff, AlertTriangle, RefreshCw, FlaskConical } from "lucide-react";
import { useAuth, authFetch } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";
import { ShellPage } from "@/components/shell/ShellPage";

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

const STATUS_BADGE: Record<RunStatus, "ok" | "warn" | "danger" | "info" | "muted"> = {
  running: "info",
  succeeded: "ok",
  failed: "danger",
  unknown: "muted",
};

function formatMetric(v: unknown): string {
  if (typeof v === "number") return v.toFixed(3);
  return String(v);
}

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

const SUB =
  "Fire ad-hoc RAGAS retrieval-quality runs and bootstrap baselines. Runs go through the on-appliance rag-eval service.";

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

  const icon = <FlaskConical size={15} />;

  if (authLoading || (loading && !unavailable && runs.length === 0 && !error)) {
    return (
      <ShellPage icon={icon} label="RAG eval" title="RAG eval" sub={SUB}>
        <div className="card" style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>
          Loading…
        </div>
      </ShellPage>
    );
  }

  if (!isAdminRole(user?.role)) {
    return (
      <ShellPage icon={icon} label="RAG eval" title="RAG eval">
        <div className="card">
          <div className="empty">
            <span className="ei">
              <ShieldOff size={24} />
            </span>
            <span className="eh">Admin access required</span>
            <span>
              This page is only visible to <code>admin</code> / <code>owner</code> roles.
            </span>
          </div>
        </div>
      </ShellPage>
    );
  }

  const refreshAction = (
    <button className="btn" onClick={loadRuns} aria-label="Refresh runs" type="button">
      <RefreshCw size={14} /> Refresh
    </button>
  );

  return (
    <ShellPage icon={icon} label="RAG eval" title="RAG eval" sub={SUB} actions={refreshAction}>
      {unavailable ? (
        <div className="card" style={{ borderColor: "rgba(217,163,92,0.4)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <AlertTriangle size={20} style={{ color: "#d9a35c", flexShrink: 0, marginTop: 2 }} />
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                rag-eval service is not reachable
              </p>
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
                The eval service runs under the <code>eval</code> Compose profile, which is off by
                default. Enable it on the appliance:
              </p>
              <pre
                style={{
                  marginTop: 8,
                  fontSize: 11.5,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-muted)",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 12,
                  overflowX: "auto",
                }}
              >
{`echo 'COMPOSE_PROFILES=linux,display,eval' >> .env
docker compose -f docker/docker-compose.yml --env-file .env up -d rag-eval`}
              </pre>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="toolbar" style={{ marginTop: 4 }}>
            <button className="btn primary" onClick={triggerRun} disabled={busyAction !== null} type="button">
              <Play size={16} />
              {busyAction === "run" ? "Starting…" : "Run RAG eval now"}
            </button>
            <button className="btn" onClick={() => setConfirmBootstrap(true)} disabled={busyAction !== null} type="button">
              <Layers size={16} />
              {busyAction === "bootstrap" ? "Starting…" : "Bootstrap baselines (5 runs)"}
            </button>
          </div>

          {actionMsg && (
            <div className="card" style={{ padding: 12, marginBottom: 14, fontSize: 13, color: "var(--text-muted)" }}>
              {actionMsg}
            </div>
          )}
          {error && (
            <div className="card" style={{ padding: 12, marginBottom: 14, fontSize: 13, color: "#ef4444" }}>
              {error}
            </div>
          )}

          <div className="sect">
            <h2>Recent runs</h2>
            <span className="sx">{runs.length}</span>
          </div>
          {runs.length === 0 ? (
            <div className="card" style={{ textAlign: "center", padding: 32, color: "var(--text-muted)" }}>
              No runs yet.
            </div>
          ) : (
            <div className="grid" style={{ gap: 10 }}>
              {runs.map((r) => {
                const pairs = metricPairs(r.metrics);
                return (
                  <div key={r.runId} className="card">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ fontSize: 13.5, fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                          {r.runId}
                        </span>
                        <span className={"badge " + (STATUS_BADGE[r.status] ?? "muted")}>
                          {r.status}
                          {r.kind === "bootstrap" && r.runsTotal ? ` (${r.runsDone ?? 0}/${r.runsTotal})` : ""}
                        </span>
                      </div>
                      {r.startedAt && (
                        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                          {new Date(r.startedAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    {r.error && (
                      <p style={{ fontSize: 12, color: "#ef4444", marginTop: 8 }}>{r.error}</p>
                    )}
                    {pairs.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 8 }}>
                        {pairs.map(([k, v]) => (
                          <span key={k} style={{ fontSize: 12, color: "var(--text-muted)" }}>
                            <span style={{ color: "var(--text-faint)" }}>{k}:</span> {v}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {confirmBootstrap && (
        <div className="ds-ios-scrim" onClick={() => setConfirmBootstrap(false)}>
          <div className="ds-confirm-card" onClick={(e) => e.stopPropagation()}>
            <h3>Bootstrap baselines?</h3>
            <p>
              This runs RAGAS 5 times sequentially and aggregates the results into{" "}
              <code>baselines.candidate.json</code>. It is GPU-bound and can take roughly an hour on
              the appliance. Only one run or bootstrap can be in flight at a time.
            </p>
            <div className="row">
              <button className="btn" onClick={() => setConfirmBootstrap(false)} type="button">
                Cancel
              </button>
              <button className="btn primary" onClick={triggerBootstrap} type="button">
                Start bootstrap
              </button>
            </div>
          </div>
        </div>
      )}
    </ShellPage>
  );
}
