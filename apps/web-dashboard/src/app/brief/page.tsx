"use client";

/**
 * WARP-2752 (ADR-051) — `/brief`, where findings land.
 *
 * THE COVERAGE LINE IS THE MOST IMPORTANT THING ON THIS PAGE, and it is placed
 * first for that reason. The corpus pass digests ~240 documents a day by
 * design, so a 5,000-document business is three weeks from first-pass
 * coverage. An operator who assumes the brain has read everything stops
 * trusting it the moment it misses something — so the page states what it has
 * actually read before it states what it thinks.
 *
 * EVERY FINDING SHOWS ITS EVIDENCE. A claim with no traceable source is a
 * hallucination with a row id; the database refuses to store one, and this
 * page refuses to render one without showing where it came from.
 *
 * DISMISSAL REQUIRES A REASON, in the UI as well as in the API. The reason is
 * what lets the next pass tell "a human decided this is fine" from "nobody has
 * looked", and it is the only thing that stops the same finding being raised
 * again next week.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Sparkles, TrendingDown } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import "./brief.css";
import {
  brainIsOff,
  runBrainPass,
  type RunPassOutcome,
  fetchCoverage,
  fetchFindings,
  formatImpact,
  moveFinding,
  type Coverage,
  type Finding,
} from "./api";

const KIND_ICON = {
  loss: TrendingDown,
  risk: AlertTriangle,
  inefficiency: Clock,
  opportunity: CheckCircle2,
  inconsistency: AlertTriangle,
} as const;

/**
 * "Check now" (WARP-2850).
 *
 * PROVISIONAL — the affordance is engineering's, pending design. What is NOT
 * provisional is the copy rule it follows: every refusal here is a different
 * sentence, because they are different answers. Already running is "hold on";
 * switched off is a decision somebody made; too soon is a duty-cycle limit on
 * the box's only inference slot. Collapsing them into "something went wrong"
 * is the failure /admin/sessions had, where a permissions decision read as an
 * outage.
 *
 * It does NOT spin. The pass takes minutes and the request returns in
 * milliseconds — the button reports that a run STARTED, and the coverage line
 * above is where the outcome actually shows up.
 */
