"use client";
import { ThemedDateInput } from "@/components/ui/ThemedDateInput";


// Cycles (sprints) — the planning half of Projects, WARP-3521. Replaces the
// "Cycles aren't ready yet" placeholder (design brief §3.7).
//
//   list    active / upcoming / completed, each with dates and a progress bar
//   detail  burndown, the cycle's own board/list, and backlog planning
//
// Dates are CALENDAR dates (`YYYY-MM-DD`): every one goes through ./date-only,
// never `new Date()` (WARP-3372). Writes are hidden, not disabled, for read-only
// roles (brief §2.11), and drag-and-drop always has a keyboard alternative
// (brief §5.5).

import { useEffect, useId, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "./icons";
import { EmptyBlock, PriorityFlag, SafetyChip, Skel } from "./bits";
import { BoardView, ListView, type Domain } from "./board";
import { NewItemModal } from "./modals";
import { BurndownChart } from "./BurndownChart";
import {
  CYCLE_STATUS_LABEL,
  CycleStatusBadge,
  ProgressBar,
  progressText,
  type ProgressMode,
} from "./planning-bits";
import { dayDiff, daysLeftLabel, fmtRange } from "./date-only";
import { useFocusAfterRemoval } from "./focus-after-removal";
import {
  pmActions,
  useBacklog,
  useCycleBurndown,
  useCycleItems,
  useProjectCycles,
} from "./usePm";
import type { PmBurndown, PmCycle, PmPlanningProgress, PmProject, PmState, PmWorkItem } from "./types";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export interface CycleFormValues {
  name: string;
  start: string;
  end: string;
}

/** The form's own rules, the same three the server enforces — so the owner hears
 *  about them before the request, in the copy the brief gives. */
export function validateCycleForm(v: CycleFormValues): { name?: string; dates?: string } {
  const errors: { name?: string; dates?: string } = {};
  if (!v.name.trim()) errors.name = "Name can't be empty.";
  if (v.start && v.end) {
    const span = dayDiff(v.start, v.end);
    if (span < 0) errors.dates = "End date can't be before the start date.";
    else if (span + 1 > 366) errors.dates = "A cycle can run for at most a year.";
  }
  return errors;
}

/** A completed cycle's attached items are all finished by construction, so its
 *  own bar would read a trivial 100%. The work it carried over counts toward what
 *  it set out to do. */
export function progressForCard(cycle: PmCycle): PmPlanningProgress {
  return cycle.status === "completed"
    ? { ...cycle.progress, total: cycle.progress.total + cycle.carriedOverCount }
    : cycle.progress;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** `completedAt` is an INSTANT, so the viewer's local day is the right one to show. */
function localDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Small form pieces ────────────────────────────────────────────────────────

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="pm-field" style={{ marginBottom: 14 }}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <div role="alert" style={{ fontSize: 11.5, color: "var(--err)", marginTop: 4 }}>
          {error}
        </div>
      ) : hint ? (
        <div style={{ fontSize: 11.5, color: "var(--text-4)", marginTop: 4 }}>{hint}</div>
      ) : null}
    </div>
  );
}

