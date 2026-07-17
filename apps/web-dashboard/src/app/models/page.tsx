"use client";

/**
 * WARP-836 — Models (`/models`)
 *
 * A read-only status surface for the appliance's AI compute: the local LLMs
 * Ollama is serving, the opt-in cloud providers (off by default), and a small
 * strip of KPIs. Backs FEATURES.md §2.11.
 *
 * STATUS-ONLY by design (one-model rule, architecture-guard #13). There is no
 * pull / swap / benchmark / delete / "add model" control anywhere — the only
 * way a model changes is via setup.sh's .env, never a runtime click. The cloud
 * toggles are shown but DISABLED: enabling a provider is a Settings action (the
 * off-LAN allowlist) that logs to Activity and requires admin.
 *
 * Honesty contract: metrics ai-gateway doesn't expose yet (per-model disk,
 * tokens/sec, role, GPU, average latency) render as "—"/"Unavailable", and
 * cloud spend as "$0.00" — never fabricated. The page must still render with an
 * empty `local` list (ai-gateway down) — it shows a calm degraded note.
 *
 * Data: `useModelsPage` → `GET /api/models` (distinct from `/api/llm/models`,
 * the chat model selector).
 */

import { Cpu, ServerCrash, ShieldCheck, XCircle } from "lucide-react";
import { Topbar, type StatusTone } from "@/components/Topbar";
import { useModelsPage } from "@/lib/hooks/useModelsPage";
import { KpiStrip } from "@/components/models/KpiStrip";
import { LocalModelCard } from "@/components/models/LocalModelCard";
import { CloudProviderRow } from "@/components/models/CloudProviderRow";

export default function ModelsPage() {
  const { data, error, isLoading, refresh } = useModelsPage();

  const chrome = (status: { tone: StatusTone; label: string }) => (
    <Topbar
      crumbs={[
        { label: "Workspace", href: "/" },
        { label: "Admin" },
        { label: "Models" },
      ]}
      status={status}
    />
  );

  // ── Loading ──
  if (isLoading) {
    return (
      <div>
        {chrome({ tone: "neutral", label: "Loading models…" })}
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="dp-card h-24 animate-pulse bg-surface-secondary"
              />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div
                key={i}
                className="dp-card h-36 animate-pulse bg-surface-secondary"
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Error (couldn't reach the orchestrator at all) ──
  if (error || !data) {
    return (
      <div>
        {chrome({ tone: "error", label: "Couldn’t load models" })}
        <div className="p-6">
          <div className="dp-card text-center py-12" role="alert">
            <XCircle size={32} className="mx-auto text-system-red mb-3" />
            <h2 className="type-title-3 text-label-primary mb-1">
              Couldn’t load your models
            </h2>
            <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
              We couldn’t reach your Droplet to read its model status. This
              usually clears up on its own — try again in a moment.
            </p>
            <button
              onClick={() => refresh()}
              className="dp-btn-secondary text-sm mt-4"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
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
    <div>
      {chrome({
        tone: degraded || localEmpty ? "warn" : "ok",
        label: statusLabel,
      })}

      <div className="p-6 space-y-8">
        {/* Intro — sets the read-only, local-first framing. */}
        <div>
          <h1 className="type-title-2 text-label-primary">Models</h1>
          <p className="type-subheadline text-label-tertiary mt-1 max-w-2xl">
            The AI models your Droplet uses. Local inference runs on the box;
            cloud models are opt-in and off by default. This page is read-only.
          </p>
        </div>

        {/* KPI strip */}
        <KpiStrip
          gpu={gpu}
          avgLatencyMs={avgLatencyMs}
          cloudSpendUsd={cloudSpendUsd}
          localCount={local.length}
        />

        {/* Local section */}
        <section aria-labelledby="models-local-heading">
          <div className="flex items-center gap-2 mb-3">
            <Cpu size={18} strokeWidth={2} className="text-accent" aria-hidden />
            <h2
              id="models-local-heading"
              className="type-headline text-label-primary"
            >
              Local
            </h2>
            <span className="type-caption-1 text-label-tertiary">
              Runs on the box
            </span>
          </div>

          {localEmpty && degraded ? (
            /* WARP-1289 — outage state: the AI service didn't answer, so we
             * genuinely don't know what's installed. Distinct copy from the
             * "no local models" empty state below — an outage must never
             * read as "you have no models". */
            <div className="dp-card text-center py-10">
              <ServerCrash
                size={28}
                className="mx-auto text-label-quaternary mb-3"
                aria-hidden
              />
              <h3 className="type-subheadline text-label-primary font-medium mb-1">
                Can’t reach your AI service
              </h3>
              <p className="type-footnote text-label-tertiary max-w-md mx-auto">
                We couldn’t reach your Droplet’s AI service to read its model
                list, so we can’t show your local models right now. They’re
                still on the box — this page refreshes automatically and will
                show them again as soon as the service responds.
              </p>
            </div>
          ) : localEmpty ? (
            <div className="dp-card text-center py-10">
              <ServerCrash
                size={28}
                className="mx-auto text-label-quaternary mb-3"
                aria-hidden
              />
              <h3 className="type-subheadline text-label-primary font-medium mb-1">
                No local models running
              </h3>
              <p className="type-footnote text-label-tertiary max-w-md mx-auto">
                Your Droplet’s AI service isn’t reporting any local models right
                now. Once it’s running again, they’ll appear here.
              </p>
            </div>
          ) : (
            <>
              {degraded && (
                /* WARP-1289 — the gateway answered but its local provider
                 * errored mid-listing: the list below may be incomplete. */
                <p
                  className="type-footnote text-label-tertiary mb-3"
                  role="status"
                >
                  We couldn’t fully reach your AI service — some local models
                  may be missing from this list. It refreshes automatically.
                </p>
              )}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {local.map((m) => (
                  <LocalModelCard key={m.name} model={m} />
                ))}
              </div>
            </>
          )}
        </section>

        {/* Cloud section */}
        <section aria-labelledby="models-cloud-heading">
          <div className="flex items-center gap-2 mb-3">
            <ShieldCheck
              size={18}
              strokeWidth={2}
              className="text-accent"
              aria-hidden
            />
            <h2
              id="models-cloud-heading"
              className="type-headline text-label-primary"
            >
              Cloud
            </h2>
            <span className="type-caption-1 text-label-tertiary">
              Opt-in, off by default
            </span>
          </div>

          <div className="dp-group">
            {cloud.map((c) => (
              <CloudProviderRow key={c.provider} provider={c} />
            ))}
          </div>

          <p className="type-caption-1 text-label-tertiary mt-3">
            Cloud models stay off until you enable them in Settings. Turning one
            on sends prompts off your Droplet, so it’s an explicit, logged
            choice.
          </p>
        </section>
      </div>
    </div>
  );
}
