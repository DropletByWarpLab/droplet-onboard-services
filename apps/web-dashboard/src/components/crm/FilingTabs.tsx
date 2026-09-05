"use client";

/**
 * WARP-2731 (ADR-048) — the two tabs beside "Needs a look", and the Health row.
 *
 * ── Why Rules and Skipped are tabs and not a settings page ─────────────────
 *
 * Because they answer the two questions an owner actually asks about this
 * feature, and both are asked in the same breath as "what needs a look":
 *
 *   "Why did it do that?"      → Rules. What it has been taught, in sentences.
 *   "Why did it do nothing?"   → Skipped. What it decided to leave alone.
 *
 * The second is the one that matters most. A skip produces no card anywhere, so
 * without this list the feature has a silent mode: an owner drops a folder of
 * invoices into a directory whose name happens to contain "treatment", nothing
 * appears, and there is no surface that says why. That is the single most
 * likely way this feature loses trust — not by filing something wrong, but by
 * quietly filing nothing.
 *
 * ── The Health row reports silences, not successes ─────────────────────────
 *
 * "Last read a new file 3 days ago" is the line that catches a corpus the
 * indexer can no longer embed — a state in which filing is working perfectly
 * and has nothing to do, and every other indicator is green. A panel that
 * counted only what filing DID would look healthiest the moment it stopped.
 */

import { useState, type JSX } from "react";

import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "@/components/projects/icons";
import { EmptyBlock } from "@/components/projects/bits";

import {
  useFilingActions,
  useFilingDecided,
  useFilingRules,
  useFilingSkipped,
  useFilingSummary,
  type FilingHealth,
  type FilingProposal,
} from "./useFiling";

/** Past tense, because this one already happened. */
function headlineForApplied(p: FilingProposal): string {
  const d = p.payload ?? {};
  switch (p.kind) {
    case "CREATE_CUSTOMER":
      return `Added ${d.name ?? "a customer"}`;
    case "LINK_FILE":
      return `Filed a document under ${d.companyName ?? "a customer"}`;
    case "CREATE_CONTACT":
      return `Added ${d.displayName ?? "a person"} to your address book`;
    case "CREATE_PROJECT":
      return `Started ${d.name ?? "a project"}`;
    default:
      return "Filed something";
  }
}

export type FilingTab = "review" | "rules" | "skipped";

