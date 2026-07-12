"use client";

/**
 * WARP-837 — EmailAIPanel (column 3 of the 3-column mail client).
 *
 * "Droplet · about this thread" (FEATURES.md §2.4 AI side panel): a 2-sentence
 * summary, bullet callouts, an ordered list of suggested actions EACH carrying
 * its Read / Write · confirm safety chip (§6), and a Related list (files /
 * threads / cameras / tools — cross-system retrieval).
 *
 * This panel is read-only: it surfaces what Droplet noticed. Nothing here
 * mutates — the only write path on this surface (sending a draft) lives in the
 * thread column behind an explicit confirm step.
 *
 * WARP-1088 — indigo shell: recolored onto the shared `.card`/`.badge`
 * language + shell tokens (droplet-shell.css / indigo-tokens.css). The
 * `.droplet-shell` scope itself is established by EmailWorkspace's root, one
 * level up. Pure recolor/reclass — no behavior change.
 */

import { FileText, Mail, Sparkles, Video, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { RelatedReferences, ThreadAnalysis } from "@/lib/types-email";
import { SafetyChip } from "./SafetyChip";

interface EmailAIPanelProps {
  analysis?: ThreadAnalysis;
  isLoading: boolean;
  error?: Error;
  onRetry?: () => void;
}

const PanelTitle = () => (
  <div className="flex items-center gap-1.5">
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded-full"
      style={{ background: "var(--brand-subtle)" }}
    >
      <Sparkles size={12} style={{ color: "var(--brand)" }} aria-hidden />
    </span>
    <h2 className="type-subheadline font-semibold" style={{ color: "var(--text)" }}>
      Droplet · about this thread
    </h2>
  </div>
);

export function EmailAIPanel({
  analysis,
  isLoading,
  error,
  onRetry,
}: EmailAIPanelProps) {
  return (
    <aside
      aria-label="Droplet thread analysis"
      className="flex flex-col h-full min-h-0 overflow-y-auto"
      style={{ borderLeft: "1px solid var(--border)", background: "var(--surface)" }}
    >
      <div className="shrink-0 px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <PanelTitle />
      </div>

      <div className="flex-1 min-h-0 p-4 space-y-5">
        {isLoading ? (
          <div aria-label="Loading analysis" className="space-y-3">
            <div className="h-24 rounded-xl animate-pulse" style={{ background: "var(--inset)" }} />
            <div className="h-4 w-24 rounded animate-pulse" style={{ background: "var(--inset)" }} />
            <div className="h-16 rounded-xl animate-pulse" style={{ background: "var(--inset)" }} />
          </div>
        ) : error ? (
          <div className="card text-center" style={{ padding: "32px 0" }} role="alert">
            <p className="type-subheadline" style={{ color: "var(--text)" }}>
              Analysis isn&rsquo;t available
            </p>
            <p className="type-footnote mt-1" style={{ color: "var(--text-muted)" }}>
              Droplet couldn&rsquo;t read this thread just now.
            </p>
            {onRetry && (
              <button type="button" onClick={onRetry} className="btn sm mt-3">
                Try again
              </button>
            )}
          </div>
        ) : !analysis ? (
          <div className="text-center py-10">
            <Sparkles
              size={24}
              className="mx-auto mb-2"
              style={{ color: "var(--text-faint)" }}
              aria-hidden
            />
            <p className="type-footnote max-w-[220px] mx-auto" style={{ color: "var(--text-muted)" }}>
              Select a conversation and Droplet will summarise it here.
            </p>
          </div>
        ) : (
          <>
            {/* Summary + callouts */}
            <div className="card" style={{ padding: "14px" }}>
              <p className="type-footnote leading-relaxed" style={{ color: "var(--text)" }}>
                {analysis.summary}
              </p>
              {analysis.callouts.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {analysis.callouts.map((c, i) => (
                    <li
                      key={i}
                      className="flex gap-2 type-caption-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <span
                        className="mt-1.5 shrink-0 w-1 h-1 rounded-full"
                        style={{ background: "var(--brand)" }}
                        aria-hidden
                      />
                      <span>{c.label}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Actions — each carries its safety chip (§6, non-negotiable). */}
            {analysis.suggestedActions.length > 0 && (
              <section aria-labelledby="ai-actions-h">
                <h3
                  id="ai-actions-h"
                  className="type-caption-2 uppercase tracking-[0.12em] font-semibold mb-2"
                  style={{ color: "var(--text-muted)" }}
                >
                  Actions
                </h3>
                <ol
                  className="space-y-1.5"
                  aria-label="Suggested actions"
                >
                  {analysis.suggestedActions.map((a, i) => (
                    <li key={i}>
                      {/* Read-only surface: actions are shown, not dispatched
                          from here. They prime the next step; the actual write
                          happens behind the thread's confirm gate or in chat.
                          No trailing chevron — these rows are not clickable. */}
                      <div className="card" style={{ padding: "12px" }}>
                        <span className="block type-footnote" style={{ color: "var(--text)" }}>
                          {a.label}
                        </span>
                        <span className="block mt-1.5">
                          <SafetyChip safety={a.safety} />
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {/* Related — cross-system references. */}
            {hasRelated(analysis.related) && (
              <section aria-labelledby="ai-related-h">
                <h3
                  id="ai-related-h"
                  className="type-caption-2 uppercase tracking-[0.12em] font-semibold mb-2"
                  style={{ color: "var(--text-muted)" }}
                >
                  Related
                </h3>
                <ul className="space-y-1">
                  <RelatedGroup
                    items={analysis.related.files}
                    icon={FileText}
                    iconClass="text-system-blue"
                  />
                  <RelatedGroup
                    items={analysis.related.threads}
                    icon={Mail}
                    iconClass="text-[color:var(--brand)]"
                  />
                  <RelatedGroup
                    items={analysis.related.cameras}
                    icon={Video}
                    iconClass="text-system-orange"
                  />
                  <RelatedGroup
                    items={analysis.related.tools}
                    icon={Wrench}
                    iconClass="text-[color:var(--text-muted)]"
                  />
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function hasRelated(r: RelatedReferences): boolean {
  return (
    r.files.length > 0 ||
    r.threads.length > 0 ||
    r.cameras.length > 0 ||
    r.tools.length > 0
  );
}

function RelatedGroup({
  items,
  icon: Icon,
  iconClass,
}: {
  items: string[];
  icon: LucideIcon;
  iconClass: string;
}) {
  if (items.length === 0) return null;
  return (
    <>
      {items.map((label, i) => (
        <li
          key={`${label}-${i}`}
          className="flex items-center gap-2 px-1 py-1.5 type-caption-1"
          style={{ color: "var(--text-muted)" }}
        >
          <Icon size={13} className={`shrink-0 ${iconClass}`} aria-hidden />
          <span className="truncate">{label}</span>
        </li>
      ))}
    </>
  );
}
