"use client";

/**
 * Droplet Home — widget components + registry.
 *
 * Ported from the Claude Design handoff. Data-display widgets (System status,
 * Models, Recent files, Cameras) are wired to the dashboard's real SWR hooks
 * and fall back to representative placeholder content while loading or when a
 * backend is unavailable, so the board always reads well. Calendar, Activity,
 * Tasks, Notes, Tools and Smart-home toggles are realistic local mock — the
 * smart-home toggles are intentionally local-only (no Matter writes) so a
 * single tap on the Home board never silently controls a real device.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { useStorage } from "@/lib/hooks/useStorage";
import { useRecents } from "@/lib/hooks/useRecents";
import { useCameras } from "@/lib/hooks/useCameras";
import { useSmartHome } from "@/lib/hooks/useSmartHome";

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
          <span className="w-chat-model">
            <span className="dot" />
            {localModel?.name ?? "llama3.1:70b"}
            <ChevronDown size={10} />
          </span>
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
const AGENDA: [string, string, string][] = [
  ["09:00", "NAS snapshot", "nightly backup · 64 GB"],
  ["13:00", "Firmware check", "3 devices pending"],
  ["18:00", "Lights · Night", "scene · living room"],
  ["21:30", "Clip retention", "prune clips over 30 days"],
];
function CalendarWidget({ h }: WidgetProps) {
  const today = new Date();
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const agendaRef = useRef<HTMLDivElement>(null);
  const [maxItems, setMaxItems] = useState(4);

  useLayoutEffect(() => {
    const el = agendaRef.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientHeight - 12;
      const rowH = 52;
      setMaxItems(Math.max(0, Math.min(AGENDA.length, Math.floor((avail + 10) / rowH))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [h]);

  const eventDays = [today.getDate(), 9, 13, 17, 22];
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
  const visible = AGENDA.slice(0, maxItems);

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
          const ev = isThisMonth && !c.out && eventDays.includes(c.d);
          return (
            <div className={"w-cal-cell" + (c.out ? " out" : "") + (isToday ? " today" : "")} key={i}>
              {c.d}
              {ev && <span className="ev" />}
            </div>
          );
        })}
      </div>
      <div className={"w-cal-agenda" + (visible.length ? " has-items" : "")} ref={agendaRef}>
        {visible.map(([t, tx, sub]) => (
          <div className="w-ag" key={t}>
            <span className="t">{t}</span>
            <span className="bar" />
            <span className="tx">{tx}<small>{sub}</small></span>
          </div>
        ))}
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

  const local = models.filter((m) => m.provider === "ollama").length;
  const cloud = models.length - local;

  const stats: [LucideIcon, string, string, string, string][] = [
    [Folder, "Files", recents.length ? String(recents.length) : "—", "recently indexed", "var(--success)"],
    [Video, "Cameras", totalCameras ? String(totalCameras) : "—", totalCameras ? "live feeds" : "none yet", "var(--brand)"],
    [Network, "Devices", totalDevices ? String(totalDevices) : "—", "smart-home online", "var(--success)"],
    [Cpu, "AI models", models.length ? String(models.length) : "—", `${local} local · ${cloud} cloud`, "var(--success)"],
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
const FILES_FALLBACK: [string, string, string][] = [
  ["sheet", "Q1-budget-final.xlsx", "2m ago"],
  ["image", "Family-photos", "14m ago"],
  ["doc", "router-config.json", "1h ago"],
  ["pdf", "network-audit-apr.pdf", "3h ago"],
  ["video", "front-door-1014.mp4", "Yesterday"],
  ["doc", "notes-home-lab.md", "Wed"],
];
function FilesWidget() {
  const { items } = useRecents(8);
  const rows: [string, string, string][] = items.length
    ? items.slice(0, 8).map((f) => [fileKind(f), f.name, relTime(f.modifiedAt)])
    : FILES_FALLBACK;
  const iconFor: Record<string, LucideIcon> = {
    doc: FileText, pdf: FileText, sheet: FileSpreadsheet, video: Video, image: ImageIcon,
  };
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
const CAMS_FALLBACK = ["Front door", "Garage", "Dock", "Lobby"];
function CamerasWidget({ w, h }: WidgetProps) {
  const { cameras } = useCameras();
  const names = cameras.length ? cameras.map((c) => c.displayName || c.name) : CAMS_FALLBACK;
  const motionSet = new Set(
    cameras.filter((c) => c.status === "detecting" || c.lastDetection).map((c) => c.displayName || c.name),
  );
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
const MODELS_FALLBACK: [boolean, string, string, "local" | "cloud"][] = [
  [false, "llama3.1:70b", "jetson · 4.2 t/s", "local"],
  [false, "qwen2.5-coder:32b", "jetson · 5.8 t/s", "local"],
  [true, "claude-sonnet-4.5", "opt-in escape", "cloud"],
  [true, "gpt-5.1", "opt-in escape", "cloud"],
];
function ModelsWidget() {
  const { models } = useModels();
  const rows: [boolean, string, string, "local" | "cloud"][] = models.length
    ? models.map((m) => {
        const isLocal = m.provider === "ollama";
        return [
          !isLocal,
          m.name,
          isLocal ? "local · on-device" : `${m.provider} · opt-in`,
          isLocal ? "local" : "cloud",
        ];
      })
    : MODELS_FALLBACK;
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

/* ─────────────────────────── Notes ─────────────────────────── */
function NotesWidget() {
  const [val, setVal] = useState("");
  useEffect(() => {
    try {
      setVal(
        window.localStorage.getItem("droplet-home-notes") ??
          "Home lab\n\n- Move cameras onto VLAN 20\n- Test WAN failover on the next drop\n- Try qwen2.5-coder for config diffs",
      );
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    try {
      if (val) window.localStorage.setItem("droplet-home-notes", val);
    } catch {
      /* ignore */
    }
  }, [val]);
  return (
    <textarea
      className="w-notes"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      aria-label="Notes"
      placeholder="Jot something down…"
    />
  );
}

/* ─────────────────────────── Registry ─────────────────────────── */
export const WIDGETS: Record<string, WidgetMeta> = {
  chat:     { title: "Ask Droplet",   icon: Sparkles,     Comp: ChatWidget,     minW: 3, minH: 4, maxW: 12, maxH: 7, feature: true },
  calendar: { title: "Calendar",      icon: Calendar,     Comp: CalendarWidget, minW: 3, minH: 3, maxW: 6,  maxH: 6 },
  status:   { title: "System status", icon: Network,      Comp: StatusWidget,   minW: 2, minH: 2, maxW: 6,  maxH: 4 },
  activity: { title: "Activity",      icon: ActivityIcon, Comp: ActivityWidget, minW: 3, minH: 3, maxW: 6,  maxH: 7, scroll: true },
  files:    { title: "Recent files",  icon: Folder,       Comp: FilesWidget,    minW: 2, minH: 2, maxW: 6,  maxH: 6, scroll: true },
  scenes:   { title: "Smart home",    icon: Lightbulb,    Comp: ScenesWidget,   minW: 2, minH: 2, maxW: 6,  maxH: 5 },
  cameras:  { title: "Cameras",       icon: Video,        Comp: CamerasWidget,  minW: 2, minH: 2, maxW: 6,  maxH: 5 },
  models:   { title: "Models",        icon: Brain,        Comp: ModelsWidget,   minW: 2, minH: 2, maxW: 6,  maxH: 5, scroll: true },
  tools:    { title: "Tools",         icon: Wrench,       Comp: ToolsWidget,    minW: 2, minH: 2, maxW: 6,  maxH: 5, scroll: true },
  tasks:    { title: "Tasks",         icon: Check,        Comp: TasksWidget,    minW: 2, minH: 2, maxW: 6,  maxH: 5, scroll: true },
  notes:    { title: "Notes",         icon: PenLine,      Comp: NotesWidget,    minW: 2, minH: 2, maxW: 12, maxH: 5 },
};

export const CATALOG = Object.keys(WIDGETS).map((id) => ({
  id,
  title: WIDGETS[id].title,
  icon: WIDGETS[id].icon,
}));