export function FilingTabList({
  tab,
  onTab,
  pending,
}: {
  tab: FilingTab;
  onTab: (t: FilingTab) => void;
  pending: number;
}): JSX.Element {
  const tabs: { id: FilingTab; label: string; count?: number }[] = [
    { id: "review", label: "Needs a look", count: pending },
    { id: "rules", label: "What you've taught it" },
    { id: "skipped", label: "Left alone" },
  ];
  return (
    <div className="filing-tabs" role="tablist" aria-label="Filing">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={tab === t.id}
          className={`filing-tab${tab === t.id ? " is-active" : ""}`}
          onClick={() => onTab(t.id)}
        >
          {t.label}
          {t.count ? <span className="filing-tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** "3 days ago", "just now" — never a raw timestamp. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function HealthRow({ health }: { health: FilingHealth | undefined }): JSX.Element | null {
  if (!health) return null;

  // 🔴 The three states worth interrupting for, and nothing else. A health row
  // that always has something to say is one nobody reads on the day it matters.
  const notes: { tone: "warn" | "info"; text: string }[] = [];

  if (health.paused) {
    notes.push({
      tone: "warn",
      text: "Droplet has paused — it could not reach the AI service. It will try again shortly.",
    });
  }
  if (health.hoursSinceLastIndex !== null && health.hoursSinceLastIndex >= 48) {
    // The corpus-block signal. Filing is fine; the thing that feeds it is not.
    notes.push({
      tone: "warn",
      text: `Droplet has not finished reading a new file in ${Math.floor(
        health.hoursSinceLastIndex / 24,
      )} days. New uploads may not be getting indexed.`,
    });
  }
  if (health.failed > 0) {
    notes.push({
      tone: "info",
      text:
        health.failed === 1
          ? "1 file could not be read. It is in the Left alone list."
          : `${health.failed} files could not be read. They are in the Left alone list.`,
    });
  }

  return (
    <div className="filing-health">
      <span className="filing-health-tick">
        Last checked for new files {ago(health.lastTickAt)}
      </span>
      {notes.map((n, i) => (
        <span key={i} className={`filing-health-note is-${n.tone}`}>
          <PmIcon name={n.tone === "warn" ? "alert" : "signal"} size={13} /> {n.text}
        </span>
      ))}
    </div>
  );
}

/**
 * "Recently filed — Undo".
 *
 * 🔴 Undo has to be reachable AFTER the moment of applying, not only in the
 * toast that follows it. The mistake an owner notices is rarely the one they
 * just made: it is the one they find when they open the customer next Tuesday
 * and the invoice is on the wrong record. A reversal that expires with the
 * toast is a reversal for the wrong failure.
 *
 * Deliberately short and deliberately at the TOP of the review list rather than
 * a tab of its own — it is a thing you glance at on the way past, not a place
 * you go.
 */
export function RecentlyFiled({
  onUndo,
  busyId,
}: {
  onUndo: (id: string) => void;
  busyId: string | null;
}): JSX.Element | null {
  const { summary } = useFilingSummary();
  const { proposals } = useFilingDecided(summary?.enabled ?? false);
  const undoable = (proposals ?? []).filter((p) => p.status === "APPLIED").slice(0, 5);
  if (undoable.length === 0) return null;

  return (
    <div className="filing-recent">
      <h4>Recently filed</h4>
      <ul>
        {undoable.map((p) => (
          <li key={p.id}>
            <span>{headlineForApplied(p)}</span>
            <button
              className="pm-btn sm ghost"
              disabled={busyId === p.id}
              onClick={() => onUndo(p.id)}
            >
              Undo
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RulesTab(): JSX.Element {
  const { toast } = useToast();
  const { summary } = useFilingSummary();
  const { rules, error, isLoading, mutate } = useFilingRules(summary?.enabled ?? false);
  const actions = useFilingActions();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (error) {
    return (
      <EmptyBlock
        icon="alert"
        tone="error"
        heading="Could not load this"
        body={translateError(error, "projects")}
      />
    );
  }
  if (isLoading) return <div className="pm-skel" style={{ height: 120 }} />;
  if (!rules || rules.length === 0) {
    return (
      <EmptyBlock
        icon="bulb"
        heading="You haven't taught Droplet anything yet"
        body="When you say “not this customer” or “ignore this”, Droplet remembers, and the rule shows up here so you can take it back."
      />
    );
  }

  return (
    <ul className="filing-rules">
      {rules.map((r) => (
        <li key={r.id}>
          <span className="filing-rule-text">{r.sentence}</span>
          <button
            className="pm-btn sm ghost"
            disabled={busyId === r.id}
            onClick={async () => {
              setBusyId(r.id);
              try {
                await actions.revokeRule(r.id);
                toast("Forgotten", "success");
                await mutate();
              } catch (e) {
                toast(translateError(e, "projects"), "error");
              } finally {
                setBusyId(null);
              }
            }}
          >
            Forget
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SkippedTab(): JSX.Element {
  const { summary } = useFilingSummary();
  const { items, error, isLoading } = useFilingSkipped(summary?.enabled ?? false);

  if (error) {
    return (
      <EmptyBlock
        icon="alert"
        tone="error"
        heading="Could not load this"
        body={translateError(error, "projects")}
      />
    );
  }
  if (isLoading) return <div className="pm-skel" style={{ height: 120 }} />;
  if (!items || items.length === 0) {
    return (
      <EmptyBlock
        icon="check"
        heading="Droplet has not left anything alone"
        body="Files it decides not to read — personal documents, anything in a folder you told it to skip — will be listed here with the reason."
      />
    );
  }

  return (
    <ul className="filing-skipped">
      {items.map((s) => (
        <li key={s.sourceRef}>
          {/* 🔴 The reason and the time. NEVER the filename, and never a
              snippet: the whole point of a skip is that the document was
              judged not to be read further, and quoting it on the page that
              explains the skip would undo the skip. */}
          <span className="filing-skipped-why">{s.explanation}</span>
          <span className="filing-skipped-when">{ago(s.skippedAt)}</span>
        </li>
      ))}
    </ul>
  );
}
