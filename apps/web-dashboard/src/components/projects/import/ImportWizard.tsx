"use client";

// Import work items (WARP-3527): upload → source preset → mapping table →
// preview of the first 20 rows → run with progress → summary.
//
// The wizard holds a JOB (the server's record of this import) and an ANALYSIS
// (what the server would do with the file as mapped right now). Every change
// to the source or the mapping is a PATCH that returns a fresh analysis, so
// the preview is the server's own plan rather than the browser's guess, and
// "Start import" runs exactly what was previewed. The run itself happens in
// the background on the appliance: closing this window does not stop it, and
// opening the wizard again while one is running lands back on its progress.

import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { SafetyChip, Skel } from "../bits";
import type { PmProject } from "../types";
import { MappingStep, PreviewStep, RunStep, SourceStep, UploadStep } from "./steps";
import type { ImportAnalysis, ImportJob, ImportMapping, ImportSource } from "./types";
import { ACTIVE_STATUSES, FINAL_STATUSES } from "./types";
import { ImportRequestError, importApi, useJobPolling } from "./useImport";
import "./import.css";

type Step = "upload" | "source" | "mapping" | "preview" | "run";

const STEPS: Array<[Step, string]> = [
  ["upload", "Choose a file"],
  ["source", "Source"],
  ["mapping", "Match columns"],
  ["preview", "Preview"],
  ["run", "Import"],
];

const messageOf = (e: unknown): string =>
  e instanceof ImportRequestError ? e.message : "Something went wrong. Try again.";

const problemsOf = (e: unknown): string[] => (e instanceof ImportRequestError ? e.problems : []);