function CheckNowButton({
  passKey,
  label,
  running,
  onStarted,
}: {
  passKey: string;
  label: string;
  running: boolean;
  onStarted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const say = (o: RunPassOutcome) => {
    if (o.ok) return "Started. This page will show what it finds.";
    switch (o.reason) {
      case "busy":
        return "Already running — give it a moment.";
      case "disabled":
        return "This check is switched off.";
      case "too_soon":
        return o.retryAfterSeconds
          ? `Just ran. Try again in about ${Math.ceil(o.retryAfterSeconds / 60)} min.`
          : "Just ran — try again shortly.";
      case "off":
        return "The brain is off, so there is nothing to run.";
      default:
        return "Could not start it. Nothing was changed.";
    }
  };

  const click = useCallback(async () => {
    setBusy(true);
    setSaid(null);
    const out = await runBrainPass(passKey).catch(
      (): RunPassOutcome => ({ ok: false, reason: "failed" }),
    );
    setBusy(false);
    setSaid(say(out));
    if (out.ok) onStarted();
  }, [passKey, onStarted]);

  return (
    <span className="brief-checknow">
      <button type="button" disabled={busy || running} onClick={() => void click()}>
        {running ? `${label}: running…` : busy ? "Starting…" : label}
      </button>
      {said ? <span className="brief-checknow-said">{said}</span> : null}
    </span>
  );
}

function CoverageLine({
  coverage,
  onStarted,
}: {
  coverage: Coverage | null;
  onStarted: () => void;
}) {
  // WARP-2812 — TWO different offs. `coverage === null` is "the box did not
  // answer"; `enabled === false` is "the box answered, and said nothing is
  // running". The second used to be unreachable here, because /coverage
  // succeeds whichever way BRAIN_ENABLED is set, so a disabled brain rendered
  // as a working one that had simply not got very far yet.
  // `!coverage` is spelled out rather than left to brainIsOff so TypeScript
  // narrows `coverage` for the rest of this function; a predicate hidden
  // behind a call does not narrow at the call site.
  if (!coverage || brainIsOff(coverage)) {
    return (
      <p className="brief-coverage">
        The brain is off. Nothing has been read, and no findings are being produced.
      </p>
    );
  }
  const { documentsReady, documentsDigested } = coverage.corpus;
  const detectors = coverage.passes.find((p) => p.passKey === "detectors");
  const corpus = coverage.passes.find((p) => p.passKey === "corpus.documents");

  return (
    <div className="brief-coverage">
      <p>
        Read <strong>{documentsDigested.toLocaleString()}</strong> of{" "}
        <strong>{documentsReady.toLocaleString()}</strong> indexed documents
        {/* Only a scheduled pass is "still working". With no BrainPass rows the
            remainder is not queued, it is untouched. */}
        {documentsReady > documentsDigested
          ? coverage.passes.length > 0
            ? " — still working through the rest."
            : " — the rest is not queued to be read."
          : "."}
      </p>
      {/* WARP-2850 — the two checks an operator can ask for by hand. Separate
          buttons because they are separate things: one reads business records
          and is instant, the other reads documents through the model and
          competes with chat for the box's only inference slot. */}
      <p className="brief-coverage-actions">
        <CheckNowButton
          passKey="detectors"
          label="Check records now"
          running={detectors?.runState === "running"}
          onStarted={onStarted}
        />
        <CheckNowButton
          passKey="corpus.documents"
          label="Read more documents"
          running={corpus?.runState === "running"}
          onStarted={onStarted}
        />
      </p>
      <p className="brief-coverage-detail">
        {detectors?.lastSucceededAt
          ? `Business records last checked ${new Date(detectors.lastSucceededAt).toLocaleString()}.`
          : "Business records have not been checked yet."}
        {corpus?.lastError ? ` Last document pass errored: ${corpus.lastError}` : ""}
        {detectors?.lastError ? ` Last records pass errored: ${detectors.lastError}` : ""}
      </p>
    </div>
  );
}

function FindingCard({
  finding,
  onMoved,
}: {
  finding: Finding;
  onMoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");

  const Icon = KIND_ICON[finding.kind] ?? AlertTriangle;
  const impact = formatImpact(finding.impactMinor, finding.currency);
  const sources = finding.evidence?.sources ?? [];

  const move = useCallback(
    async (status: Finding["status"], dismissedReason?: string) => {
      setBusy(true);
      setError(null);
      const res = await moveFinding(finding.id, { status, dismissedReason });
      setBusy(false);
      if (!res.ok) {
        setError(
          res.error === "dismissal_needs_reason"
            ? "Say why you are dismissing this, so it is not raised again."
            : "Could not update this finding.",
        );
        return;
      }
      onMoved();
    },
    [finding.id, onMoved],
  );

  return (
    <article className={`brief-card brief-card--${finding.kind}`}>
      <header>
        <Icon size={16} aria-hidden />
        <h3>{finding.title}</h3>
        {/* No amount is rendered when the detector could not compute one. A
            zero here would state a number nothing measured. */}
        {impact ? <span className="brief-impact">{impact}</span> : null}
      </header>

      <p className="brief-rationale">{finding.rationale}</p>

      {sources.length > 0 ? (
        <details className="brief-evidence">
          <summary>Why this was raised ({sources.length})</summary>
          <ul>
            {sources.map((s, i) => (
              <li key={`${s.sourceId}-${i}`}>
                <span className="brief-source-kind">{s.sourceKind}</span>
                <q>{s.quote}</q>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {error ? <p className="brief-error">{error}</p> : null}

      {dismissing ? (
        <div className="brief-dismiss">
          <label htmlFor={`reason-${finding.id}`}>Why are you dismissing this?</label>
          <input
            id={`reason-${finding.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. customer is on an agreed payment plan"
          />
          <button type="button" disabled={busy || !reason.trim()} onClick={() => move("dismissed", reason)}>
            Dismiss
          </button>
          <button type="button" onClick={() => setDismissing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="brief-actions">
          <button type="button" disabled={busy} onClick={() => move("acknowledged")}>
            Acknowledge
          </button>
          <button type="button" disabled={busy} onClick={() => move("actioned")}>
            Done
          </button>
          <button type="button" disabled={busy} onClick={() => setDismissing(true)}>
            Dismiss
          </button>
        </div>
      )}
    </article>
  );
}

export default function BriefPage() {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [f, c] = await Promise.all([fetchFindings("new"), fetchCoverage()]);
    setFindings(f.findings);
    setCoverage(c);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ShellPage
      icon={<Sparkles size={15} />}
      label="Brief"
      title="Brief"
      sub="What the box noticed about your business"
    >
      <CoverageLine coverage={coverage} onStarted={load} />

      {loading ? (
        <p className="brief-empty">Loading…</p>
      ) : findings.length === 0 ? (
        // Two different nothings, said differently. "No findings" on a running
        // brain is good news; on a brain that has never run it is a setup step.
        // The discriminator is `coverage.enabled`, NOT whether the fetch
        // succeeded (WARP-2812): /coverage answers 200 on a box where the brain
        // has never been switched on, so keying on truthiness told every such
        // owner they were all clear.
        <p className="brief-empty">
          {!brainIsOff(coverage)
            ? "Nothing needs your attention right now."
            : "Turn the brain on to start reading your business."}
        </p>
      ) : (
        <div className="brief-list">
          {findings.map((f) => (
            <FindingCard key={f.id} finding={f} onMoved={load} />
          ))}
        </div>
      )}
    </ShellPage>
  );
}
