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
  COVERAGE_UNREACHABLE,
  fetchCoverage,
  fetchFindings,
  formatImpact,
  moveFinding,
  type CoverageResult,
  type Finding,
} from "./api";
import { BrainSwitchPanel } from "./BrainSwitchPanel";

const KIND_ICON = {
  loss: TrendingDown,
  risk: AlertTriangle,
  inefficiency: Clock,
  opportunity: CheckCircle2,
  inconsistency: AlertTriangle,
} as const;

function CoverageLine({ result }: { result: CoverageResult }) {
  // WARP-2812 — TWO different offs. "The box did not answer" and "the box
  // answered, and said nothing is running" are not the same sentence. The
  // second used to be unreachable here, because /coverage succeeds whichever
  // way BRAIN_ENABLED is set, so a disabled brain rendered as a working one
  // that had simply not got very far yet.
  //
  // WARP-2838 (review) — and they are now SAID differently too. This line used
  // to fold the unanswered case into "The brain is off. Nothing has been read",
  // which states two facts about a box that told us nothing. A failed read is
  // reported as a failed read.
  if (!result.reached) {
    return (
      <p className="brief-coverage brief-coverage--unknown">
        Could not reach this box to check what the brain has read.
      </p>
    );
  }
  const coverage = result.coverage;
  if (brainIsOff(coverage)) {
    return (
      <p className="brief-coverage">
        The brain is off. Nothing new is being read, and no findings are being produced.
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
  // WARP-2838 (review) — the reachability of the box travels with its body.
  // A bare `Coverage | null` made "the box did not answer" indistinguishable
  // from "the brain is off", and every branch below read the first as the
  // second. The initial value is honest: nothing has been asked yet, and
  // `loading` is what holds the render back until it has.
  const [result, setResult] = useState<CoverageResult>(COVERAGE_UNREACHABLE);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [f, c] = await Promise.all([fetchFindings("new"), fetchCoverage()]);
    setFindings(f.findings);
    setResult(c);
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
      <CoverageLine result={result} />

      {/* WARP-2838 — the switch, not a sentence about one. Held back until the
          first fetch resolves: nothing is known about the box before then, and
          rendering it earlier would flash a consent screen at every owner whose
          brain is already on. */}
      {loading ? null : <BrainSwitchPanel result={result} onChanged={load} />}

      {loading ? (
        <p className="brief-empty">Loading…</p>
      ) : findings.length > 0 ? (
        // 🔴 WARP-2838 (review) — FINDINGS ARE RENDERED WHATEVER THE SWITCH SAYS.
        // The first draft hid this whole section behind `brainIsOff(coverage)`,
        // which is a promise broken in the same screenful it is made:
        // `GET /api/brain/findings` is role-gated, not brain-gated (`listFindings`
        // filters by scope/status/kind and never asks about brain state), so the
        // rows are still there — and the consent copy directly above says "What
        // it has already written stays until you delete it". An owner who turned
        // the brain off would have watched their findings vanish and concluded
        // the box had deleted them.
        <>
          {brainIsOff(result.coverage) ? (
            // Said once, above the list, so the list is not read as live.
            <p className="brief-retained">
              The brain is off. These are the findings it had already written —
              they stay until you delete them, and nothing new is being produced.
            </p>
          ) : null}
          <div className="brief-list">
            {findings.map((f) => (
              <FindingCard key={f.id} finding={f} onMoved={load} />
            ))}
          </div>
        </>
      ) : !result.reached || brainIsOff(result.coverage) ? (
        // Nothing more to say: the panel above IS the state of this page. A
        // second line under it repeating "turn the brain on" would be the
        // dead-end copy this ticket exists to remove, and on an unreachable box
        // "nothing needs your attention" would be a claim nothing supports —
        // the findings read may have failed for the same reason the coverage
        // one did.
        null
      ) : (
        // Two different nothings, said differently. "No findings" on a running
        // brain is good news; on a brain that has never run it is a setup step —
        // and that second case is now the panel above rather than a sentence.
        // The discriminator is `coverage.enabled`, NOT whether the fetch
        // succeeded (WARP-2812): /coverage answers 200 on a box where the brain
        // has never been switched on, so keying on truthiness told every such
        // owner they were all clear.
        <p className="brief-empty">Nothing needs your attention right now.</p>
      )}
    </ShellPage>
  );
}