function Footer({
  onClose,
  onSubmit,
  submitLabel,
  busy,
}: {
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
}): JSX.Element {
  return (
    <div
      className="pm-row"
      style={{ justifyContent: "space-between", gap: 8, padding: "14px 0 0", borderTop: "1px solid var(--border)", marginTop: 16 }}
    >
      <SafetyChip tier="write" />
      <div className="pm-row" style={{ gap: 8 }}>
        <button className="pm-btn" type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="pm-btn primary" type="button" onClick={onSubmit} disabled={busy}>
          {busy ? "Working…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── New / edit cycle ─────────────────────────────────────────────────────────

function CycleFormDialog({
  project,
  cycle,
  onClose,
  onSaved,
}: {
  project: PmProject;
  cycle: PmCycle | null;
  onClose: () => void;
  onSaved: (c: PmCycle) => void;
}): JSX.Element {
  const titleId = useId();
  const nameId = useId();
  const descId = useId();
  const startId = useId();
  const endId = useId();
  const { toast } = useToast();
  // A completed cycle's dates are history — the burndown and every "which sprint
  // was that" question read them. Its name and description stay editable.
  const locked = cycle?.status === "completed";
  const [name, setName] = useState(cycle?.name ?? "");
  const [desc, setDesc] = useState(cycle?.description ?? "");
  const [start, setStart] = useState(cycle?.startDate ?? "");
  const [end, setEnd] = useState(cycle?.endDate ?? "");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const errors = validateCycleForm({ name, start, end });

  const submit = async () => {
    setTried(true);
    if (busy || errors.name || errors.dates) return;
    setBusy(true);
    try {
      const actions = pmActions();
      const res = cycle
        ? await actions.updateCycle(cycle.id, {
            name: name.trim(),
            description: desc.trim() || null,
            ...(locked ? {} : { start_date: start || null, end_date: end || null }),
          })
        : await actions.createCycle(project.id, {
            name: name.trim(),
            ...(desc.trim() ? { description: desc.trim() } : {}),
            ...(start ? { start_date: start } : {}),
            ...(end ? { end_date: end } : {}),
          });
      toast(cycle ? "Cycle saved" : "Cycle created", "success");
      onSaved(res.cycle);
      onClose();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>
          {cycle ? "Edit cycle" : "New cycle"}
        </h2>
        <Field label="Name" htmlFor={nameId} error={tried ? errors.name : undefined}>
          <input
            id={nameId}
            className="pm-input"
            placeholder="e.g. Sprint 12"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Description" htmlFor={descId}>
          <textarea
            id={descId}
            className="pm-input"
            placeholder="Add a description"
            rows={2}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </Field>
        <div className="pm-row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <Field label="Start date" htmlFor={startId}>
              <ThemedDateInput
                id={startId}
                className="pm-input pm-mono"
                type="date"
                value={start}
                disabled={locked}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="End date" htmlFor={endId} error={tried || start || end ? errors.dates : undefined}>
              <ThemedDateInput
                id={endId}
                className="pm-input pm-mono"
                type="date"
                value={end}
                disabled={locked}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
          </div>
        </div>
        {locked && (
          <div style={{ fontSize: 11.5, color: "var(--text-4)", marginTop: -6 }}>
            A completed cycle&apos;s dates are fixed.
          </div>
        )}
        <Footer
          onClose={onClose}
          onSubmit={submit}
          submitLabel={cycle ? "Save" : "Create cycle"}
          busy={busy}
        />
      </div>
    </Dialog>
  );
}

// ── Complete a cycle ─────────────────────────────────────────────────────────

function CompleteCycleDialog({
  cycle,
  others,
  onClose,
  onDone,
}: {
  cycle: PmCycle;
  /** Every other cycle that can still take work. */
  others: PmCycle[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const titleId = useId();
  const selectId = useId();
  const { toast } = useToast();
  const unfinished = Math.max(0, cycle.progress.total - cycle.progress.completed - cycle.progress.cancelled);
  const [target, setTarget] = useState("backlog");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await pmActions().completeCycle(cycle.id, unfinished === 0 ? "backlog" : target);
      const destination = res.moved.to
        ? (others.find((o) => o.id === res.moved.to)?.name ?? "another cycle")
        : "Backlog";
      toast(
        res.moved.count > 0 ? `Cycle completed · ${res.moved.count} moved to ${destination}` : "Cycle completed",
        "success",
      );
      onDone();
      onClose();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 12px", fontSize: 18, fontWeight: 600 }}>
          Complete {cycle.name}
        </h2>
        <p style={{ margin: "0 0 14px", fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.5 }}>
          {unfinished > 0
            ? `${unfinished} unfinished ${plural(unfinished, "item", "items")} will move out of this cycle. Finished items stay as a record of what it delivered.`
            : "Everything in this cycle is finished."}
        </p>
        {unfinished > 0 && (
          <Field label="Move unfinished items to" htmlFor={selectId}>
            <ThemedSelect id={selectId} className="pm-input" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="backlog">Backlog</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {CYCLE_STATUS_LABEL[o.status]}
                </option>
              ))}
            </ThemedSelect>
          </Field>
        )}
        <Footer onClose={onClose} onSubmit={submit} submitLabel="Complete cycle" busy={busy} />
      </div>
    </Dialog>
  );
}

// ── The cycle list ───────────────────────────────────────────────────────────

function CycleCard({ cycle, onOpen }: { cycle: PmCycle; onOpen: (c: PmCycle) => void }): JSX.Element {
  const metaId = useId();
  const progress = progressForCard(cycle);
  const left = cycle.status === "active" ? daysLeftLabel(cycle.endDate) : null;
  const done = cycle.status === "completed";
  return (
    <div
      className="pm-card pm-cycle-card"
      role="button"
      tabIndex={0}
      aria-label={`${cycle.name}, ${CYCLE_STATUS_LABEL[cycle.status]}`}
      // A button's children are presentational to a screen reader, so the dates and
      // the progress words ride along as its description (brief §5.5).
      aria-describedby={`${metaId}-dates ${metaId}-progress`}
      onClick={() => onOpen(cycle)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(cycle);
        }
      }}
    >
      <div className="pm-row pm-cycle-head">
        <span className="pm-cycle-name">{cycle.name}</span>
        <CycleStatusBadge status={cycle.status} />
      </div>
      <div className="pm-cycle-meta" id={`${metaId}-dates`}>
        <span className="pm-mono">{fmtRange(cycle.startDate, cycle.endDate)}</span>
        {left ? ` · ${left}` : ""}
      </div>
      <ProgressBar progress={progress} label={cycle.name} tone={done ? "ok" : "accent"} />
      <div className="pm-cycle-figures" id={`${metaId}-progress`}>
        <span>{progressText(progress)}</span>
        {!done && cycle.progress.totalEstimate > 0 && <span className="pm-mono">{progressText(progress, "estimate")}</span>}
      </div>
      {done && (
        <div className="pm-cycle-meta">
          {localDay(cycle.completedAt) ? `Completed ${localDay(cycle.completedAt)}` : "Completed"}
          {cycle.carriedOverCount > 0 ? ` · ${cycle.carriedOverCount} moved on` : ""}
        </div>
      )}
    </div>
  );
}

