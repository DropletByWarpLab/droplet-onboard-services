"use client";

// The work-item drawer's "Time" section (WARP-3526): total, entries, log time,
// start/stop timer.
//
// A new component with one line in detail.tsx. Which controls are drawn comes
// from `useTimeAccess()` — a reader sees the entries and nothing to press; a
// member may log time, run a timer and change their own entries; an owner or
// admin may change anybody's. The orchestrator enforces the same rules, so this
// only decides what to show.
//
// A direct human write (the design brief §8): the click is the confirm, so there
// is no pending card — the form carries the Write chip, as the comment composer
// beside it does.

import { useId, useRef, useState, type FormEvent, type JSX } from "react";
import { Play, Square } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { PmIcon } from "../icons";
import { Avatar, SafetyChip, Skel, usePerson } from "../bits";
import type { PmWorkItem } from "../types";
import { useTimeAccess } from "./access";
import { DURATION_HELP, timeErrorCopy } from "./copy";
import {
  browserTimeZone,
  entryDay,
  fmtYmd,
  formatClock,
  formatMinutes,
  parseDuration,
  startedAtForDay,
  ymdInZone,
} from "./format";
import type { PmTimeItemRef, PmWorklog } from "./types";
import { useNow, useRunningTimer, useTimeActions, useWorklogs } from "./useTime";
import "./time.css";

// ── Timer ───────────────────────────────────────────────────────────────────

