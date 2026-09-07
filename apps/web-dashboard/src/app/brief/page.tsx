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

function CoverageLine({ coverage }: { coverage: Coverage | null }) {
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
  // Reached but not read. Clamped at zero: the two counters are incremented in
  // separate statements over the pass's life, and a negative here would render
  // as a nonsense sentence rather than as the accounting slip it would be.
  const passedOver = Math.max(0, (corpus?.unitsSeen ?? 0) - (corpus?.unitsDigested ?? 0));

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
      {/* WARP-2834 — units the pass REACHED but could not read. `unitsSeen`
          advances for every document the loop touched; `unitsDigested` only
          for the ones the model actually read. The gap is documents with no
          extractable text, or whose owner could not be resolved — the
          `__household__` / `__dept_<uuid>__` sentinel owners the file-indexer
          writes for the shared drive.

          Worth its own sentence rather than folding into the count: those
          documents are NOT queued and will not be read on a later tick, so
          leaving them inside "still working through the rest" would be the
          same overstatement in a new place. */}
      {passedOver > 0 ? (
        <p className="brief-coverage-detail">
          <strong>{passedOver.toLocaleString()}</strong>{" "}
          {passedOver === 1 ? "document was" : "documents were"} passed over —
          no readable text, or the box could not tell whose {passedOver === 1 ? "it" : "they"} were.
          {" "}They are not queued for a later pass.
        </p>
      ) : null}
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
      <CoverageLine coverage={coverage} />

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