export function ImportWizard({
  project,
  onClose,
  onFinished,
}: {
  project: PmProject;
  onClose: () => void;
  /** Called when the board should reload (an import finished, or the window closed). */
  onFinished: () => void;
}): JSX.Element {
  const titleId = useId();
  const [step, setStep] = useState<Step>("upload");
  const [job, setJob] = useState<ImportJob | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const patchSeq = useRef(0);
  const notified = useRef<string | null>(null);

  // Opening the wizard while an import is running lands on its progress.
  useEffect(() => {
    let live = true;
    importApi
      .list(project.id)
      .then(({ jobs }) => {
        if (!live) return;
        const active = jobs.find((j) => ACTIVE_STATUSES.includes(j.status));
        if (active) {
          setJob(active);
          setStep("run");
        }
      })
      .catch(() => {
        /* no history is not an error: start from the upload step */
      })
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [project.id]);

  // A poll that was already in flight when Cancel (or the end of the run) landed
  // answers with the OLD status. A job only moves forward on its own, so a late
  // "still running" never overwrites a final status; Run again sets the job
  // directly from its own response, not through here.
  const onPolled = useCallback(
    (next: ImportJob) =>
      setJob((prev) =>
        prev && prev.id === next.id && FINAL_STATUSES.includes(prev.status) && ACTIVE_STATUSES.includes(next.status)
          ? prev
          : next,
      ),
    [],
  );
  useJobPolling(job?.id ?? null, step === "run" && job ? job.status : null, onPolled);

  // Reload the board once, when a run reaches a final status.
  useEffect(() => {
    if (!job || step !== "run") return;
    if (ACTIVE_STATUSES.includes(job.status) || job.status === "PREVIEWED") return;
    const stamp = `${job.id}:${job.status}`;
    if (notified.current === stamp) return;
    notified.current = stamp;
    onFinished();
  }, [job, step, onFinished]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
      setProblems(problemsOf(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const onFile = (file: File) =>
    void guard(async () => {
      const r = await importApi.upload(project.id, file);
      setJob(r.job);
      setAnalysis(r.analysis);
      setStep("source");
    });

  const pickSource = (source: ImportSource) =>
    void guard(async () => {
      if (!job) return;
      const r = await importApi.patch(job.id, { source });
      setJob(r.job);
      setAnalysis(r.analysis);
    });

  // Mapping edits show at once and are sent as they happen; a late reply for an
  // older edit is dropped, so the screen never snaps back to a stale plan.
  const changeMapping = (next: ImportMapping) => {
    if (!job || !analysis) return;
    setAnalysis({ ...analysis, mapping: next });
    setError(null);
    setProblems([]);
    const seq = (patchSeq.current += 1);
    importApi
      .patch(job.id, { mapping: next })
      .then((r) => {
        if (seq !== patchSeq.current) return;
        setJob(r.job);
        setAnalysis(r.analysis);
      })
      .catch((e: unknown) => {
        if (seq !== patchSeq.current) return;
        setError(messageOf(e));
        setProblems(problemsOf(e));
      });
  };

  const start = () =>
    void guard(async () => {
      if (!job || !analysis) return;
      const r = await importApi.run(job.id, analysis.mapping);
      setJob(r.job);
      setStep("run");
    });

  const runAgain = () =>
    void guard(async () => {
      if (!job) return;
      const r = await importApi.run(job.id);
      notified.current = null;
      setJob(r.job);
    });

  const cancel = () =>
    void guard(async () => {
      if (!job) return;
      const r = await importApi.cancel(job.id);
      setJob(r.job);
    });

  const close = () => {
    onFinished();
    onClose();
  };

  const stepIndex = STEPS.findIndex(([s]) => s === step);
  const titleBound = (analysis?.mapping.columns.name?.length ?? 0) > 0;
  const nothingToDo = analysis ? analysis.counts.create + analysis.counts.update === 0 : true;
  const running = job !== null && ACTIVE_STATUSES.includes(job.status);

  return (
    <Dialog open onClose={close} placement="center" maxWidth="2xl" labelledBy={titleId} closeOnBackdrop={false} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 600 }}>
          Import work items
        </h2>
        <p className="pm-imp-sub" style={{ marginBottom: 14 }}>
          Into {project.name} · <span className="pm-mono">{project.identifier}</span>
        </p>

        <ol className="pm-imp-steps" aria-label="Progress">
          {STEPS.map(([s, label], i) => (
            <li
              key={s}
              className={"pm-imp-step" + (i === stepIndex ? " on" : i < stepIndex ? " done" : "")}
              aria-current={i === stepIndex ? "step" : undefined}
            >
              <span className="num" aria-hidden>
                {i + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>

        {checking ? (
          <div aria-busy="true">
            <Skel h={16} w="40%" />
            <Skel h={92} r={14} style={{ marginTop: 12 }} />
          </div>
        ) : (
          <>
            {step === "upload" && <UploadStep busy={busy} onFile={onFile} />}
            {step === "source" && analysis && <SourceStep analysis={analysis} busy={busy} onPick={pickSource} />}
            {step === "mapping" && analysis && <MappingStep analysis={analysis} onChange={changeMapping} />}
            {step === "preview" && analysis && <PreviewStep analysis={analysis} />}
            {step === "run" && job && <RunStep job={job} />}
          </>
        )}

        {error && (
          <div className="pm-imp-error" role="alert">
            {error}
            {problems.length > 0 && (
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="pm-imp-foot">
          <span>{step === "preview" && <SafetyChip tier="write" />}</span>
          <div className="pm-row" style={{ gap: 8 }}>
            {step === "upload" && (
              <button className="pm-btn" type="button" onClick={close}>
                Cancel
              </button>
            )}
            {step === "source" && (
              <>
                <button className="pm-btn" type="button" onClick={() => setStep("upload")} disabled={busy}>
                  Choose another file
                </button>
                <button className="pm-btn primary" type="button" onClick={() => setStep("mapping")} disabled={busy}>
                  Continue
                </button>
              </>
            )}
            {step === "mapping" && (
              <>
                <button className="pm-btn" type="button" onClick={() => setStep("source")}>
                  Back
                </button>
                <button
                  className="pm-btn primary"
                  type="button"
                  onClick={() => setStep("preview")}
                  disabled={!titleBound}
                  title={titleBound ? undefined : "Choose a column for the title first"}
                >
                  Continue to preview
                </button>
              </>
            )}
            {step === "preview" && (
              <>
                <button className="pm-btn" type="button" onClick={() => setStep("mapping")} disabled={busy}>
                  Back to columns
                </button>
                <button
                  className="pm-btn primary"
                  type="button"
                  onClick={start}
                  disabled={busy || nothingToDo}
                  title={nothingToDo ? "There is nothing in this file to import" : undefined}
                >
                  {busy ? "Working…" : "Start import"}
                </button>
              </>
            )}
            {step === "run" && job && (
              <>
                {running && (
                  <button className="pm-btn" type="button" onClick={cancel} disabled={busy}>
                    Cancel import
                  </button>
                )}
                {job.status === "FAILED" && (
                  <button className="pm-btn primary" type="button" onClick={runAgain} disabled={busy}>
                    {busy ? "Working…" : "Run again"}
                  </button>
                )}
                <button className={"pm-btn" + (job.status === "SUCCEEDED" ? " primary" : "")} type="button" onClick={close}>
                  {job.status === "SUCCEEDED" ? "Done" : "Close"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