function CycleSection({
  title,
  cycles,
  onOpen,
}: {
  title: string;
  cycles: PmCycle[];
  onOpen: (c: PmCycle) => void;
}): JSX.Element | null {
  if (cycles.length === 0) return null;
  return (
    <section className="pm-cycle-section" aria-label={title}>
      <div className="pm-sect" style={{ marginBottom: 10 }}>
        {title} <span className="sx">{cycles.length}</span>
      </div>
      <div className="pm-cycle-grid">
        {cycles.map((c) => (
          <CycleCard key={c.id} cycle={c} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

// ── Burndown panel ───────────────────────────────────────────────────────────

function BurndownPanel({
  burndown,
  error,
  isLoading,
  onRetry,
}: {
  burndown: PmBurndown | undefined;
  error: unknown;
  isLoading: boolean;
  onRetry: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<ProgressMode>("count");
  const effective: ProgressMode = burndown?.hasEstimates ? mode : "count";
  return (
    <section className="pm-surface pm-cycle-panel" aria-label="Burndown">
      <div className="pm-row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <div className="pm-sect">Burndown</div>
        {burndown?.hasEstimates && (
          <div className="pm-pills" role="group" aria-label="Burndown unit">
            {(["count", "estimate"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={effective === m ? "on" : ""}
                aria-pressed={effective === m}
                onClick={() => setMode(m)}
              >
                {m === "count" ? "Items" : "Points"}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && !burndown ? (
        <EmptyBlock
          icon="alert"
          tone="error"
          heading="Couldn't load the burndown."
          body="Check the appliance connection and try again."
          cta={
            <button className="pm-btn ghost" type="button" onClick={onRetry}>
              Try again
            </button>
          }
        />
      ) : isLoading && !burndown ? (
        <Skel w="100%" h={220} r={10} />
      ) : burndown && burndown.days.length === 0 ? (
        <EmptyBlock icon="target" heading="No burndown yet." body="Set a start and end date to see the burndown." />
      ) : burndown ? (
        <BurndownChart burndown={burndown} mode={effective} />
      ) : null}
    </section>
  );
}

// ── Backlog planning ─────────────────────────────────────────────────────────

function BacklogPanel({
  cycle,
  readOnly,
  items,
  total,
  error,
  isLoading,
  busyIds,
  onAdd,
  onRetry,
  onOpenItem,
  onDragStart,
  onDragEnd,
}: {
  cycle: PmCycle;
  readOnly: boolean;
  items: PmWorkItem[] | undefined;
  total: number | undefined;
  error: unknown;
  isLoading: boolean;
  busyIds: ReadonlySet<string>;
  onAdd: (item: PmWorkItem) => void;
  onRetry: () => void;
  onOpenItem: (item: PmWorkItem) => void;
  onDragStart: (item: PmWorkItem) => void;
  onDragEnd: () => void;
}): JSX.Element {
  const list = items ?? [];
  // Adding an item removes its row; keyboard focus must not fall to <body> with it.
  const focus = useFocusAfterRemoval(list, busyIds);
  return (
    <section className="pm-surface pm-cycle-panel" aria-label="Backlog">
      <div className="pm-sect pm-focus-target" tabIndex={-1} ref={focus.headingRef} style={{ marginBottom: 4 }}>
        Backlog <span className="sx">{total ?? list.length}</span>
      </div>
      {!readOnly && (
        <p className="pm-cycle-hint">Drag items into the cycle, or use Add to cycle.</p>
      )}
      {error && !items ? (
        <EmptyBlock
          icon="alert"
          tone="error"
          heading="Couldn't load the backlog."
          body="Check the appliance connection and try again."
          cta={
            <button className="pm-btn ghost" type="button" onClick={onRetry}>
              Try again
            </button>
          }
        />
      ) : isLoading && !items ? (
        <div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="pm-row" style={{ gap: 10, padding: "10px 2px", borderBottom: "1px solid var(--border)" }}>
              <Skel w={52} h={11} />
              <Skel w="60%" h={12} />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyBlock icon="inbox" heading="The backlog is empty." body="Everything unfinished is already in a cycle." />
      ) : (
        <div>
          {list.map((item) => {
            const busy = busyIds.has(item.id);
            return (
              <div
                key={item.id}
                className="pm-backlog-row"
                draggable={!readOnly}
                onDragStart={(e) => {
                  e.dataTransfer?.setData("text/plain", item.id);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                  onDragStart(item);
                }}
                onDragEnd={onDragEnd}
              >
                <span className="pm-mono pm-backlog-key">{item.key}</span>
                <span className="pm-dot" style={{ background: item.state?.color ?? "var(--text-4)" }} />
                <PriorityFlag p={item.priority} size={12} />
                <button type="button" className="pm-backlog-name" onClick={() => onOpenItem(item)}>
                  {item.name}
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    className="pm-btn sm"
                    ref={focus.rowRef(item.id)}
                    disabled={busy}
                    aria-label={`Add ${item.key} to ${cycle.name}`}
                    onClick={(e) => {
                      focus.arm(item.id, e.currentTarget);
                      onAdd(item);
                    }}
                  >
                    {busy ? "Adding…" : "Add to cycle"}
                  </button>
                )}
              </div>
            );
          })}
          {total !== undefined && total > list.length && (
            <p className="pm-cycle-hint" style={{ marginTop: 8 }}>
              Showing {list.length} of {total}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ── The cycle detail ─────────────────────────────────────────────────────────

function CycleDetail({
  cycle,
  allCycles,
  project,
  states,
  readOnly,
  onBack,
  onOpenItem,
  onChanged,
  refreshCycles,
}: {
  cycle: PmCycle;
  allCycles: PmCycle[];
  project: PmProject;
  states: PmState[];
  readOnly: boolean;
  onBack: () => void;
  onOpenItem: (item: PmWorkItem) => void;
  onChanged: () => void;
  refreshCycles: () => Promise<unknown>;
}): JSX.Element {
  const { toast } = useToast();
  const hintId = useId();
  const completed = cycle.status === "completed";
  const itemsQ = useCycleItems(cycle.id);
  const backlogQ = useBacklog(project.id);
  const burnQ = useCycleBurndown(cycle.id);

  const [view, setView] = useState<"board" | "list">("board");
  const [dialog, setDialog] = useState<"edit" | "complete" | "delete" | "newitem" | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [starting, setStarting] = useState(false);

  const canPlan = !readOnly && !completed;
  const items = itemsQ.items;
  const others = allCycles.filter((c) => c.id !== cycle.id && c.status !== "completed");
  const missingDates = !cycle.startDate || !cycle.endDate;
  const left = cycle.status === "active" ? daysLeftLabel(cycle.endDate) : null;

  const refreshAll = async () => {
    await Promise.all([itemsQ.mutate(), backlogQ.mutate(), burnQ.mutate(), refreshCycles()]);
    onChanged();
  };

  const addToCycle = async (item: PmWorkItem) => {
    if (busyIds.has(item.id)) return;
    setBusyIds((s) => new Set(s).add(item.id));
    try {
      await pmActions().setItemCycle(item.id, cycle.id);
      await refreshAll();
      setAnnounce(`Added ${item.key} to ${cycle.name}.`);
    } catch (e) {
      toast(translateError(e, "projects"), "error");
      setAnnounce(`Couldn't add ${item.key} — try again.`);
    } finally {
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  };

  const onTransition = async (item: PmWorkItem, stateId: string) => {
    try {
      await pmActions().transitionItem(item.id, stateId);
      await refreshAll();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    }
  };

  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await pmActions().startCycle(cycle.id);
      toast("Cycle started", "success");
      await refreshAll();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setStarting(false);
    }
  };

  const remove = async () => {
    try {
      await pmActions().deleteCycle(cycle.id);
      toast("Cycle deleted", "success");
      await refreshCycles();
      onChanged();
      onBack();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
      throw e; // ConfirmDialog keeps itself open on a rejection
    }
  };

  const itemsDomain: Domain = itemsQ.isLoading && !items ? "loading" : itemsQ.error && !items ? "error" : "populated";

  return (
    <div className="pm-cycle-detail">
      <button className="pm-btn ghost sm" type="button" onClick={onBack} style={{ alignSelf: "flex-start" }}>
        <PmIcon name="chevL" size={14} /> All cycles
      </button>

      <div className="pm-cycle-detail-head">
        <div style={{ minWidth: 0 }}>
          <div className="pm-row" style={{ gap: 10, flexWrap: "wrap" }}>
            <h2 className="pm-cycle-title">{cycle.name}</h2>
            <CycleStatusBadge status={cycle.status} />
          </div>
          <div className="pm-cycle-meta">
            <span className="pm-mono">{fmtRange(cycle.startDate, cycle.endDate)}</span>
            {left ? ` · ${left}` : ""}
          </div>
          {cycle.description && <p className="pm-cycle-desc">{cycle.description}</p>}
        </div>
        {!readOnly && (
          <div className="pm-row pm-cycle-actions">
            {cycle.status === "draft" && (
              <button
                className="pm-btn primary"
                type="button"
                onClick={start}
                disabled={missingDates || starting}
                aria-describedby={missingDates ? hintId : undefined}
              >
                {starting ? "Working…" : "Start cycle"}
              </button>
            )}
            {cycle.status === "active" && (
              <button className="pm-btn primary" type="button" onClick={() => setDialog("complete")}>
                Complete cycle
              </button>
            )}
            <button className="pm-btn" type="button" onClick={() => setDialog("edit")}>
              Edit
            </button>
            <button className="pm-btn" type="button" onClick={() => setDialog("delete")}>
              Delete
            </button>
          </div>
        )}
      </div>
      {!readOnly && cycle.status === "draft" && missingDates && (
        <p id={hintId} className="pm-cycle-hint">
          Set a start and end date first.
        </p>
      )}

      <div className="pm-cycle-progress">
        <ProgressBar progress={progressForCard(cycle)} label={cycle.name} tone={completed ? "ok" : "accent"} />
        <span className="pm-cycle-figures">{progressText(progressForCard(cycle))}</span>
      </div>

      <BurndownPanel
        burndown={burnQ.burndown}
        error={burnQ.error}
        isLoading={burnQ.isLoading}
        onRetry={() => void burnQ.mutate()}
      />

      <section
        className={"pm-cycle-panel pm-surface" + (over && dragId ? " pm-dropzone" : "")}
        aria-label="Work in this cycle"
        onDragOver={(e) => {
          if (!canPlan || !dragId) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!canPlan) return;
          e.preventDefault();
          const id = e.dataTransfer?.getData("text/plain") || dragId;
          const dropped = (backlogQ.items ?? []).find((i) => i.id === id);
          setOver(false);
          setDragId(null);
          if (dropped) void addToCycle(dropped);
        }}
      >
        <div className="pm-row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <div className="pm-sect">
            Work in this cycle <span className="sx">{itemsQ.total ?? items?.length ?? 0}</span>
          </div>
          <div className="pm-pills" role="group" aria-label="Layout">
            {(["board", "list"] as const).map((v) => (
              <button key={v} type="button" className={view === v ? "on" : ""} aria-pressed={view === v} onClick={() => setView(v)}>
                {v === "board" ? "Board" : "List"}
              </button>
            ))}
          </div>
        </div>
        {itemsDomain === "populated" && items && items.length === 0 ? (
          <EmptyBlock
            icon="inbox"
            heading="No work items in this cycle yet."
            body={canPlan ? "Add some from the backlog." : undefined}
          />
        ) : view === "board" ? (
          <BoardView
            states={states}
            items={items ?? []}
            domain={itemsDomain}
            readOnly={readOnly || completed}
            onOpen={onOpenItem}
            onTransition={onTransition}
            onNewItem={() => setDialog("newitem")}
          />
        ) : (
          <ListView states={states} items={items ?? []} domain={itemsDomain} onOpen={onOpenItem} />
        )}
        {itemsQ.total !== undefined && items && itemsQ.total > items.length && (
          <p className="pm-cycle-hint" style={{ marginTop: 8 }}>
            Showing {items.length} of {itemsQ.total}
          </p>
        )}
      </section>

      {!completed && (
        <BacklogPanel
          cycle={cycle}
          readOnly={readOnly}
          items={backlogQ.items}
          total={backlogQ.total}
          error={backlogQ.error}
          isLoading={backlogQ.isLoading}
          busyIds={busyIds}
          onAdd={(i) => void addToCycle(i)}
          onRetry={() => void backlogQ.mutate()}
          onOpenItem={onOpenItem}
          onDragStart={(i) => setDragId(i.id)}
          onDragEnd={() => {
            setDragId(null);
            setOver(false);
          }}
        />
      )}

      <div role="status" aria-live="polite" className="pm-sr-only">
        {announce}
      </div>

      {dialog === "edit" && (
        <CycleFormDialog
          project={project}
          cycle={cycle}
          onClose={() => setDialog(null)}
          onSaved={() => void refreshAll()}
        />
      )}
      {dialog === "complete" && (
        <CompleteCycleDialog
          cycle={cycle}
          others={others}
          onClose={() => setDialog(null)}
          onDone={() => void refreshAll()}
        />
      )}
      {dialog === "newitem" && (
        <NewItemModal
          project={project}
          cycleId={cycle.id}
          onClose={() => setDialog(null)}
          onCreated={() => void refreshAll()}
        />
      )}
      <ConfirmDialog
        open={dialog === "delete"}
        onCancel={() => setDialog(null)}
        onConfirm={remove}
        title="Delete this cycle?"
        description="Unfinished work goes back to the backlog. Completed items keep their status and lose the cycle association. This can't be undone."
        confirmLabel="Delete cycle"
      />
    </div>
  );
}

// ── The view ─────────────────────────────────────────────────────────────────

export function CyclesView({
  project,
  states,
  readOnly,
  onOpenItem,
  onChanged,
}: {
  project: PmProject;
  states: PmState[];
  readOnly: boolean;
  /** Open the work-item drawer. */
  onOpenItem: (item: PmWorkItem) => void;
  /** After any write that changes items or cycles, so the page refreshes its
   *  board items, counts and cycle chips. */
  onChanged: () => void;
}): JSX.Element {
  const { cycles, error, isLoading, mutate } = useProjectCycles(project.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // A cycle that was deleted (here or elsewhere) while open: back to the list.
  useEffect(() => {
    if (selectedId && cycles && !cycles.some((c) => c.id === selectedId)) setSelectedId(null);
  }, [cycles, selectedId]);

  const selected = cycles?.find((c) => c.id === selectedId) ?? null;

  if (selected && cycles) {
    return (
      <CycleDetail
        cycle={selected}
        allCycles={cycles}
        project={project}
        states={states}
        readOnly={readOnly}
        onBack={() => setSelectedId(null)}
        onOpenItem={onOpenItem}
        onChanged={onChanged}
        refreshCycles={() => mutate()}
      />
    );
  }

  const list = cycles ?? [];
  const active = list.filter((c) => c.status === "active");
  const upcoming = list.filter((c) => c.status === "draft");
  const done = list.filter((c) => c.status === "completed");

  return (
    <div className="pm-cycle-list">
      <div className="pm-row" style={{ justifyContent: "flex-end", gap: 8, marginBottom: 12 }}>
        {!readOnly && (
          <button className="pm-btn primary" type="button" onClick={() => setCreating(true)}>
            <PmIcon name="plus" size={14} /> New cycle
          </button>
        )}
        <button className="pm-btn" type="button" onClick={() => void mutate()} aria-label="Refresh cycles">
          <PmIcon name="refresh" size={15} />
        </button>
      </div>

      {error && !cycles ? (
        <div className="pm-surface" style={{ padding: 8 }}>
          <EmptyBlock
            icon="alert"
            tone="error"
            heading="Couldn't load cycles."
            body="Check the appliance connection and try again."
            cta={
              <button className="pm-btn ghost" type="button" onClick={() => void mutate()}>
                Try again
              </button>
            }
          />
        </div>
      ) : isLoading && !cycles ? (
        <div className="pm-cycle-grid" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="pm-card" style={{ cursor: "default", gap: 10 }}>
              <Skel w="55%" h={14} />
              <Skel w="40%" h={11} />
              <Skel w="100%" h={8} r={4} />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="pm-surface" style={{ padding: 8 }}>
          <EmptyBlock
            icon="target"
            heading="No cycles yet."
            body="Create one to plan a sprint."
            cta={
              !readOnly ? (
                <button className="pm-btn primary" type="button" onClick={() => setCreating(true)}>
                  <PmIcon name="plus" size={14} /> New cycle
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          <CycleSection title="Active" cycles={active} onOpen={(c) => setSelectedId(c.id)} />
          <CycleSection title="Upcoming" cycles={upcoming} onOpen={(c) => setSelectedId(c.id)} />
          <CycleSection title="Completed" cycles={done} onOpen={(c) => setSelectedId(c.id)} />
        </>
      )}

      {creating && (
        <CycleFormDialog
          project={project}
          cycle={null}
          onClose={() => setCreating(false)}
          onSaved={(c) => {
            // Open the new cycle only once the list has it: the effect above
            // sends a selection the list does not know about back to the list.
            void (async () => {
              await mutate();
              onChanged();
              if (c?.id) setSelectedId(c.id);
            })();
          }}
        />
      )}
    </div>
  );
}
