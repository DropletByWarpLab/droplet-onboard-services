"use client";

/**
 * WARP-836 / WARP-1112 — Models (`/models`)
 *
 * A status surface for the appliance's AI compute: the local LLMs Ollama is
 * serving, the opt-in cloud providers (off by default), and a small strip of
 * KPIs. Backs FEATURES.md §2.11.
 *
 * WARP-1112 added the one write on this page: owners/admins can change the
 * *active local model* (which installed model the box answers with by default)
 * via the ActiveModelPicker → PATCH /api/models/active. It never pulls, swaps,
 * benchmarks, or deletes — it only re-points chat at a model already on the box
 * (the catalog/download story is separate). Members see the active model
 * read-only. The cloud toggles remain shown-but-DISABLED: enabling a provider
 * is a Settings action (the off-LAN allowlist) that logs to Activity.
 *
 * Honesty contract: metrics ai-gateway doesn't expose yet (per-model disk,
 * tokens/sec, role, GPU, average latency) render as "—"/"Unavailable", and
 * cloud spend as "$0.00" — never fabricated. The page must still render with an
 * empty `local` list (ai-gateway down) — it shows a calm degraded note.
 *
 * WARP-1340 — the page is wrapped in ShellPage (the indigo design language),
 * finishing the WARP-1091 conversion: the child components (KpiStrip,
 * LocalModelCard, CloudProviderRow) render `.kpi` / `.card` classes and
 * `var(--…)` custom props that are DESCENDANT-SCOPED to `.droplet-shell` in
 * droplet-shell.css / indigo-tokens.css, so without this wrapper they match
 * nothing and the tiles collapse to bare concatenated text. The legacy
 * Topbar's per-page status chip becomes a Badge in the page header (`Phead`
 * actions) with the same tone logic.
 *
 * Data: `useModelsPage` → `GET /api/models` (distinct from `/api/llm/models`,
 * the chat model selector).
 */

import { Cpu, ServerCrash, XCircle } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge } from "@/components/shell/primitives";
import { useModelsPage } from "@/lib/hooks/useModelsPage";
import { useAuth } from "@/lib/auth";
import { KpiStrip } from "@/components/models/KpiStrip";
import { LocalModelCard } from "@/components/models/LocalModelCard";
import { ActiveModelPicker } from "@/components/models/ActiveModelPicker";
import { CloudProviderRow } from "@/components/models/CloudProviderRow";

// Honesty-contract copy — local-first framing. Owners/admins can change the
// active local model here (WARP-1112); members see it read-only.
const SUB =
  "The AI models your Droplet uses. Local inference runs on the box; cloud models are opt-in and off by default.";

/** Owner/admin can change the active model; everyone else sees it read-only.
 *  Mirrors the orchestrator's requireRole("owner","admin") on the write. */
function isAdminRole(role?: string): boolean {
  return role === "owner" || role === "admin";
}

