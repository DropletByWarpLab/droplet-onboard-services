"use client";

/**
 * Droplet Home — widget components + registry.
 *
 * Every data-display widget is wired to a REAL endpoint and shows an honest
 * empty state when there's no data — no hardcoded/fallback content masquerading
 * as live data:
 *   · Chat        → useModels
 *   · System status → useRecents / useModels / useCameras / useSmartHome
 *   · Calendar    → useCalendarEvents (real /api/calendar/events)
 *   · Recent files → useRecents
 *   · Cameras     → useCameras
 *   · Models      → useModels
 *   · Notes       → local scratchpad (localStorage; real per-device store)
 *
 * Widgets whose backend doesn't exist yet (Tasks, Activity, Scenes, scheduled
 * Automations) are gated behind default-off feature flags and tracked in
 * `docs/feature-requests.md`. They are absent from the registry (and the Add
 * tray) unless their `NEXT_PUBLIC_FEATURE_*` flag is enabled.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowUpRight,
  Blinds,
  Brain,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Cpu,
  FileSpreadsheet,
  FileText,
  FilePlus,
  Folder,
  Image as ImageIcon,
  Lightbulb,
  Lock,
  MessageSquare,
  Mic,
  Network,
  Paperclip,
  PenLine,
  Plus,
  Settings,
  Sparkles,
  Thermometer,
  Video,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useModels } from "@/lib/hooks/useModels";
import { useRecents } from "@/lib/hooks/useRecents";
import { useCameras } from "@/lib/hooks/useCameras";
import { useSmartHome } from "@/lib/hooks/useSmartHome";
import { useVoiceHealthSummary } from "@/lib/hooks/useVoice";
import { useCalendarEvents } from "@/lib/hooks/useCalendar";
import { FEATURES } from "@/lib/feature-flags";

export interface WidgetProps {
  w: number;
  h: number;
  editing?: boolean;
}

export interface WidgetMeta {
  title: string;
  icon: LucideIcon;
  Comp: (props: WidgetProps) => JSX.Element;
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
  feature?: boolean;
  scroll?: boolean;
  meta?: string;
}

/* ─────────────────────────── helpers ─────────────────────────── */

function greetingNow(): string {
  const hr = new Date().getHours();
  if (hr < 5) return "Still up";
  if (hr < 12) return "Good morning";
  if (hr < 18) return "Good afternoon";
  if (hr < 22) return "Good evening";
  return "Working late";
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "Yesterday" : `${d}d ago`;
}

function fileKind(f: { isDirectory: boolean; mimeType: string | null; name: string }) {
  if (f.isDirectory) return "image"; // folder → neutral tile tone
  const m = (f.mimeType ?? "").toLowerCase();
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (m.includes("sheet") || ["xlsx", "csv", "numbers"].includes(ext)) return "sheet";
  if (m.includes("pdf") || ext === "pdf") return "pdf";
  if (m.startsWith("video") || ["mp4", "mov", "mkv"].includes(ext)) return "video";
  if (m.startsWith("image") || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  return "doc";
}

/** Honest empty state for a data widget with no data (never mock content). */
function WEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 56,
        fontSize: 12.5,
        color: "var(--text-muted)",
        textAlign: "center",
        padding: 8,
      }}
    >
      {children}
    </div>
  );
}

