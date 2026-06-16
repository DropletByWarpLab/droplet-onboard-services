/**
 * WARP-279 — /admin/claude-activity page.
 *
 * Polls GET /api/admin/claude-activity every 30s with `If-Modified-Since`
 * so a 304 short-circuits when nothing's moved. Renders 7 widgets across
 * a responsive grid; admin-only by client check + orchestrator role gate.
 *
 * SSR isn't useful here (the cookie/role check is server-side, but Next
 * 14 in this app hydrates from the client AuthProvider). We just render
 * a `"use client"` page that gates on `useAuth()` after hydration.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldOff, Activity } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { authFetch } from "@/lib/auth";
import { ShellPage } from "@/components/shell/ShellPage";
import { ClaudeNow } from "@/components/claude-activity/ClaudeNow";
import { ActivityFeed } from "@/components/claude-activity/ActivityFeed";
import { OpenPRs } from "@/components/claude-activity/OpenPRs";
import { ChainProgress } from "@/components/claude-activity/ChainProgress";
import { WorkstreamRollup } from "@/components/claude-activity/WorkstreamRollup";
import { DecisionsLog } from "@/components/claude-activity/DecisionsLog";
import { CIStatusBoard } from "@/components/claude-activity/CIStatusBoard";
import type { ClaudeActivityResponse } from "@/components/claude-activity/types";
import { relativeTime } from "@/components/claude-activity/time";

const POLL_MS = 30_000;

function isAdminRole(role?: string): boolean {
  return role === "owner" || role === "admin";
}

export default function ClaudeActivityPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [data, setData] = useState<ClaudeActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  // Cached Last-Modified from the server, sent back as If-Modified-Since
  // on the next poll so the orchestrator can short-circuit with 304.
  const lastModifiedRef = useRef<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdminRole(user?.role)) return;

    let cancelled = false;

    async function poll() {
      try {
        const headers: Record<string, string> = {};
        if (lastModifiedRef.current) {
          headers["If-Modified-Since"] = lastModifiedRef.current;
        }
        const res = await authFetch("/api/admin/claude-activity", { headers });
        if (cancelled) return;

        if (res.status === 304) {
          // Nothing new — keep current state, just bump lastFetched so
          // the "last refreshed N seconds ago" footer ticks forward.
          setLastFetched(new Date());
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
        const lm = res.headers.get("Last-Modified");
        if (lm) lastModifiedRef.current = lm;
        const json = (await res.json()) as ClaudeActivityResponse;
        setData(json);
        setError(null);
        setLastFetched(new Date());
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to fetch /api/admin/claude-activity",
        );
        setLoading(false);
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [authLoading, user?.role]);

  const icon = <Activity size={15} />;
  const SUB = "Live view of what the AI engineer is doing on this repo. Polls every 30 seconds.";

  if (authLoading || (loading && !data)) {
    return (
      <ShellPage icon={icon} label="Activity" title="Claude activity" sub={SUB}>
        <div className="card" style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>
          Loading…
        </div>
      </ShellPage>
    );
  }

  if (!isAdminRole(user?.role)) {
    return (
      <ShellPage icon={icon} label="Activity" title="Claude activity">
        <div className="card">
          <div className="empty">
            <span className="ei">
              <ShieldOff size={24} />
            </span>
            <span className="eh">Admin access required</span>
            <span>
              This dashboard is only visible to <code>admin</code> / <code>owner</code> roles. Ask an
              admin to grant you the <code>admin</code> Nextcloud group membership.
            </span>
          </div>
        </div>
      </ShellPage>
    );
  }

  const refreshStatus = (
    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
      {error ? (
        <span style={{ color: "#ef4444" }}>Error: {error}</span>
      ) : lastFetched ? (
        <span>Refreshed {relativeTime(lastFetched.toISOString())}</span>
      ) : (
        <span>Refreshing…</span>
      )}
    </span>
  );

  return (
    <ShellPage icon={icon} label="Activity" title="Claude activity" sub={SUB} actions={refreshStatus}>
      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Top row — Claude now spans full width on its own */}
          <div className="lg:col-span-3">
            <ClaudeNow now={data.now} />
          </div>

          {/* Left column — Activity feed (tall) */}
          <div className="lg:col-span-2 space-y-4">
            <ActivityFeed data={data} />
            <ChainProgress jira={data.jira} fallbackQueue={data.compliance?.queue} />
            <WorkstreamRollup rows={data.compliance?.workstreams} />
          </div>

          {/* Right column — PRs / decisions / CI */}
          <div className="lg:col-span-1 space-y-4">
            <OpenPRs prs={data.github?.prs ?? null} />
            <DecisionsLog decisions={data.decisions} />
            <CIStatusBoard runs={data.github?.ci_runs ?? null} />
          </div>
        </div>
      )}
    </ShellPage>
  );
}