export default function ModelsPage() {
  const { data, error, isLoading, refresh } = useModelsPage();
  const { user } = useAuth();
  const canManage = isAdminRole(user?.role);

  const icon = <Cpu size={15} />;

  // ── Loading ──
  if (isLoading) {
    return (
      <ShellPage icon={icon} label="Models" title="Models" sub="Loading models…">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="card animate-pulse"
              style={{ height: 96, background: "var(--surface-2)" }}
            />
          ))}
        </div>
        <div
          className="grid grid-cols-1 lg:grid-cols-2 gap-4"
          style={{ marginTop: 16 }}
        >
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="card animate-pulse"
              style={{ height: 144, background: "var(--surface-2)" }}
            />
          ))}
        </div>
      </ShellPage>
    );
  }

  // ── Error (couldn't reach the orchestrator at all) ──
  if (error || !data) {
    return (
      <ShellPage icon={icon} label="Models" title="Models" sub={SUB}>
        <div className="card" role="alert">
          <div className="empty">
            <span className="ei" aria-hidden>
              <XCircle size={24} />
            </span>
            <h2 className="eh">Couldn’t load your models</h2>
            <span style={{ maxWidth: "44ch" }}>
              We couldn’t reach your Droplet to read its model status. This
              usually clears up on its own — try again in a moment.
            </span>
            <button
              onClick={() => refresh()}
              className="btn"
              type="button"
              style={{ marginTop: 8 }}
            >
              Try again
            </button>
          </div>
        </div>
      </ShellPage>
    );
  }

  const { local, cloud, gpu, avgLatencyMs, cloudSpendUsd } = data;
  const localEmpty = local.length === 0;
  // WARP-1289 — the orchestrator's honesty flag: the local list can't be
  // trusted as complete (ai-gateway unreachable, or its Ollama provider
  // failed during listing). Same pattern as the wizard's WARP-1284
  // model-degraded note: never render "no local models" for an outage.
  const degraded = data.degraded === true;
  const statusLabel = degraded
    ? "AI service unreachable"
    : localEmpty
      ? "Local models unavailable"
      : local.length === 1
        ? "1 local model"
        : `${local.length} local models`;

  return (
    <ShellPage
      icon={icon}
      label="Models"
      title="Models"
      sub={SUB}
      actions={
        <Badge kind={degraded || localEmpty ? "warn" : "ok"}>
          {statusLabel}
        </Badge>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        {/* KPI strip */}
        <KpiStrip
          gpu={gpu}
          avgLatencyMs={avgLatencyMs}
          cloudSpendUsd={cloudSpendUsd}
          localCount={local.length}
        />

        {/* WARP-1112 — active-model selector. Only shown when we actually
            know the installed set (not during an outage/empty state), so we
            never render a picker over a list we couldn't read. */}
        {!localEmpty && (
          <ActiveModelPicker
            models={local}
            activeModel={data.activeModel ?? null}
            canManage={canManage}
            onChanged={() => {
              void refresh();
            }}
          />
        )}

        {/* Local section */}
        <section aria-labelledby="models-local-heading">
          <div className="sect">
            <h2 id="models-local-heading">Local</h2>
            <span className="sx">Runs on the box</span>
          </div>

          {localEmpty && degraded ? (
            /* WARP-1289 — outage state: the AI service didn't answer, so we
             * genuinely don't know what's installed. Distinct copy from the
             * "no local models" empty state below — an outage must never
             * read as "you have no models". */
            <div className="card">
              <div className="empty">
                <span className="ei" aria-hidden>
                  <ServerCrash size={24} />
                </span>
                <h3 className="eh">Can’t reach your AI service</h3>
                <span style={{ maxWidth: "44ch" }}>
                  We couldn’t reach your Droplet’s AI service to read its model
                  list, so we can’t show your local models right now. They’re
                  still on the box — this page refreshes automatically and will
                  show them again as soon as the service responds.
                </span>
              </div>
            </div>
          ) : localEmpty ? (
            <div className="card">
              <div className="empty">
                <span className="ei" aria-hidden>
                  <ServerCrash size={24} />
                </span>
                <h3 className="eh">No local models running</h3>
                <span style={{ maxWidth: "44ch" }}>
                  Your Droplet’s AI service isn’t reporting any local models
                  right now. Once it’s running again, they’ll appear here.
                </span>
              </div>
            </div>
          ) : (
            <>
              {degraded && (
                /* WARP-1289 — the gateway answered but its local provider
                 * errored mid-listing: the list below may be incomplete. */
                <p
                  className="type-footnote"
                  role="status"
                  style={{ color: "var(--text-muted)", margin: "0 0 12px" }}
                >
                  We couldn’t fully reach your AI service — some local models
                  may be missing from this list. It refreshes automatically.
                </p>
              )}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {local.map((m) => (
                  <LocalModelCard
                    key={m.name}
                    model={m}
                    canManage={canManage}
                    onBenchmarked={() => {
                      void refresh();
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </section>

        {/* Cloud section */}
        <section aria-labelledby="models-cloud-heading">
          <div className="sect">
            <h2 id="models-cloud-heading">Cloud</h2>
            <span className="sx">Opt-in, off by default</span>
          </div>

          <div className="card" style={{ padding: 6 }}>
            <div className="rows">
              {cloud.map((c) => (
                <CloudProviderRow key={c.provider} provider={c} />
              ))}
            </div>
          </div>

          <p
            className="type-caption-1"
            style={{ color: "var(--text-muted)", marginTop: 12 }}
          >
            Cloud models stay off until you enable them in Settings. Turning one
            on sends prompts off your Droplet, so it’s an explicit, logged
            choice.
          </p>
        </section>
      </div>
    </ShellPage>
  );
}
