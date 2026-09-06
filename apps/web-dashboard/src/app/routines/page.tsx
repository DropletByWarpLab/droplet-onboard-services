"use client";

/**
 * WARP-2671 — Routines (`/routines`)
 *
 * The surface the ToolSpec engine never had. `ToolSpecStatus`'s own schema
 * comment says "Adding a new state is a schema change so the dashboard's
 * three-tab UX can't drift" — this is that UX, finally built, and it is also
 * the first reader the WARP-464 pattern miner has ever had.
 *
 * Deliberately NOT part of `/tools`. That page is a read-only catalog of the
 * box's built-in capabilities with a SEED-not-run contract (WARP-829); a
 * routine is something a person composed out of them, and it does run from
 * here.
 *
 * The promote flow shows a readback DERIVED from the steps and the live
 * registry (`routine-readback.ts`), never the spec's own description — a
 * routine that misdescribes itself must not be able to talk its way past the
 * confirmation.
 */

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  Clock,
  FileEdit,
  Lightbulb,
  Play,
  Repeat,
  ShieldCheck,
} from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import {
  useRoutine,
  useRoutineRuns,
  useRoutineSchedules,
  useRoutines,
} from "@/lib/hooks/useRoutines";
import { useToolCatalog } from "@/lib/hooks/useToolCatalog";
import {
  createRoutineSchedule,
  deleteRoutineSchedule,
  runRoutine,
  setRoutineStatus,
  updateRoutineSchedule,
} from "@/lib/api";
import {
  describeRoutine,
  describeSchedule,
  readbackSentence,
} from "@/lib/routine-readback";
import type { Routine, RoutineRun, RoutineStatus } from "@/lib/types";

const SUB =
  "Sequences your Droplet can run for you — on a schedule, or whenever you press Run.";

const TABS: Array<{ key: RoutineStatus; label: string; blurb: string }> = [
  {
    key: "live",
    label: "Live",
    blurb: "Running now, on their schedule or on demand.",
  },
  { key: "draft", label: "Drafts", blurb: "Written, but not running yet." },
  {
    key: "suggested",
    label: "Suggested",
    blurb:
      "Your Droplet noticed you doing these steps repeatedly and wrote them down.",
  },
];

