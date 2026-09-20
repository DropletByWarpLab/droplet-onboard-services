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
  COVERAGE_UNREACHABLE,
  fetchCoverage,
  fetchFindings,
  formatImpact,
  moveFinding,
  type CoverageResult,
  type Finding,
} from "./api";
import { BrainSwitchPanel } from "./BrainSwitchPanel";

/**
 * How often to re-read coverage WHILE a pass holds the lease (WARP-2850
 * review).
 *
 * `/brief` is otherwise a load-once page, and it stays one: this interval is
 * armed only while the box says something is running, and torn down the moment
 * it stops. Without it the "check now" control was terminal — `runState` came
 * from the mount fetch and the one refresh right after the 202, and a corpus
 * pass runs for MINUTES after that, so the button sat disabled on "running…"
 * long past completion until somebody reloaded the page.
 *
 * Ten seconds is chosen against the thing being waited on, not against a feel:
 * the detector pass is bounded SQL that finishes in seconds. The upper bound on
 * the polling itself is the lease — a worker that dies leaves `running` until
 * the 15-minute expiry, so the worst case is two cheap GETs every ten seconds
 * for fifteen minutes, on a tab somebody left open.
 */
const RUNNING_POLL_MS = 10_000;

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
      case "missing":
        // NOT "already running". Nothing is running, and no amount of waiting
        // will change that — the row is created at boot, so a restart is the
        // actual next step.
        return "This check is not set up on this box. Restarting it will add it.";
      case "no_model":
        // The brain can be on while no model is configured; they are separate
        // switches. Saying "busy" here sends somebody away to wait for a run
        // that cannot happen.
        return "No AI model is set up yet, so there is nothing to read with.";
      case "shutting_down":
        return "The box is restarting. Try again in a moment.";
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
  result,
  onStarted,
}: {
  result: CoverageResult;
  onStarted: () => void;
}) {
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
          same overstatement in a new place.

          ONE STRING PER COUNT, not four switches inside one sentence. The
          noun, its verb, the possessive pronoun and the sentence that
          follows all turn on the same number. The first draft spread them
          across independent ternaries and two of the four were never
          switched, so a single passed-over document read "whose it were …
          They are not queued". Held together as one string per count so the
          agreement cannot come apart again; pinned in
          `__tests__/brief.coverage-passed-over.test.tsx`. */}
      {passedOver > 0 ? (
        <p className="brief-coverage-detail">
          <strong>{passedOver.toLocaleString()}</strong>{" "}
          {passedOver === 1
            ? "document was passed over — no readable text, or the box could not tell whose it was. It is not queued for a later pass."
            : "documents were passed over — no readable text, or the box could not tell whose they were. They are not queued for a later pass."}
        </p>
      ) : null}
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

  // Derived to a BOOLEAN before it reaches the dependency array. `coverage` is
  // a fresh object on every poll, so depending on it would tear the interval
  // down and build a new one each time — the countdown would restart forever
  // and, when nothing is running, the effect would still churn.
  // WARP-2838 — reads through `result`, which is what this component now
  // holds. An unreached box has `coverage: null`, and "we could not ask" is
  // correctly not "a pass is running".
  const passRunning = result.coverage?.passes.some((p) => p.runState === "running") ?? false;
  useEffect(() => {
    if (!passRunning) return;
    const timer = setInterval(() => void load(), RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [passRunning, load]);

  return (
    <ShellPage
      icon={<Sparkles size={15} />}
      label="Brief"
      title="Brief"
      sub="What the box noticed about your business"
    >
      <CoverageLine result={result} onStarted={load} />

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
              they stay until you delete them, nothing new is being produced,
              and the assistant is no longer using them in chat.
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
