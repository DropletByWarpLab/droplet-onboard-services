"use client";

/**
 * WARP-2733 (ADR-048) — the settings card, which is the consent record.
 *
 * ── The readback is not written here ───────────────────────────────────────
 *
 * 🔴 Every sentence under "What this means" comes from the server, built from
 * the policy table by `readback.ts`. This component renders it and adds
 * nothing.
 *
 * The whole argument for unattended writes is consent at enable time: the
 * owner promotes a CLASS of action, having been told in plain English what
 * that class is. A client that composed its own description would be
 * describing a table it does not have — and would keep describing the old one
 * after a deploy that changed it. Then the box does something the owner was
 * never told about while the screen still shows the old promise. That is not a
 * stale string; it is consent obtained for a different thing.
 *
 * ── There is no "Accept all" ───────────────────────────────────────────────
 *
 * 🔴 Deliberately, and a test asserts its ABSENCE. WARP-2179 deferred batching
 * precisely so it could not become allow-all, and a queue of twelve cards with
 * one button at the bottom is allow-all wearing a review surface's clothes.
 *
 * The asymmetry is the point and it runs in the safe direction: there is no
 * way to accept many things at once, and there ARE ways to undo many at once.
 * Making a mistake should be slower than fixing one.
 */

import { useState, type JSX } from "react";

import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "@/components/projects/icons";

import { useFilingActions, useFilingSummary, type FilingSummary } from "./useFiling";

const MODES: { id: FilingSummary["mode"]; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Droplet does not read your files." },
  {
    id: "propose",
    label: "Suggest only",
    hint: "Droplet reads new files and asks you where they go.",
  },
  {
    id: "auto",
    label: "File it automatically",
    hint: "Droplet files the easy ones by itself, within limits you can see.",
  },
];

const LEVELS: { id: FilingSummary["level"]; label: string }[] = [
  { id: "links_only", label: "Links and timeline only" },
  { id: "also_create", label: "Also create new customers and projects" },
];

export function FilingSettings(): JSX.Element | null {
  const { toast } = useToast();
  const { summary, mutate } = useFilingSummary();
  const actions = useFilingActions();
  const [busy, setBusy] = useState(false);

  if (!summary) return null;

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done, "success");
      await mutate();
    } catch (e) {
      // The canary refusal lands here as `auto_needs_canary`, which
      // friendly-errors renders as "Droplet needs to check how well it reads
      // your documents before it can file anything on its own."
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="filing-settings pm-surface">
      <h3>What Droplet does with new files</h3>

      <div className="filing-modes" role="radiogroup" aria-label="Filing mode">
        {MODES.map((m) => (
          <label key={m.id} className={summary.mode === m.id ? "is-active" : undefined}>
            <input
              type="radio"
              name="filing-mode"
              checked={summary.mode === m.id}
              disabled={busy}
              onChange={() => void run(() => actions.setMode(m.id), "Saved")}
            />
            <span className="filing-mode-label">{m.label}</span>
            <span className="filing-mode-hint">{m.hint}</span>
          </label>
        ))}
      </div>

      {summary.mode === "auto" && (
        <div className="filing-levels" role="radiogroup" aria-label="How much it may do">
          {LEVELS.map((l) => (
            <label key={l.id} className={summary.level === l.id ? "is-active" : undefined}>
              <input
                type="radio"
                name="filing-level"
                checked={summary.level === l.id}
                disabled={busy}
                onChange={() => void run(() => actions.setLevel(l.id), "Saved")}
              />
              {l.label}
            </label>
          ))}
        </div>
      )}

      {summary.readback && summary.readback.length > 0 && (
        <div className="filing-readback">
          <h4>What this means</h4>
          <ul>
            {summary.readback.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.health?.pausedMessage && (
        <p className="filing-health-note is-warn">
          <PmIcon name="alert" size={13} /> {summary.health.pausedMessage}
        </p>
      )}
    </section>
  );
}

/**
 * "You've filed 20 things and corrected 1. Want Droplet to do the easy ones by
 * itself?"
 *
 * Decision D1: auto mode is in the card above from day one, and the page ALSO
 * offers it once the owner has a track record. The second half is the honest
 * version of "are you ready" — a measurement of THEIR corpus with THIS model,
 * not a nag on a timer. The sentence is built server-side from the same counts
 * that decide whether to show it, so it cannot say twenty while meaning twelve.
 */
export function FilingPromotion(): JSX.Element | null {
  const { toast } = useToast();
  const { summary, mutate } = useFilingSummary();
  const actions = useFilingActions();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (!summary?.promotion?.offer || dismissed) return null;

  return (
    <div className="filing-promotion">
      <span>{summary.promotion.sentence}</span>
      <button
        className="pm-btn primary sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await actions.setMode("auto");
            toast("Droplet will file the easy ones by itself", "success");
            await mutate();
          } catch (e) {
            toast(translateError(e, "projects"), "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        Yes, do the easy ones
      </button>
      <button className="pm-btn sm ghost" onClick={() => setDismissed(true)}>
        Not yet
      </button>
    </div>
  );
}
