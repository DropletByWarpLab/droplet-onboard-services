"use client";

import { useState } from "react";
import { Check, Download, FileText } from "lucide-react";
import { downloadLogBundle } from "@/lib/api";

/**
 * WARP-823 — Settings "Diagnostics" section.
 *
 * Lets an owner/admin download a bundle of the box's recent service logs for
 * support. Every secret value (tokens, passwords, keys, connection-string
 * credentials, PEM private keys) is redacted by the orchestrator BEFORE the
 * bundle leaves the appliance — the copy says so, so the owner knows what
 * they're sharing.
 *
 * Tokens only (dp-card / type-*, text-label-*, system-red/green, accent). No
 * hardcoded colors, no emoji, sentence-case copy. The single button transition
 * is the shared `transition-colors` (250ms ease) — no bespoke motion, so
 * prefers-reduced-motion needs no special handling here.
 */

/** Time-range options for the look-back window, in hours. */
const RANGE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Last hour" },
  { value: 24, label: "Last 24 hours" },
  { value: 72, label: "Last 3 days" },
  { value: 168, label: "Last 7 days" },
];

export function LogsSection() {
  const [windowHours, setWindowHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);

  const handleDownload = async () => {
    setError(null);
    setDoneAt(null);
    setBusy(true);
    try {
      const blob = await downloadLogBundle({ windowHours });
      // Hand the archive to the browser's download plumbing.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `droplet-diagnostics-${stamp}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setDoneAt(Date.now());
    } catch {
      // Never surface the raw bridge/route failure — show a calm, actionable
      // line instead.
      setError(
        "Couldn't prepare the diagnostics bundle. The device may be busy — try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-10">
      <h2 className="type-footnote text-label-secondary uppercase tracking-wider px-1 mb-2">
        Diagnostics
      </h2>

      <div className="dp-card p-4 space-y-4">
        <div className="flex items-center gap-2.5">
          <FileText size={16} className="text-label-secondary" />
          <div>
            <p className="type-headline text-label-primary">Download logs</p>
            <p className="type-caption-1 text-label-tertiary mt-0.5">
              A zip of recent service logs to share with support. Tokens,
              passwords and keys are removed before it leaves your Droplet.
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex flex-col gap-1.5 sm:w-56">
            <label
              htmlFor="logs-range"
              className="type-caption-1 text-label-secondary px-0.5"
            >
              Time range
            </label>
            <select
              id="logs-range"
              value={windowHours}
              onChange={(e) => setWindowHours(Number(e.target.value))}
              disabled={busy}
              className="dp-input"
            >
              {RANGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={handleDownload}
            disabled={busy}
            className="dp-btn-primary type-subheadline !min-h-[40px] inline-flex items-center gap-2 disabled:opacity-60"
          >
            <Download size={15} />
            {busy ? "Preparing…" : "Download logs"}
          </button>
        </div>

        {error && (
          <p
            role="alert"
            className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
          >
            {error}
          </p>
        )}
        {doneAt && !error && (
          <p className="type-footnote text-system-green flex items-center gap-1">
            <Check size={14} /> Your download has started
          </p>
        )}
      </div>
    </section>
  );
}