function TimerControl({ item }: { item: PmWorkItem }): JSX.Element | null {
  const { timer, loaded, error } = useRunningTimer();
  const actions = useTimeActions();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const here = timer?.workItemId === item.id;
  const elsewhere = timer !== null && !here;
  const now = useNow(here ? 1000 : null);

  if (!loaded && !error) return <Skel h={46} r={10} style={{ marginBottom: 8 }} />;

  const start = async (): Promise<void> => {
    const previous = timer;
    setBusy(true);
    try {
      const { stopped } = await actions.startTimer(item.id);
      if (stopped) {
        toast(
          `Logged ${formatMinutes(stopped.minutes)} on ${previous?.workItem.key ?? "the other item"}.`,
          "info",
        );
      }
    } catch (e) {
      toast(timeErrorCopy(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    setBusy(true);
    try {
      const { worklog, capped } = await actions.stopTimer();
      toast(
        capped
          ? `The timer ran for more than 24 hours, so ${formatMinutes(worklog.minutes)} was logged on ${item.key}. Edit the entry to correct it.`
          : `Logged ${formatMinutes(worklog.minutes)} on ${item.key}.`,
        capped ? "info" : "success",
      );
    } catch (e) {
      toast(timeErrorCopy(e), "error");
    } finally {
      setBusy(false);
    }
  };

  if (here && timer) {
    return (
      <div className="pm-time-timer running">
        <span className="pm-row" style={{ gap: 8 }}>
          <span className="pm-dot" style={{ background: "var(--info)" }} aria-hidden />
          <span role="timer" className="pm-mono" style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
            {formatClock(now - new Date(timer.startedAt).getTime())}
          </span>
          <span style={{ color: "var(--text-3)" }}>Timer running</span>
        </span>
        <button className="pm-btn sm" type="button" onClick={stop} disabled={busy}>
          <Square size={12} aria-hidden />
          {busy ? "Stopping…" : "Stop timer"}
        </button>
      </div>
    );
  }

  return (
    <div className="pm-time-timer">
      <span style={{ color: "var(--text-3)" }}>
        {elsewhere && timer ? (
          <>
            Timer running on <span className="pm-mono">{timer.workItem.key}</span>. Starting here stops it and
            logs its time.
          </>
        ) : (
          "Track the time you spend on this item."
        )}
      </span>
      <button className="pm-btn sm" type="button" onClick={start} disabled={busy}>
        <Play size={12} aria-hidden />
        {busy ? "Starting…" : elsewhere ? "Start timer here" : "Start timer"}
      </button>
    </div>
  );
}

// ── Entry form (log time / edit an entry) ───────────────────────────────────

interface EntryValues {
  minutes: number;
  /** Undefined when an edit left the day alone: the original start is kept. */
  startedAt: string | undefined;
  note: string;
}

function EntryForm({
  entry,
  submitLabel,
  busyLabel,
  showChip,
  onSubmit,
  onCancel,
}: {
  entry?: PmWorklog;
  submitLabel: string;
  busyLabel: string;
  showChip?: boolean;
  onSubmit: (values: EntryValues) => Promise<void>;
  onCancel?: () => void;
}): JSX.Element {
  const tz = browserTimeZone();
  const today = ymdInZone(new Date(), tz);
  const originalDay = entry ? entryDay(entry.startedAt, tz) : today;
  const [duration, setDuration] = useState(entry ? formatMinutes(entry.minutes) : "");
  const [date, setDate] = useState(originalDay);
  const [note, setNote] = useState(entry?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const durationRef = useRef<HTMLInputElement>(null);
  const ids = { d: useId(), day: useId(), n: useId(), e: useId() };

  const submit = async (ev: FormEvent): Promise<void> => {
    ev.preventDefault();
    if (busy) return;
    const minutes = parseDuration(duration);
    if (minutes === null) {
      setError(DURATION_HELP);
      durationRef.current?.focus();
      return;
    }
    if (date > today) {
      setError("Time can't start in the future.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onSubmit({
        minutes,
        startedAt: date === originalDay && entry ? undefined : startedAtForDay(date, today, entry ? new Date() : undefined),
        note: note.trim(),
      });
      if (!entry) {
        setDuration("");
        setNote("");
        setDate(today);
      }
    } catch (e) {
      setError(timeErrorCopy(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate style={{ marginTop: 12 }}>
      <div className="pm-time-form">
        <div className="pm-field">
          <label htmlFor={ids.d}>Time spent</label>
          <input
            ref={durationRef}
            id={ids.d}
            className="pm-input"
            placeholder="1h 30m"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            aria-invalid={error !== null && parseDuration(duration) === null}
            aria-describedby={error ? ids.e : undefined}
            autoComplete="off"
          />
        </div>
        <div className="pm-field">
          <label htmlFor={ids.day}>Date</label>
          <input
            id={ids.day}
            className="pm-input"
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="pm-field grow">
          <label htmlFor={ids.n}>Note (optional)</label>
          <input
            id={ids.n}
            className="pm-input"
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>
      {error && (
        <div id={ids.e} role="alert" style={{ marginTop: 6, fontSize: 12, color: "var(--err)" }}>
          {error}
        </div>
      )}
      <div className="pm-row" style={{ justifyContent: showChip ? "space-between" : "flex-end", gap: 8, marginTop: 10 }}>
        {showChip && <SafetyChip tier="write" />}
        <span className="pm-row" style={{ gap: 8 }}>
          {onCancel && (
            <button className="pm-btn sm" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          )}
          <button className="pm-btn primary sm" type="submit" disabled={busy}>
            {busy ? busyLabel : submitLabel}
          </button>
        </span>
      </div>
    </form>
  );
}

// ── Entries ─────────────────────────────────────────────────────────────────

function EntryRow({
  entry,
  tz,
  item,
  canChange,
  onEdit,
  onDelete,
}: {
  entry: PmWorklog;
  tz: string;
  /** Shown when the list spans work items (the timesheet); omitted inside one item's drawer. */
  item?: PmTimeItemRef;
  canChange: boolean;
  onEdit: () => void;
  onDelete: (trigger: HTMLElement) => void;
}): JSX.Element {
  const person = usePerson();
  const name = person(entry.userId).name;
  const when = fmtYmd(entryDay(entry.startedAt, tz));
  return (
    <li className="pm-time-row">
      <Avatar id={entry.userId} size={22} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="pm-row" style={{ gap: 7, flexWrap: "wrap" }}>
          <span className="dur">{formatMinutes(entry.minutes)}</span>
          <span style={{ color: "var(--text-3)" }}>{name}</span>
          <span className="pm-mono" style={{ fontSize: 11.5, color: "var(--text-4)" }}>
            {when}
          </span>
        </div>
        {item && (
          <div className="pm-row" style={{ gap: 7, minWidth: 0, fontSize: 12.5 }}>
            <span className="pm-mono" style={{ color: "var(--text-3)", flex: "none" }}>
              {item.key}
            </span>
            <span style={{ color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.name}
            </span>
          </div>
        )}
        {entry.note && <div className="note">{entry.note}</div>}
      </div>
      {canChange && (
        <span className="acts">
          <button className="pm-iconbtn" type="button" onClick={onEdit} aria-label={`Edit the ${formatMinutes(entry.minutes)} entry from ${when}`}>
            <PmIcon name="pencil" size={14} />
          </button>
          <button
            className="pm-iconbtn"
            type="button"
            onClick={(e) => onDelete(e.currentTarget)}
            aria-label={`Delete the ${formatMinutes(entry.minutes)} entry from ${when}`}
          >
            <PmIcon name="trash" size={14} />
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * A list of entries with editing and deleting, shared by the drawer (one item's
 * entries) and the timesheet (a week's entries across items). Owns the edit and
 * delete state, so each place that lists entries gets both behaviours the same.
 */
export function EntryList({
  entries,
  itemKey,
  showItem,
}: {
  entries: ReadonlyArray<PmWorklog & { workItem?: PmTimeItemRef }>;
  /** The key to name in the delete confirmation when the entries carry no item of their own. */
  itemKey?: string;
  showItem?: boolean;
}): JSX.Element {
  const access = useTimeAccess();
  const actions = useTimeActions();
  const { toast } = useToast();
  const tz = browserTimeZone();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<(PmWorklog & { workItem?: PmTimeItemRef }) | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const mayChange = (e: PmWorklog): boolean =>
    access.canWrite && (access.canManageAll || e.userId === access.userId);

  return (
    <>
      <ul className="pm-time-rows" aria-label="Time entries">
        {entries.map((e) =>
          editingId === e.id ? (
            <li key={e.id} className="pm-time-row" style={{ display: "block" }}>
              <EntryForm
                entry={e}
                submitLabel="Save"
                busyLabel="Saving…"
                onCancel={() => setEditingId(null)}
                onSubmit={async (v) => {
                  await actions.updateEntry(e.id, {
                    minutes: v.minutes,
                    started_at: v.startedAt,
                    note: v.note,
                  });
                  setEditingId(null);
                }}
              />
            </li>
          ) : (
            <EntryRow
              key={e.id}
              entry={e}
              tz={tz}
              item={showItem ? e.workItem : undefined}
              canChange={mayChange(e)}
              onEdit={() => setEditingId(e.id)}
              onDelete={(el) => {
                trigger.current = el;
                setDeleting(e);
              }}
            />
          ),
        )}
      </ul>
      <ConfirmDialog
        open={deleting !== null}
        triggerRef={trigger}
        title="Delete this entry?"
        description={
          deleting
            ? `This removes ${formatMinutes(deleting.minutes)} from ${deleting.workItem?.key ?? itemKey ?? "the work item"} and can't be undone.`
            : ""
        }
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await actions.deleteEntry(deleting.id);
          } catch (e) {
            toast(timeErrorCopy(e), "error");
            throw e;
          }
        }}
      />
    </>
  );
}

export function TimeSection({ item }: { item: PmWorkItem }): JSX.Element {
  const access = useTimeAccess();
  const actions = useTimeActions();
  const { list, error, isLoading, mutate } = useWorklogs(item.id);

  const entries = list?.worklogs ?? [];
  const totalMinutes = list?.total_minutes ?? 0;
  const totalEntries = list?.total_entries ?? entries.length;

  return (
    <div>
      <div className="pm-sect" style={{ marginBottom: 8 }}>
        Time {list && <span className="sx">{formatMinutes(totalMinutes)}</span>}
      </div>

      {access.canWrite && <TimerControl item={item} />}

      {isLoading && !list ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "6px 0" }} aria-hidden>
          <Skel h={14} w="60%" />
          <Skel h={14} w="45%" />
        </div>
      ) : error && !list ? (
        <div style={{ fontSize: 13, color: "var(--text-4)" }}>
          Couldn&apos;t load time. Check the appliance connection and try again.{" "}
          <button className="pm-btn ghost sm" type="button" onClick={() => void mutate()}>
            Try again
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--text-4)" }}>No time logged yet.</div>
      ) : (
        <>
          <EntryList entries={entries} itemKey={item.key} />
          {totalEntries > entries.length && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-4)" }}>
              Showing the {entries.length} most recent of {totalEntries} entries. The total covers all of them.
            </div>
          )}
        </>
      )}

      {access.canWrite && (
        <EntryForm
          submitLabel="Log time"
          busyLabel="Logging…"
          showChip
          onSubmit={async (v) => {
            await actions.logTime(item.id, { minutes: v.minutes, started_at: v.startedAt, note: v.note || undefined });
          }}
        />
      )}
    </div>
  );
}