export default function RoutinesPage() {
  const { live, drafts, suggested, isLoading, error, refresh } = useRoutines();
  const [tab, setTab] = useState<RoutineStatus>("live");
  const [openSlug, setOpenSlug] = useState<string | null>(null);

  const byTab: Record<RoutineStatus, Routine[]> = useMemo(
    () => ({ live, draft: drafts, suggested }),
    [live, drafts, suggested],
  );
  const rows = byTab[tab];

  if (error) {
    return (
      <ShellPage icon={<Repeat size={15} />} label="Routines" title="Routines" sub={SUB}>
        <div className="card">
          <div className="empty">
            <span className="ei">
              <AlertTriangle size={24} />
            </span>
            <span className="eh">Couldn&rsquo;t load your routines</span>
            <span>{error.message}</span>
          </div>
        </div>
      </ShellPage>
    );
  }

  return (
    <ShellPage icon={<Repeat size={15} />} label="Routines" title="Routines" sub={SUB}>
      <div className="chiprow" role="tablist" aria-label="Routine status">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => {
              setTab(t.key);
              setOpenSlug(null);
            }}
            className={"chip" + (tab === t.key ? " on" : "")}
          >
            {t.label}
            <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.7 }}>
              {byTab[t.key].length}
            </span>
          </button>
        ))}
      </div>

      <p className="muted" style={{ margin: "4px 0 12px" }}>
        {TABS.find((t) => t.key === tab)?.blurb}
      </p>

      {isLoading ? (
        <div className="card">
          <div className="empty">
            <span className="eh">Loading&hellip;</span>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <EmptyTab tab={tab} />
      ) : (
        <div className="grid c2 stagger">
          {rows.map((r) => (
            <RoutineCard
              key={r.slug}
              routine={r}
              open={openSlug === r.slug}
              onToggle={() => setOpenSlug(openSlug === r.slug ? null : r.slug)}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
    </ShellPage>
  );
}

function EmptyTab({ tab }: { tab: RoutineStatus }) {
  const copy: Record<RoutineStatus, { icon: React.ReactNode; head: string; body: string }> = {
    live: {
      icon: <Play size={24} />,
      head: "Nothing is running yet",
      body: "When you publish a routine it appears here, with its schedule and its last few runs.",
    },
    draft: {
      icon: <FileEdit size={24} />,
      head: "No drafts",
      body: "Drafts are routines that have been written but not turned on. Nothing here runs.",
    },
    suggested: {
      icon: <Lightbulb size={24} />,
      head: "No suggestions yet",
      body: "Your Droplet watches for steps you repeat and proposes them here. It needs to see the same sequence a few times first.",
    },
  };
  const c = copy[tab];
  return (
    <div className="card">
      <div className="empty">
        <span className="ei">{c.icon}</span>
        <span className="eh">{c.head}</span>
        <span>{c.body}</span>
      </div>
    </div>
  );
}

function RoutineCard({
  routine,
  open,
  onToggle,
  onChanged,
}: {
  routine: Routine;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  return (
    <section className="card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "block",
          width: "100%",
        }}
      >
        <div className="sect" style={{ marginTop: 0 }}>
          <h2 style={{ fontSize: 15 }}>{routine.name}</h2>
          <ImpactChip writes={routine.writes} reversible={routine.reversible} />
        </div>
        {routine.description ? (
          <p className="muted" style={{ margin: 0 }}>
            {routine.description}
          </p>
        ) : null}
      </button>
      {open ? <RoutineDetail routine={routine} onChanged={onChanged} /> : null}
    </section>
  );
}

function ImpactChip({ writes, reversible }: { writes: boolean; reversible: boolean }) {
  if (!writes) {
    return (
      <span className="chip" title="This routine only reads. It changes nothing.">
        <ShieldCheck size={13} aria-hidden /> Reads only
      </span>
    );
  }
  if (reversible) {
    return (
      <span className="chip" title="This routine makes changes that can be undone.">
        Makes changes
      </span>
    );
  }
  return (
    <span
      className="chip"
      title="Changes that cannot easily be undone. This never runs unattended."
    >
      <AlertTriangle size={13} aria-hidden /> Hard to undo
    </span>
  );
}

function RoutineDetail({
  routine,
  onChanged,
}: {
  routine: Routine;
  onChanged: () => void;
}) {
  const { routine: full } = useRoutine(routine.slug);
  const { runs } = useRoutineRuns(routine.slug);
  const { schedules, refresh: refreshSchedules } = useRoutineSchedules(routine.slug);
  const { tools } = useToolCatalog();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Run-now was refused with 409: the server wants an explicit yes. Without
  // this the routines the gate exists to protect could never be run from
  // here — every click re-showed the same message (review, WARP-2671).
  const [runConfirm, setRunConfirm] = useState(false);

  const catalog = useMemo(
    () => new Map(tools.map((t) => [t.name, t])),
    [tools],
  );

  const readback = useMemo(
    () =>
      describeRoutine({
        steps: full?.steps ?? [],
        catalog,
        schedules,
        writes: routine.writes,
        reversible: routine.reversible,
      }),
    [full, catalog, schedules, routine.writes, routine.reversible],
  );

  async function promote() {
    setBusy(true);
    setNotice(null);
    try {
      await setRoutineStatus(routine.slug, "live");
      setConfirming(false);
      onChanged();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function run(confirm = false) {
    setBusy(true);
    setNotice(null);
    try {
      const { status, body } = await runRoutine(routine.slug, confirm);
      if (status === 409) {
        // The server's own destructive-spec gate. Surface its words rather
        // than inventing copy, then let the person decide — with a button
        // that re-POSTs `?confirm=true`, which is what the 409 asks for.
        const detail =
          (body as { detail?: string }).detail ??
          "This routine makes changes that are hard to undo.";
        setNotice(`${detail}`);
        setRunConfirm(true);
        return;
      }
      setRunConfirm(false);
      if (status >= 400) {
        setNotice((body as { error?: string }).error ?? `Run failed (${status})`);
        return;
      }
      setNotice("Run finished — see the history below.");
      onChanged();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12, display: "grid", gap: 14 }}>
      {/* The derived readback — what this routine actually does. */}
      <div>
        <div className="sect">
          <h3 style={{ fontSize: 13 }}>What it does</h3>
        </div>
        <p style={{ margin: 0 }}>{readbackSentence(readback)}</p>
        <p
          className="muted"
          style={{ margin: "4px 0 0" }}
          title={
            readback.writeTools.length > 0
              ? `Changes things through: ${readback.writeTools.join(", ")}`
              : undefined
          }
        >
          {readback.impactLine}
        </p>
      </div>

      <StepList routine={full ?? routine} />

      <SchedulePanel
        slug={routine.slug}
        schedules={schedules}
        onChanged={() => {
          refreshSchedules();
          onChanged();
        }}
      />

      <RunHistory runs={runs} />

      {notice ? (
        <p className="muted" role="status">
          {notice}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {routine.status === "live" && runConfirm ? (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => run(true)}>
              <Play size={14} aria-hidden /> Run anyway
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                setRunConfirm(false);
                setNotice(null);
              }}
            >
              Cancel
            </button>
          </>
        ) : routine.status === "live" ? (
          <button type="button" className="btn" disabled={busy} onClick={() => run()}>
            <Play size={14} aria-hidden /> Run now
          </button>
        ) : confirming ? (
          <>
            <span className="muted" style={{ flexBasis: "100%" }}>
              Turn this on? {readbackSentence(readback)} {readback.impactLine}
            </span>
            <button type="button" className="btn" disabled={busy} onClick={promote}>
              Yes, turn it on
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Turn on&hellip;
          </button>
        )}
      </div>
    </div>
  );
}

function StepList({ routine }: { routine: Routine }) {
  const steps = routine.steps ?? [];
  if (steps.length === 0) return null;
  return (
    <div>
      <div className="sect">
        <h3 style={{ fontSize: 13 }}>Steps</h3>
        <span className="sx">{steps.length}</span>
      </div>
      <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
        {steps.map((s) => {
          const args = s.args as Record<string, unknown> | null;
          const tool =
            s.kind === "summarize"
              ? "Write a summary"
              : typeof args?.tool === "string"
                ? args.tool
                : "(unreadable step)";
          const as = typeof args?.as === "string" ? args.as : null;
          return (
            <li key={s.id}>
              <code>{tool}</code>
              {as ? (
                <span className="muted"> → remembered as “{as}”</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const CADENCE_PRESETS = [
  { label: "Every day", rrule: "FREQ=DAILY" },
  { label: "Every weekday", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
] as const;

function SchedulePanel({
  slug,
  schedules,
  onChanged,
}: {
  slug: string;
  schedules: ReturnType<typeof useRoutineSchedules>["schedules"];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState(0);
  const [time, setTime] = useState("08:00");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const browserZone =
    typeof Intl !== "undefined"
      ? (Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC")
      : "UTC";

  // Every mutation in this panel routes its failure into `err`; a rejected
  // request must never be an unhandled rejection with nothing on screen
  // (review, WARP-2671).
  async function mutate(work: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await work();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    setBusy(true);
    setErr(null);
    try {
      const [h, m] = time.split(":");
      const rrule = `${CADENCE_PRESETS[preset].rrule};BYHOUR=${Number(h)};BYMINUTE=${Number(m)}`;
      await createRoutineSchedule(slug, { rrule, timezone: browserZone });
      setAdding(false);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="sect">
        <h3 style={{ fontSize: 13 }}>
          <CalendarClock size={13} aria-hidden /> Schedule
        </h3>
        <span className="sx">{schedules.length}</span>
      </div>

      {schedules.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Not scheduled — it runs only when you press Run.
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {schedules.map((s) => (
            <li key={s.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>{describeSchedule(s)}</span>
              {!s.enabled ? <span className="chip">Paused</span> : null}
              <span className="pt-spring" style={{ flex: 1 }} />
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() =>
                  mutate(() => updateRoutineSchedule(slug, s.id, { enabled: !s.enabled }))
                }
              >
                {s.enabled ? "Pause" : "Resume"}
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                aria-label={`Remove schedule ${describeSchedule(s)}`}
                onClick={() => mutate(() => deleteRoutineSchedule(slug, s.id))}
              >
                <CircleSlash size={13} aria-hidden /> Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select
            aria-label="How often"
            value={preset}
            onChange={(e) => setPreset(Number(e.target.value))}
          >
            {CADENCE_PRESETS.map((p, i) => (
              <option key={p.rrule} value={i}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            type="time"
            aria-label="At what time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
          <span className="muted">{browserZone}</span>
          <button type="button" className="btn" disabled={busy} onClick={add}>
            Add
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => setAdding(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn ghost"
          style={{ marginTop: 8 }}
          onClick={() => setAdding(true)}
        >
          Add a schedule
        </button>
      )}
      {err ? (
        <p className="muted" role="status" style={{ margin: "6px 0 0" }}>
          {err}
        </p>
      ) : null}
    </div>
  );
}

function RunHistory({ runs }: { runs: RoutineRun[] }) {
  if (runs.length === 0) {
    return (
      <div>
        <div className="sect">
          <h3 style={{ fontSize: 13 }}>
            <Clock size={13} aria-hidden /> Recent runs
          </h3>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          It hasn&rsquo;t run yet.
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="sect">
        <h3 style={{ fontSize: 13 }}>
          <Clock size={13} aria-hidden /> Recent runs
        </h3>
        <span className="sx">{runs.length}</span>
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
        {runs.map((r) => (
          <li key={r.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            {r.status === "ok" ? (
              <CheckCircle2 size={13} aria-hidden style={{ color: "var(--ok, green)" }} />
            ) : (
              <AlertTriangle size={13} aria-hidden />
            )}
            <span>{new Date(r.startedAt).toLocaleString()}</span>
            <span className="muted">
              {r.triggeredBy === "scheduler" ? "on schedule" : "run by hand"}
            </span>
            {r.error ? <span className="muted">— {r.error}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