/* ─────────────────────────── Chat (centerpiece) ─────────────────────────── */
function ChatWidget({ w, h }: WidgetProps) {
  const router = useRouter();
  const { models } = useModels();
  const localModel = models.find((m) => m.provider === "ollama") ?? models[0];
  const greeting = greetingNow();
  const fs = w >= 6 ? 33 : w >= 5 ? 29 : w >= 4 ? 25 : 22;
  const nSug = h >= 6 ? 4 : h >= 5 ? 3 : h >= 4 ? 2 : 1;
  const suggestions = [
    "Summarize the files I uploaded today",
    "What's using the most storage?",
    "Draft a changelog from recent notes",
    "Dim the living-room lights to 30%",
  ].slice(0, nSug);
  const [val, setVal] = useState("");

  const go = (text?: string) => {
    const body = (text ?? val).trim();
    if (body) {
      try {
        window.sessionStorage.setItem("droplet.pendingPrompt", body);
      } catch {
        /* private mode — /chat still opens */
      }
    }
    router.push("/chat");
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      go();
    }
  };

  return (
    <div className="w-chat">
      <div className="w-chat-aurora" aria-hidden />
      <div className="w-chat-display" style={{ fontSize: fs }}>
        {greeting}. What can I <em>help you</em> with today?
      </div>
      <div className="w-chat-capsule focus-within:ring-2 focus-within:ring-accent/40">
        <textarea
          rows={1}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={onKey}
          aria-label="Ask Droplet"
          placeholder="Ask Droplet anything — your files, cameras, network, devices…"
        />
        <div className="w-chat-cap-row">
          {localModel ? (
            <span className="w-chat-model">
              <span className="dot" />
              {localModel.name}
              <ChevronDown size={10} />
            </span>
          ) : (
            <span className="w-chat-model" style={{ opacity: 0.6 }}>
              <span className="dot" style={{ background: "var(--text-muted)" }} />
              No model
            </span>
          )}
          <button className="w-chat-iconbtn" tabIndex={-1} aria-label="Attach" type="button">
            <Paperclip size={15} />
          </button>
          <button className="w-chat-iconbtn" tabIndex={-1} aria-label="Voice" type="button">
            <Mic size={15} />
          </button>
          <button className="w-chat-send" onClick={() => go()} title="Send" type="button">
            <ArrowUpRight size={15} strokeWidth={2.4} />
          </button>
        </div>
      </div>
      {nSug > 0 && (
        <div className="w-chat-suggest">
          {suggestions.map((s) => (
            <button key={s} className="w-sug" onClick={() => go(s)} type="button">
              <Sparkles size={13} />
              <span>{s}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── Calendar ─────────────────────────── */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function CalendarWidget({ h }: WidgetProps) {
  const today = new Date();
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const agendaRef = useRef<HTMLDivElement>(null);
  const [maxItems, setMaxItems] = useState(4);

  // Real events for the viewed month (drives both the day-dots and the agenda).
  const monthStart = useMemo(() => new Date(view.y, view.m, 1), [view.y, view.m]);
  const monthEnd = useMemo(() => new Date(view.y, view.m + 1, 0, 23, 59, 59), [view.y, view.m]);
  const { events } = useCalendarEvents({ from: monthStart, to: monthEnd });

  // Day numbers (within the viewed month) that have at least one event.
  const eventDays = useMemo(() => {
    const s = new Set<number>();
    for (const e of events) {
      const d = new Date(e.startsAt);
      if (d.getFullYear() === view.y && d.getMonth() === view.m) s.add(d.getDate());
    }
    return s;
  }, [events, view.y, view.m]);

  // Agenda = upcoming events (not yet ended), soonest first.
  const agenda = useMemo(() => {
    const now = Date.now();
    return [...events]
      .filter((e) => new Date(e.endsAt).getTime() >= now)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [events]);

  useLayoutEffect(() => {
    const el = agendaRef.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientHeight - 12;
      const rowH = 52;
      setMaxItems(Math.max(0, Math.floor((avail + 10) / rowH)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [h]);

  const first = new Date(view.y, view.m, 1).getDay();
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const prevDays = new Date(view.y, view.m, 0).getDate();
  const isThisMonth = view.y === today.getFullYear() && view.m === today.getMonth();
  const cells: { d: number; out: boolean }[] = [];
  for (let i = 0; i < first; i++) cells.push({ d: prevDays - first + 1 + i, out: true });
  for (let d = 1; d <= days; d++) cells.push({ d, out: false });
  while (cells.length % 7 !== 0) cells.push({ d: cells.length - (first + days) + 1, out: true });
  const shift = (n: number) => {
    let m = view.m + n;
    let y = view.y;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setView({ y, m });
  };
  const visible = agenda.slice(0, maxItems);
  const fmtTime = (iso: string, allDay: boolean) =>
    allDay
      ? "all-day"
      : new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <div className="w-cal">
      <div className="w-cal-h">
        <span className="mo">{MONTHS[view.m]} {view.y}</span>
        <button className="w-cal-nav" onClick={() => shift(-1)} aria-label="Previous month" type="button">
          <ChevronLeft size={14} />
        </button>
        <button className="w-cal-nav" onClick={() => shift(1)} aria-label="Next month" type="button">
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="w-cal-grid">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div className="dow" key={i}>{d}</div>
        ))}
        {cells.map((c, i) => {
          const isToday = isThisMonth && !c.out && c.d === today.getDate();
          const ev = !c.out && eventDays.has(c.d);
          return (
            <div className={"w-cal-cell" + (c.out ? " out" : "") + (isToday ? " today" : "")} key={i}>
              {c.d}
              {ev && <span className="ev" />}
            </div>
          );
        })}
      </div>
      <div className={"w-cal-agenda" + (visible.length ? " has-items" : "")} ref={agendaRef}>
        {visible.length === 0 ? (
          <div className="w-ag-empty" style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 2px" }}>
            No upcoming events
          </div>
        ) : (
          visible.map((e) => (
            <div className="w-ag" key={e.id}>
              <span className="t">{fmtTime(e.startsAt, e.allDay)}</span>
              <span className="bar" />
              <span className="tx">
                {e.title}
                {e.location ? <small>{e.location}</small> : null}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── System status ─────────────────────────── */
function StatusWidget({ w, h }: WidgetProps) {
  const { items: recents } = useRecents(50);
  const { models } = useModels();
  const { totalCameras } = useCameras();
  const { totalDevices } = useSmartHome();
  // WARP-1055 — the Home surface's Voice status line lives inside this
  // existing system-health tile (design brief §2), not a new tile.
  const { state: voiceState } = useVoiceHealthSummary();

  const local = models.filter((m) => m.provider === "ollama").length;
  const cloud = models.length - local;

  const voiceRow: [LucideIcon, string, string, string, string] =
    voiceState == null
      ? [Mic, "Voice", "—", "checking…", "var(--color-label-quaternary)"]
      : voiceState.kind === "calibrated"
        ? [Mic, "Voice", "Calibrated", "wake word ready", "var(--success)"]
        : voiceState.kind === "attention"
          ? [Mic, "Voice", "Attention", "needs attention", "var(--color-system-orange)"]
          : voiceState.kind === "broken"
            ? [Mic, "Voice", "Attention", "microphone not working", "var(--color-system-red)"]
            : [Mic, "Voice", "—", "not calibrated yet", "var(--color-label-quaternary)"];

  const stats: [LucideIcon, string, string, string, string][] = [
    [Folder, "Files", recents.length ? String(recents.length) : "—", "recently indexed", "var(--success)"],
    [Video, "Cameras", totalCameras ? String(totalCameras) : "—", totalCameras ? "live feeds" : "none yet", "var(--brand)"],
    [Network, "Devices", totalDevices ? String(totalDevices) : "—", "smart-home online", "var(--success)"],
    [Cpu, "AI models", models.length ? String(models.length) : "—", `${local} local · ${cloud} cloud`, "var(--success)"],
    voiceRow,
  ];

  if (w <= 2 || h <= 2) {
    return (
      <div className="w-stat-list">
        {stats.map(([Ic, e, v, , dot]) => (
          <div className="w-stat-row" key={e}>
            <span className="ico"><Ic size={14} /></span>
            <span className="lbl">{e}</span>
            <span className="dot" style={{ background: dot }} />
            <span className="val">{v}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="w-stat">
      {stats.map(([Ic, e, v, s, dot]) => (
        <div className="w-stat-cell" key={e}>
          <span className="e"><Ic size={12} />{e}</span>
          <span className="v">{v}</span>
          <span className="s"><span className="dot" style={{ background: dot }} />{s}</span>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────── Activity timeline ─────────────────────────── */
const ACTIVITY: [string, "ok" | "warn" | "err", LucideIcon, string][] = [
  ["07:14", "warn", Video, "Garage camera idle 1h 47m · no motion events"],
  ["08:30", "ok", Settings, "NAS snapshot completed · 64 GB written"],
  ["09:42", "ok", MessageSquare, "You asked for a storage breakdown · saved"],
  ["10:15", "err", AlertTriangle, "Garage cam offline 4m · PoE flap port-7 · recovered"],
  ["11:14", "ok", Lightbulb, "Living-room lights dimmed to 30% by you"],
  ["12:30", "ok", Network, "New device joined LAN · 192.168.4.51"],
];
function ActivityWidget() {
  return (
    <div className="timeline">
      {ACTIVITY.map(([t, tone, Ic, tx]) => (
        <div className="timeline-row" key={t}>
          <span className="timeline-time">{t}</span>
          <span className={"timeline-ico " + tone}><Ic size={11} /></span>
          <div className="timeline-text"><div className="h">{tx}</div></div>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────── Recent files ─────────────────────────── */
function FilesWidget() {
  const { items } = useRecents(8);
  const rows: [string, string, string][] = items
    .slice(0, 8)
    .map((f) => [fileKind(f), f.name, relTime(f.modifiedAt)]);
  const iconFor: Record<string, LucideIcon> = {
    doc: FileText, pdf: FileText, sheet: FileSpreadsheet, video: Video, image: ImageIcon,
  };
  if (rows.length === 0) {
    return <WEmpty>No recent files</WEmpty>;
  }
  return (
    <div className="w-list">
      {rows.map(([kind, name, meta], i) => {
        const Ic = iconFor[kind] ?? FileText;
        return (
          <div className="w-row" key={name + i}>
            <span className={"f-ico " + kind} style={{ width: 24, height: 24, borderRadius: 6 }}>
              <Ic size={12} />
            </span>
            <span className="grow nm">{name}</span>
            <span className="meta">{meta}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────── Smart-home scenes ─────────────────────────── */
function ScenesWidget() {
  const [scene, setScene] = useState("Day");
  const [devs, setDevs] = useState<Record<string, boolean>>({ living: true, office: false, door: false });
  const scenes: [string, LucideIcon][] = [
    ["Morning", Sparkles], ["Day", Lightbulb], ["Night", Blinds], ["Away", Lock],
  ];
  const list: [string, LucideIcon, string, string][] = [
    ["living", Lightbulb, "Living room", "3 lights · 30%"],
    ["office", Thermometer, "Office", "72°F · cooling"],
    ["door", Lock, "Front door", "Locked"],
  ];
  return (
    <div className="w-scenes">
      <div className="w-scene-row">
        {scenes.map(([n, Ic]) => (
          <button key={n} className={"w-scene" + (scene === n ? " active" : "")} onClick={() => setScene(n)} type="button">
            <Ic size={13} />{n}
          </button>
        ))}
      </div>
      <div className="w-dev-list">
        {list.map(([id, Ic, nm, sb]) => (
          <div
            key={id}
            className={"w-dev" + (devs[id] ? " on" : "")}
            onClick={() => setDevs((d) => ({ ...d, [id]: !d[id] }))}
            role="switch"
            aria-checked={!!devs[id]}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setDevs((d) => ({ ...d, [id]: !d[id] }));
              }
            }}
          >
            <span className="di"><Ic size={14} /></span>
            <span className="dn"><div className="nm">{nm}</div><div className="sb">{sb}</div></span>
            <span className="w-toggle"><span className="ball" /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── Cameras live peek ─────────────────────────── */
const CAM_TINTS = [
  "linear-gradient(135deg,#171922,#222633)",
  "linear-gradient(135deg,#191c26,#262b3a)",
  "linear-gradient(135deg,#15171f,#1f2937)",
  "linear-gradient(135deg,#1a1d27,#242a38)",
];
function CamerasWidget({ w, h }: WidgetProps) {
  const { cameras } = useCameras();
  const names = cameras.map((c) => c.displayName || c.name);
  const motionSet = new Set(
    cameras.filter((c) => c.status === "detecting" || c.lastDetection).map((c) => c.displayName || c.name),
  );
  if (names.length === 0) {
    return <WEmpty>No cameras yet</WEmpty>;
  }
  const tiny = w <= 2 && h <= 2;
  const n = tiny ? 1 : w >= 4 && h >= 3 ? 4 : 2;
  const cols = tiny ? 1 : w >= 4 ? 2 : h >= 3 ? 1 : 2;
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <div className="w-cams" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {names.slice(0, n).map((nm, i) => (
        <div className="w-cam" key={nm + i} style={{ background: CAM_TINTS[i % CAM_TINTS.length] }}>
          <span className="rec" />
          <span className="ts">{ts}</span>
          <span className="lb">{nm}</span>
          {motionSet.has(nm) && <span className="mo">motion</span>}
          {tiny && names.length > 1 && i === 0 && <span className="cam-more">+{names.length - 1}</span>}
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────── Models ─────────────────────────── */
function ModelsWidget() {
  const { models } = useModels();
  const rows: [boolean, string, string, "local" | "cloud"][] = models.map((m) => {
    const isLocal = m.provider === "ollama";
    return [
      !isLocal,
      m.name,
      isLocal ? "local · on-device" : `${m.provider} · opt-in`,
      isLocal ? "local" : "cloud",
    ];
  });
  if (rows.length === 0) {
    return <WEmpty>No models installed</WEmpty>;
  }
  return (
    <div className="w-list">
      {rows.map(([cloud, nm, sb, tag], i) => (
        <div className="w-row" key={nm + i}>
          {cloud ? (
            <Cloud size={15} style={{ color: "var(--text-muted)" }} />
          ) : (
            <Cpu size={15} style={{ color: "var(--brand)" }} />
          )}
          <span className="grow"><div className="nm">{nm}</div><div className="sub">{sb}</div></span>
          <span className={"w-badge " + tag}>{tag}</span>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────── Tools ─────────────────────────── */
const TOOLS: [string, string][] = [
  ["Nightly NAS snapshot", "2 AM daily"],
  ["Weekly network audit", "Mon 9 AM"],
  ["Storage report", "Sun 8 PM"],
  ["New-device watch", "always on"],
];
function ToolsWidget() {
  return (
    <div className="w-list">
      {TOOLS.map(([nm, m]) => (
        <div className="w-row" key={nm}>
          <span className="w-gear"><Settings size={13} strokeWidth={2} /></span>
          <span className="grow nm">{nm}</span>
          <span className="meta mono">{m}</span>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────── Tasks ─────────────────────────── */
function TasksWidget() {
  const [tasks, setTasks] = useState([
    { t: "Approve firmware update · 3 devices", w: "today", done: false },
    { t: "Review weekly network audit", w: "today", done: false },
    { t: "Rotate encrypted API key", w: "Wed", done: true },
    { t: "Clear garage-cam PoE alert", w: "done", done: true },
    { t: "Pair new Matter sensor", w: "9 AM", done: false },
  ]);
  const toggle = (i: number) =>
    setTasks((ts) => ts.map((t, j) => (j === i ? { ...t, done: !t.done } : t)));
  return (
    <div className="w-tasks">
      {tasks.map((t, i) => (
        <div
          key={i}
          className={"w-task" + (t.done ? " done" : "")}
          onClick={() => toggle(i)}
          role="checkbox"
          aria-checked={t.done}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle(i);
            }
          }}
        >
          <span className="box">{t.done && <Check size={11} strokeWidth={3} />}</span>
          <span className="lbl">{t.t}</span>
          <span className="when">{t.w}</span>
        </div>
      ))}
      <button className="w-task-add" type="button"><Plus size={13} />Add a task</button>
    </div>
  );
}

/* ─────────────────────────── Notes ───────────────────────────
 * Single-note scratchpad backed by localStorage. The save is debounced
 * (~500ms) and surfaced through a small status line so the autosave is
 * legible — "Saving…" while a write is pending, "Saved" once it lands —
 * instead of writing on every keystroke with zero feedback. "New note"
 * flushes the pending save and starts a fresh, empty note.
 */
const NOTES_KEY = "droplet-home-notes";
const NOTES_SAVE_DEBOUNCE_MS = 500;
type NotesSaveStatus = "idle" | "saving" | "saved";

export function NotesWidget() {
  const [val, setVal] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<NotesSaveStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of `val` + a pending-save flag for the unmount flush, which can't
  // read the latest state through a stale `[]`-effect closure.
  const valRef = useRef("");
  const pendingRef = useRef(false);

  const writeStorage = (next: string) => {
    try {
      window.localStorage.setItem(NOTES_KEY, next);
    } catch {
      /* ignore — private-mode / quota; the in-memory note still works */
    }
  };

  // Persist `val` immediately and reflect the saved state. Used by both the
  // debounced timer and the explicit "New note" flush so writes never race.
  const flush = (next: string) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = false;
    writeStorage(next);
    setStatus("saved");
  };

  useEffect(() => {
    try {
      setVal(window.localStorage.getItem(NOTES_KEY) ?? "");
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  // Debounced autosave: mark "Saving…" on each edit, then commit once the
  // user pauses. The initial hydration pass is skipped so we don't flash
  // a status on first paint.
  useEffect(() => {
    valRef.current = val;
    if (!hydrated) return;
    pendingRef.current = true;
    setStatus("saving");
    timerRef.current = setTimeout(() => {
      flush(val);
    }, NOTES_SAVE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [val, hydrated]);

  // Unmount-only: if a debounced save is still in flight when the widget goes
  // away (navigate off Home, remove the tile), commit the latest text so we
  // don't drop up to ~500ms of typing — the old write-every-keystroke code
  // never lost data on unmount.
  useEffect(() => {
    return () => {
      if (pendingRef.current) writeStorage(valRef.current);
    };
  }, []);

  const newNote = () => {
    // Flush first so the (now empty) note is committed — never silently
    // discard the in-flight save.
    flush("");
    setVal("");
  };

  return (
    <div className="w-notes-wrap">
      <textarea
        className="w-notes"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        aria-label="Notes"
        placeholder="Jot something down…"
      />
      <div className="w-notes-bar">
        <span
          className="w-notes-status"
          role="status"
          aria-live="polite"
          data-state={status}
        >
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
        </span>
        <button
          className="w-notes-new"
          type="button"
          onClick={newNote}
        >
          <FilePlus size={13} />
          New note
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── Registry ───────────────────────────
 * Widgets backed by a real endpoint are always present. The four whose
 * backend doesn't exist yet (Activity, Scenes, Tools/automations, Tasks)
 * are added ONLY when their feature flag is on — so they never ship mock
 * data to users. See docs/feature-requests.md (FR-001…FR-004).
 */
export const WIDGETS: Record<string, WidgetMeta> = {
  chat:     { title: "Ask Droplet",   icon: Sparkles,     Comp: ChatWidget,     minW: 3, minH: 4, maxW: 12, maxH: 7, feature: true },
  calendar: { title: "Calendar",      icon: Calendar,     Comp: CalendarWidget, minW: 3, minH: 3, maxW: 6,  maxH: 6 },
  status:   { title: "System status", icon: Network,      Comp: StatusWidget,   minW: 2, minH: 2, maxW: 6,  maxH: 4 },
  files:    { title: "Recent files",  icon: Folder,       Comp: FilesWidget,    minW: 2, minH: 2, maxW: 6,  maxH: 6, scroll: true },
  cameras:  { title: "Cameras",       icon: Video,        Comp: CamerasWidget,  minW: 2, minH: 2, maxW: 6,  maxH: 5 },
  models:   { title: "Models",        icon: Brain,        Comp: ModelsWidget,   minW: 2, minH: 2, maxW: 6,  maxH: 5, scroll: true },
  notes:    { title: "Notes",         icon: PenLine,      Comp: NotesWidget,    minW: 2, minH: 2, maxW: 12, maxH: 5 },
};

// Feature-flagged widgets (no backend yet — default OFF).
const GATED_WIDGETS: Array<[boolean, string, WidgetMeta]> = [
  [FEATURES.homeActivity,    "activity", { title: "Activity",      icon: ActivityIcon, Comp: ActivityWidget, minW: 3, minH: 3, maxW: 6, maxH: 7, scroll: true }],
  [FEATURES.homeScenes,      "scenes",   { title: "Smart home",    icon: Lightbulb,    Comp: ScenesWidget,   minW: 2, minH: 2, maxW: 6, maxH: 5 }],
  [FEATURES.homeAutomations, "tools",    { title: "Automations",   icon: Wrench,       Comp: ToolsWidget,    minW: 2, minH: 2, maxW: 6, maxH: 5, scroll: true }],
  [FEATURES.homeTasks,       "tasks",    { title: "Tasks",         icon: Check,        Comp: TasksWidget,    minW: 2, minH: 2, maxW: 6, maxH: 5, scroll: true }],
];
for (const [enabled, id, meta] of GATED_WIDGETS) {
  if (enabled) WIDGETS[id] = meta;
}

export const CATALOG = Object.keys(WIDGETS).map((id) => ({
  id,
  title: WIDGETS[id].title,
  icon: WIDGETS[id].icon,
}));
