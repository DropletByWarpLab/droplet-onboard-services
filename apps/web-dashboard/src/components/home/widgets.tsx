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
 *   · Notes       → useNotes (real /api/notes, stored on the box)
 *
 * Widgets whose backend doesn't exist yet (Tasks, Activity, Scenes, scheduled
 * Automations) are gated behind default-off feature flags and tracked in
 * `docs/feature-requests.md`. They are absent from the registry (and the Add
 * tray) unless their `NEXT_PUBLIC_FEATURE_*` flag is enabled.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  Copy,
  Cpu,
  Download,
  FileSpreadsheet,
  FileText,
  FilePlus,
  Folder,
  Globe,
  Image as ImageIcon,
  Lightbulb,
  Lock,
  MessageSquare,
  Mic,
  Network,
  Paperclip,
  PenLine,
  Pin,
  PinOff,
  Plus,
  Settings,
  ShieldOff,
  Sparkles,
  Square,
  Thermometer,
  Trash2,
  Video,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useChat } from "@/lib/hooks/useChat";
import { useStickyScroll } from "@/lib/hooks/useStickyScroll";
import { useModels } from "@/lib/hooks/useModels";
import { useRecents } from "@/lib/hooks/useRecents";
import { useCameras } from "@/lib/hooks/useCameras";
import { useSmartHome } from "@/lib/hooks/useSmartHome";
import { useVoiceHealthSummary } from "@/lib/hooks/useVoice";
import { useCalendarEvents } from "@/lib/hooks/useCalendar";
import {
  useNotes,
  createNote,
  updateNote,
  deleteNote,
  NOTE_MAX_BODY,
  type Note,
} from "@/lib/hooks/useNotes";
import { dayKey } from "@/lib/calendar";
import { FEATURES } from "@/lib/feature-flags";
import { useAuth } from "@/lib/auth";
import {
  createVpnPeer,
  deleteVpnPeer,
  fetchVpnPeers,
  fetchVpnStatus,
} from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import { dashboardUrlFromConf } from "@/lib/wireguard";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ChatMessage } from "@/components/ChatMessage";
import type {
  FileEntryInfo,
  ModelInfo,
  VpnPeerCreatedInfo,
  VpnPeerInfo,
  VpnStatusInfo,
} from "@/lib/types";
// WARP-1803 — the hero's inline conversation reuses the chat surface's
// message rendering (ChatMessage + the indigo chat skin). Both sheets are
// fully `.droplet-shell`-scoped, so importing them here styles only the
// thread wrapper below and leaks nothing into the `.droplet-home` scope.
import "@/components/shell/indigo-tokens.css";
import "@/components/chat/chat-indigo.css";

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

/**
 * WARP-1803 — the model the hero (and its inline conversation) answers with.
 * Same preference order as the chat page (WARP-1112): the household's chosen
 * default → first local (ollama) → first available. Null while the list is
 * loading or when no model is configured.
 */
function usePreferredModel(): ModelInfo | null {
  const { models, defaultModel } = useModels();
  return useMemo(
    () =>
      (defaultModel && models.find((m) => m.id === defaultModel)) ||
      models.find((m) => m.provider === "ollama") ||
      models[0] ||
      null,
    [models, defaultModel],
  );
}

/**
 * WARP-1803 — the hero tile's inline conversation. Mounted only after the
 * user submits a first prompt, so the chat machinery (and the /api/ws/events
 * bridge inside useChat) doesn't run for everyone who merely looks at Home.
 * The thread is the same server-persisted conversation the chat page reads
 * (WARP-304), so "Open full chat" deep-links to /chat?c=<id> with history
 * intact — and a stream in flight survives the jump (the orchestrator
 * finishes and persists the turn server-side, WARP-329).
 *
 * `model` is snapshotted by the parent at submit time so a models refetch
 * (or a transient empty list) can't yank a live conversation back to the
 * hero mid-answer.
 *
 * The message-list wrapper carries `droplet-shell` purely as the chat
 * surface's token/skin scope so ChatMessage renders exactly as it does on
 * /chat; `w-chat-thread` (home-widgets.css) neutralizes the shell's
 * page-level box styles so it behaves as a scroll region inside the tile.
 */
function InlineChat({
  seed,
  model,
  onNewChat,
}: {
  seed: string;
  model: ModelInfo;
  onNewChat: () => void;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const [chatId] = useState(() => `chat-${Date.now()}`);
  const {
    messages,
    isStreaming,
    sendMessage,
    stop,
    retryMessage,
    approveScene,
    conversationId,
  } = useChat({ chatId, authReady: Boolean(user) });
  const { scrollRef, onScroll, scrollToBottom, stickyScrollToBottom } =
    useStickyScroll();
  const [val, setVal] = useState("");

  // Send the seeding prompt exactly once on mount. Guarded by a ref (not
  // effect deps) because StrictMode double-invokes mount effects in dev.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    void sendMessage(seed, model.id, undefined, model.provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only seed
  }, []);

  // Same scroll contract as the chat page (WARP-295/331): follow the live
  // tail only while the user is attached; always snap when a new bubble is
  // appended (per-token growth keeps the sticky rule).
  useEffect(() => {
    stickyScrollToBottom();
  }, [messages, stickyScrollToBottom]);
  const prevLenRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevLenRef.current) scrollToBottom();
    prevLenRef.current = messages.length;
  }, [messages, scrollToBottom]);

  const send = () => {
    const body = val.trim();
    if (!body || isStreaming) return;
    setVal("");
    void sendMessage(body, model.id, undefined, model.provider);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  const handleRetry = (messageId: string) => {
    void retryMessage(messageId, model.id, undefined, model.provider);
  };
  const handleCopy = (text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard unavailable — the button is best-effort */
    }
  };

  return (
    <div className="w-chat w-chat--conv">
      <div className="w-chat-aurora" aria-hidden />
      <div className="w-chat-conv-head">
        <span className="w-chat-conv-title">
          <Sparkles size={14} />
          Ask AI
        </span>
        <button
          className="w-chat-conv-btn"
          onClick={() =>
            conversationId &&
            router.push(`/chat?c=${encodeURIComponent(conversationId)}`)
          }
          disabled={!conversationId}
          title={
            conversationId
              ? "Continue this conversation on the full chat page"
              : "Waiting for the conversation to be saved"
          }
          type="button"
        >
          <ArrowUpRight size={13} strokeWidth={2.2} />
          Open full chat
        </button>
        <button className="w-chat-conv-btn" onClick={onNewChat} type="button">
          <Plus size={13} strokeWidth={2.2} />
          New chat
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="droplet-shell w-chat-thread"
        data-testid="home-inline-thread"
      >
        <div className="w-chat-thread-inner">
          {messages.map((msg, idx) => (
            <ChatMessage
              key={msg.id}
              message={msg}
              isStreaming={
                isStreaming &&
                idx === messages.length - 1 &&
                msg.role === "assistant"
              }
              onRetry={handleRetry}
              onCopy={handleCopy}
              onApproveScene={approveScene}
            />
          ))}
        </div>
      </div>
      <div className="w-chat-capsule focus-within:ring-2 focus-within:ring-accent/40">
        <textarea
          rows={1}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={onKey}
          aria-label="Ask Droplet"
          placeholder="Reply…"
        />
        <div className="w-chat-cap-row">
          <span className="w-chat-model">
            <span className="dot" />
            <span className="nm">{model.name}</span>
          </span>
          {isStreaming ? (
            <button
              className="w-chat-send"
              onClick={() => stop()}
              title="Stop"
              type="button"
            >
              <Square size={13} strokeWidth={2.4} />
            </button>
          ) : (
            <button className="w-chat-send" onClick={send} title="Send" type="button">
              <ArrowUpRight size={15} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatWidget({ w, h }: WidgetProps) {
  const router = useRouter();
  const model = usePreferredModel();
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
  // WARP-1803 — the prompt + model snapshot that flips the tile from hero to
  // inline conversation. Answering happens right here on Home; the full chat
  // page stays one click away ("Open full chat").
  const [inline, setInline] = useState<{ seed: string; model: ModelInfo } | null>(
    null,
  );

  const go = (text?: string) => {
    const body = (text ?? val).trim();
    if (!body) return;
    if (!model) {
      // Nothing to answer with — keep the legacy hand-off: /chat renders the
      // "select a model" empty state and its pendingPrompt effect sends the
      // prompt once a model is ready.
      try {
        window.sessionStorage.setItem("droplet.pendingPrompt", body);
      } catch {
        /* private mode — /chat still opens */
      }
      router.push("/chat");
      return;
    }
    setVal("");
    setInline({ seed: body, model });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      go();
    }
  };

  if (inline) {
    return (
      <InlineChat
        seed={inline.seed}
        model={inline.model}
        onNewChat={() => setInline(null)}
      />
    );
  }

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
          {model ? (
            <span className="w-chat-model" title={model.name}>
              <span className="dot" />
              <span className="nm">{model.name}</span>
              <ChevronDown size={10} />
            </span>
          ) : (
            <span className="w-chat-model" style={{ opacity: 0.6 }}>
              <span className="dot" style={{ background: "var(--text-muted)" }} />
              <span className="nm">No model</span>
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
export function CalendarWidget({ h }: WidgetProps) {
  const router = useRouter();
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
          const cls = "w-cal-cell" + (c.out ? " out" : "") + (isToday ? " today" : "");
          // Out-of-month filler cells stay non-interactive (WARP-1131).
          if (c.out) {
            return (
              <div className={cls} key={i}>
                {c.d}
              </div>
            );
          }
          // In-month cells are real buttons: click / Enter / Space deep-links
          // to the Calendar page anchored on that day (WARP-1130/1131).
          const date = new Date(view.y, view.m, c.d);
          return (
            <button
              type="button"
              className={cls}
              key={i}
              onClick={() => router.push(`/calendar?date=${dayKey(date)}`)}
              aria-label={date.toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            >
              {c.d}
              {ev && <span className="ev" />}
            </button>
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
/**
 * One System-status stat. `href` is the surface the stat summarises — every
 * cell/row is a tap target that opens it, so the tile is a set of links into
 * the app rather than a dead read-out.
 */
type StatRow = {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  dot: string;
  href: string;
};
function StatusWidget({ w, h }: WidgetProps) {
  const router = useRouter();
  const { items: recents } = useRecents(50);
  const { models } = useModels();
  const { totalCameras } = useCameras();
  const { totalDevices } = useSmartHome();
  // WARP-1055 — the Home surface's Voice status line lives inside this
  // existing system-health tile (design brief §2), not a new tile.
  const { state: voiceState, unavailable: voiceUnavailable } =
    useVoiceHealthSummary();

  const local = models.filter((m) => m.provider === "ollama").length;
  const cloud = models.length - local;

  const voice = (value: string, sub: string, dot: string): StatRow => ({
    icon: Mic, label: "Voice", value, sub, dot, href: "/voice",
  });
  const voiceRow: StatRow =
    // Review F7 — voice-io not deployed (macOS/dev installs) is not a
    // fault: render a quiet em-dash row, never a permanent red.
    voiceUnavailable
      ? voice("—", "not available", "var(--color-label-quaternary)")
      : voiceState == null
        ? voice("—", "checking…", "var(--color-label-quaternary)")
        : // WARP-1599 — an admin switched voice off: a deliberate,
          // persisted silence, so the row stays quiet grey and says so
          // rather than reporting on a pipeline that isn't running.
          voiceState.kind === "off"
          ? voice("Off", "not listening", "var(--color-label-quaternary)")
          : voiceState.kind === "calibrated"
            ? voice("Calibrated", "wake word ready", "var(--success)")
            : voiceState.kind === "attention"
              ? voice("Attention", "needs attention", "var(--color-system-orange)")
              : voiceState.kind === "broken"
                ? voice("Not working", "microphone not working", "var(--color-system-red)")
                : voice("—", "not calibrated yet", "var(--color-label-quaternary)");

  const stats: StatRow[] = [
    { icon: Folder, label: "Files", value: recents.length ? String(recents.length) : "—", sub: "recently indexed", dot: "var(--success)", href: "/files" },
    { icon: Video, label: "Cameras", value: totalCameras ? String(totalCameras) : "—", sub: totalCameras ? "live feeds" : "none yet", dot: "var(--brand)", href: "/cameras" },
    { icon: Network, label: "Devices", value: totalDevices ? String(totalDevices) : "—", sub: "smart devices online", dot: "var(--success)", href: "/devices" },
    { icon: Cpu, label: "AI models", value: models.length ? String(models.length) : "—", sub: `${local} local · ${cloud} cloud`, dot: "var(--success)", href: "/models" },
    voiceRow,
  ];

  if (w <= 2 || h <= 2) {
    return (
      <div className="w-stat-list">
        {stats.map(({ icon: Ic, label, value, dot, href }) => (
          <button
            className="w-stat-row"
            key={label}
            type="button"
            onClick={() => router.push(href)}
            aria-label={`Open ${label}`}
          >
            <span className="ico"><Ic size={14} /></span>
            <span className="lbl">{label}</span>
            <span className="dot" style={{ background: dot }} />
            <span className="val">{value}</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="w-stat">
      {stats.map(({ icon: Ic, label, value, sub, dot, href }) => (
        <button
          className="w-stat-cell"
          key={label}
          type="button"
          onClick={() => router.push(href)}
          aria-label={`Open ${label}`}
        >
          <span className="e"><Ic size={12} />{label}</span>
          <span className="v">{value}</span>
          <span className="s"><span className="dot" style={{ background: dot }} />{sub}</span>
        </button>
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
export function FilesWidget() {
  const router = useRouter();
  const { items } = useRecents(8);
  const rows = items.slice(0, 8);
  const iconFor: Record<string, LucideIcon> = {
    doc: FileText, pdf: FileText, sheet: FileSpreadsheet, video: Video, image: ImageIcon,
  };
  if (rows.length === 0) {
    return <WEmpty>No recent files</WEmpty>;
  }
  // Deep-link into the Files page (WARP-1142/1143): folders open at that
  // folder; files open their parent with `?preview=<path>` so the page
  // selects + previews the item once its listing loads.
  const open = (f: FileEntryInfo) => {
    if (f.isDirectory) {
      router.push(`/files?path=${encodeURIComponent(f.path)}`);
    } else {
      const parent = f.path.replace(/\/[^/]*$/, "") || "/";
      router.push(
        `/files?path=${encodeURIComponent(parent)}&preview=${encodeURIComponent(f.path)}`,
      );
    }
  };
  return (
    <div className="w-list">
      {rows.map((f, i) => {
        const kind = fileKind(f);
        const Ic = iconFor[kind] ?? FileText;
        return (
          <button
            type="button"
            className="w-row"
            key={f.path + i}
            onClick={() => open(f)}
            aria-label={f.isDirectory ? `Open folder ${f.name}` : `Open ${f.name}`}
          >
            <span className={"f-ico " + kind} style={{ width: 24, height: 24, borderRadius: 6 }}>
              <Ic size={12} />
            </span>
            <span className="grow nm">{f.name}</span>
            <span className="meta">{relTime(f.modifiedAt)}</span>
          </button>
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
  const router = useRouter();
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
        <button
          className="w-cam"
          key={nm + i}
          type="button"
          style={{ background: CAM_TINTS[i % CAM_TINTS.length] }}
          onClick={() => router.push("/cameras")}
          aria-label={`Open ${nm} in Cameras`}
        >
          <span className="rec" />
          <span className="ts">{ts}</span>
          <span className="lb">{nm}</span>
          {motionSet.has(nm) && <span className="mo">motion</span>}
          {tiny && names.length > 1 && i === 0 && <span className="cam-more">+{names.length - 1}</span>}
        </button>
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
 * Notes live on the box (`/api/notes`), many per user, each pinnable. The
 * tile has two views: a list (pinned first, pin/delete per row) and an
 * editor for the note you tapped. Editing autosaves on a ~500ms debounce
 * with a legible status line — "Saving…" while a write is pending, "Saved"
 * once it lands, "Not saved — retrying" if the box refused it — instead of
 * writing on every keystroke with no feedback.
 *
 * Every failure path here is a data-loss path, because the box is now the
 * only copy: a failed LIST says so rather than rendering the empty state, a
 * failed SAVE keeps the text pending and keeps trying, and DELETE is
 * confirm-gated.
 *
 * Before this, the tile was a single string in this browser's localStorage:
 * unsynced, unpinnable, and wiped by "New note". That key is uploaded once
 * (see `useLegacyNoteImport`) so nobody's existing note disappears.
 */
const NOTES_KEY = "droplet-home-notes";
const NOTES_IMPORTED_KEY = "droplet-home-notes-imported";
/** Prefix of the in-flight-import marker written to `NOTES_IMPORTED_KEY`,
 *  followed by the epoch-ms the claim was taken. */
const NOTES_IMPORT_CLAIM = "pending:";
/** How long a claim is honoured before another tab may take it over. Must
 *  outlast apiFetch's 20s request timeout (so a slow-but-live upload is never
 *  raced), and be short enough that a tab closed mid-upload doesn't strand the
 *  note for the rest of the session. */
const NOTES_IMPORT_CLAIM_TTL_MS = 30_000;
const NOTES_SAVE_DEBOUNCE_MS = 500;
/** Gap before an autosave the box refused (asleep, Wi-Fi dropped) tries
 *  again. Long enough not to hammer a box that's down; short enough that a
 *  blip clears itself while the customer is still looking at the tile. */
const NOTES_SAVE_RETRY_MS = 3000;
/** Longest note name we render anywhere. */
const NOTE_TITLE_MAX = 80;
type NotesSaveStatus = "idle" | "saving" | "saved" | "error";

/** The first non-empty line names a note in the list; a brand-new one has none. */
function noteTitle(n: Note): string {
  const first = n.body.split("\n").find((l) => l.trim().length > 0)?.trim();
  if (!first) return "Empty note";
  // The list ellipsises in CSS, but the delete confirmation echoes this name
  // as a monospace identifier and screen readers read it out of an aria-label
  // — neither wants a 2000-character first line.
  return first.length > NOTE_TITLE_MAX
    ? `${first.slice(0, NOTE_TITLE_MAX).trimEnd()}…`
    : first;
}

/** One-time lift of the old browser-local note onto the box. Runs once per
 *  browser (guarded by its own localStorage flag) and only when there is
 *  something to move — then clears the legacy key so it can't be re-imported
 *  as a duplicate if the flag is lost.
 *
 *  The flag is CLAIMED before the upload, not after: localStorage is shared
 *  across tabs with no lock, so two tabs opening Home together would both read
 *  an empty flag and both POST, landing the customer's one old note on the box
 *  twice. A tab that finds a fresh claim stands down; a stale one (the holder
 *  was closed mid-upload) is taken over so the note is never stranded. */
function useLegacyNoteImport(onImported: () => void) {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    let legacy: string | null = null;
    try {
      const flag = window.localStorage.getItem(NOTES_IMPORTED_KEY);
      // Anything that isn't a claim means the import already happened.
      if (flag && !flag.startsWith(NOTES_IMPORT_CLAIM)) return;
      if (flag) {
        const claimedAt = Number(flag.slice(NOTES_IMPORT_CLAIM.length));
        if (Date.now() - claimedAt < NOTES_IMPORT_CLAIM_TTL_MS) return;
      }
      legacy = window.localStorage.getItem(NOTES_KEY);
    } catch {
      return; // private mode — nothing to import from
    }
    const body = legacy?.trim();
    if (!body) {
      try {
        window.localStorage.setItem(NOTES_IMPORTED_KEY, "1");
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      window.localStorage.setItem(
        NOTES_IMPORTED_KEY,
        `${NOTES_IMPORT_CLAIM}${Date.now()}`,
      );
    } catch {
      /* ignore */
    }
    void createNote({ body })
      .then(() => {
        try {
          window.localStorage.setItem(NOTES_IMPORTED_KEY, "1");
          window.localStorage.removeItem(NOTES_KEY);
        } catch {
          /* ignore */
        }
        onImported();
      })
      // Offline / server down: drop our claim and leave the legacy key alone
      // so the next mount tries again. Never drop the customer's text.
      .catch(() => {
        try {
          const held = window.localStorage.getItem(NOTES_IMPORTED_KEY);
          if (held?.startsWith(NOTES_IMPORT_CLAIM)) {
            window.localStorage.removeItem(NOTES_IMPORTED_KEY);
          }
        } catch {
          /* ignore */
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** The editor half of the tile: one note's body, debounced-autosaved. */
function NoteEditor({
  note,
  onClose,
  onSaved,
}: {
  note: Note;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [val, setVal] = useState(note.body);
  const [status, setStatus] = useState<NotesSaveStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of `val` + a pending-save flag for the unmount flush, which can't
  // read the latest state through a stale `[]`-effect closure.
  const valRef = useRef(note.body);
  const pendingRef = useRef(false);
  // False once the editor is gone, so a request that fails after unmount can't
  // schedule a retry against a component nobody is looking at.
  const aliveRef = useRef(true);

  // Annotated because the retry below references `save` from inside its own
  // initializer, which tsc otherwise can't type.
  const save: (next: string) => void = useCallback(
    (next: string) => {
      pendingRef.current = false;
      void updateNote(note.id, { body: next })
        .then(() => {
          setStatus("saved");
          onSaved();
        })
        .catch(() => {
          // A refused save must never eat the typing. Put the edit back in the
          // pending slot so the unmount flush still carries it, say so on the
          // status line instead of silently reading "idle", and keep trying
          // while the editor is open — notes live only on the box now, so
          // there is no localStorage copy left to recover from.
          if (!aliveRef.current) return;
          pendingRef.current = true;
          setStatus("error");
          timerRef.current = setTimeout(
            () => save(valRef.current),
            NOTES_SAVE_RETRY_MS,
          );
        });
    },
    [note.id, onSaved],
  );

  // Debounced autosave. The first render is skipped (val === the note we were
  // handed) so opening a note doesn't flash a status or write it back.
  useEffect(() => {
    valRef.current = val;
    if (val === note.body && !pendingRef.current) return;
    pendingRef.current = true;
    setStatus("saving");
    timerRef.current = setTimeout(() => save(val), NOTES_SAVE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [val]);

  // Unmount-only: commit a still-pending edit so navigating off Home (or
  // closing the editor) never drops up to ~500ms of typing. The rejection is
  // swallowed — there is no surface left to report it on, and an unhandled
  // rejection here would surface as a console error on every offline close.
  useEffect(() => {
    // Re-armed on mount, not just initialised: React StrictMode (on by default
    // in dev) mounts → unmounts → remounts, and a ref survives that round trip.
    // Without this the editor would come back permanently "dead" and stop
    // reporting or retrying failed saves for the rest of the dev session.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (pendingRef.current) {
        void updateNote(note.id, { body: valRef.current }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="w-notes-wrap">
      <textarea
        className="w-notes"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        aria-label="Note"
        placeholder="Jot something down…"
        // Same ceiling the orchestrator enforces: stop the keystroke rather
        // than let the autosave take a 400 the customer can't act on.
        maxLength={NOTE_MAX_BODY}
        autoFocus
      />
      <div className="w-notes-bar">
        <span
          className="w-notes-status"
          role="status"
          aria-live="polite"
          data-state={status}
        >
          {status === "saving"
            ? "Saving…"
            : status === "saved"
              ? "Saved"
              : status === "error"
                ? "Not saved — retrying"
                : ""}
        </span>
        <button className="w-notes-new" type="button" onClick={onClose}>
          <ChevronLeft size={13} />
          All notes
        </button>
      </div>
    </div>
  );
}

export function NotesWidget() {
  const { notes, error, isLoading, refresh } = useNotes();
  const [openId, setOpenId] = useState<string | null>(null);
  // Delete-confirm state + the row button that opened it, so focus restores
  // there on close — same pattern as CoverageExtendersPanel's remove confirm.
  const [confirmDelete, setConfirmDelete] = useState<Note | null>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  useLegacyNoteImport(() => void refresh());

  const open = notes.find((n) => n.id === openId) ?? null;
  // The note was deleted in another tab while open — fall back to the list
  // rather than editing a row that no longer exists.
  useEffect(() => {
    if (openId && !isLoading && !open) setOpenId(null);
  }, [openId, isLoading, open]);

  const addNote = async () => {
    const { note } = await createNote({ body: "" });
    await refresh();
    setOpenId(note.id);
  };

  const togglePin = async (n: Note) => {
    await updateNote(n.id, { pinned: !n.pinned });
    await refresh();
  };

  const remove = async (n: Note) => {
    await deleteNote(n.id);
    if (openId === n.id) setOpenId(null);
    await refresh();
  };

  if (open) {
    return (
      <NoteEditor
        note={open}
        onClose={() => setOpenId(null)}
        onSaved={() => void refresh()}
      />
    );
  }

  return (
    <div className="w-notes-wrap">
      <div className="w-note-list">
        {/* A failed load is NOT an empty account. Notes no longer have a
            localStorage copy behind them, so rendering "No notes yet" over a
            dead fetch reads as "the migration ate my notes". Branch on the
            error first and say what actually happened. */}
        {error ? (
          <WEmpty>
            <span className="w-notes-err" role="alert">
              <AlertTriangle size={12} aria-hidden />
              <span>{translateError(error, "notes")}</span>
            </span>
          </WEmpty>
        ) : notes.length === 0 ? (
          <WEmpty>{isLoading ? "Loading notes…" : "No notes yet"}</WEmpty>
        ) : (
          notes.map((n) => {
            const title = noteTitle(n);
            return (
              <div className={"w-note" + (n.pinned ? " pinned" : "")} key={n.id}>
                <button
                  className="w-note-open"
                  type="button"
                  onClick={() => setOpenId(n.id)}
                >
                  {n.pinned && <Pin size={11} className="pin" aria-hidden />}
                  <span className="nm">{title}</span>
                </button>
                <button
                  className="w-note-act"
                  type="button"
                  onClick={() => void togglePin(n)}
                  aria-label={n.pinned ? `Unpin ${title}` : `Pin ${title}`}
                  aria-pressed={n.pinned}
                >
                  {n.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                </button>
                <button
                  className="w-note-act"
                  type="button"
                  onClick={(e) => {
                    deleteTriggerRef.current = e.currentTarget;
                    setConfirmDelete(n);
                  }}
                  aria-label={`Delete ${title}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>
      <div className="w-notes-bar">
        <span className="w-notes-status">
          {notes.some((n) => n.pinned)
            ? `${notes.filter((n) => n.pinned).length} pinned`
            : ""}
        </span>
        <button className="w-notes-new" type="button" onClick={() => void addNote()}>
          <FilePlus size={13} />
          New note
        </button>
      </div>

      {/* Delete is irreversible and its 44px target sits next to Pin at the
          right edge of a scrollable list — on a phone a flick-scroll that
          lands as a tap would destroy the note, and there is no localStorage
          copy left to recover it from. Same ConfirmDialog gate every other
          destructive action in the dashboard uses. */}
      <ConfirmDialog
        open={confirmDelete !== null}
        triggerRef={deleteTriggerRef}
        title="Delete this note?"
        description="The note will be removed from your Droplet and from every device you're signed in on. This can't be undone."
        confirmLabel="Delete"
        cancelLabel="Keep it"
        variant="destructive"
        confirmedIdentifier={confirmDelete ? noteTitle(confirmDelete) : undefined}
        onConfirm={async () => {
          if (confirmDelete) await remove(confirmDelete);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/* ─────────────────────────── Remote access (Connect) ─────────────────────────── */

const CONF_CLIPBOARD_TTL_MS = 30_000;

/**
 * RemoteAccessWidget — the one-tap Connect toggle on Home (WARP-1351).
 *
 * Ports the WARP-979 VpnStep contract onto the bento board: flipping the
 * switch on mints a peer with the auto-derived "This device" label and
 * surfaces the one-shot QR/.conf in a dialog; when active peers already
 * exist the switch reports on, and flipping it off is confirm-gated — it
 * revokes only the current user's own active devices. Backed by the real
 * /api/vpn endpoints, with an honest blocked state while the box is still
 * learning its web address (WARP-1313).
 */
export function RemoteAccessWidget(_: WidgetProps) {
  const { user } = useAuth();
  const [status, setStatus] = useState<VpnStatusInfo | null>(null);
  const [peers, setPeers] = useState<VpnPeerInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<VpnPeerCreatedInfo | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await fetchVpnStatus();
      setStatus(s);
      if ((s.peerCount ?? 0) > 0) {
        // Peer list unavailable → fall back to the off-toggle rather than a
        // half-rendered on-state (same posture as VpnStep).
        const { peers: all } = await fetchVpnPeers().catch(() => ({
          peers: [] as VpnPeerInfo[],
        }));
        setPeers(all.filter((p) => p.status === "active"));
      } else {
        setPeers([]);
      }
    } catch {
      setStatus(null);
      setPeers([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const endpointBlocked = !status?.endpointConfigured;
  // WARP-1391: the one-tap mint is HOME mode — Endpoint = the box's discovered
  // home-facing LAN IP (resolveHomeEndpointHost), NOT the away-mode default's
  // split-horizon public FQDN (that FQDN is public-NXDOMAIN by design —
  // WARP-954 / ADR-023 — so an away conf shows keepalive but zero handshakes).
  // Without a discovered home LAN IP a home mint 503s, so the switch must be
  // inert here too — same posture as remote-access/page.tsx and VpnStep. Only
  // applies once status has loaded; missing ⇒ "not reachable at home yet" (the
  // WARP-993 never-over-promise convention). A null status (load failure) is
  // already covered by endpointBlocked.
  const homeBlocked = loaded && Boolean(status) && !status?.homeEndpointHost;
  const blocked = endpointBlocked || homeBlocked;
  const on = peers.length > 0;
  const mine = user?.username
    ? peers.filter((p) => p.userId === user.username)
    : [];
  const fqdn = status?.publicFqdn?.trim() || status?.endpointHost || null;

  // Mint with the auto-derived label — the WARP-979 one-tap path.
  const connect = async () => {
    setError(null);
    setSubmitting(true);
    try {
      // WARP-1391: mint HOME mode explicitly. The orchestrator route defaults to
      // "away" (a byte-identical pre-hybrid compat contract, PR #897) which bakes
      // the split-horizon public FQDN Endpoint — public-NXDOMAIN by design, so the
      // conf shows keepalive but zero handshakes. Home bakes the box LAN IP and
      // works today; the switch is gated inert on homeEndpointHost above.
      const result = await createVpnPeer("This device", "home");
      setCreated(result);
      await load();
    } catch (e) {
      setError(translateError(e, "vpn"));
    } finally {
      setSubmitting(false);
    }
  };

  const disconnect = async () => {
    setError(null);
    try {
      for (const p of mine) {
        await deleteVpnPeer(p.id);
      }
      setConfirmOff(false);
      await load();
    } catch (e) {
      // Partial revocation is possible — refetch so the count is honest, then
      // re-throw so the ConfirmDialog stays open for retry (its contract).
      await load();
      setError(translateError(e, "vpn"));
      throw e;
    }
  };

  // The switch is inert while loading/blocked/minting, and while on with no
  // devices of your own to revoke (others manage theirs in Remote Access).
  const inert = !loaded || blocked || submitting || (on && mine.length === 0);

  const flip = () => {
    if (inert) return;
    if (on) setConfirmOff(true);
    else void connect();
  };

  const sub = !loaded
    ? "Checking…"
    : endpointBlocked
      ? "Web address not ready yet"
      : homeBlocked
        ? "Local address not ready yet"
        : submitting
          ? "Connecting this device…"
          : on
            ? `On · ${peers.length} connected device${peers.length === 1 ? "" : "s"}`
            : "Off · tap to connect this device";

  const copyConf = () => {
    if (!created) return;
    navigator.clipboard.writeText(created.conf).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      // Same hygiene as VpnStep: don't leave a private key on the clipboard.
      setTimeout(() => {
        navigator.clipboard.writeText("").catch(() => {});
      }, CONF_CLIPBOARD_TTL_MS);
    });
  };

  const downloadConf = () => {
    if (!created) return;
    const safeName =
      created.peer.deviceLabel.replace(/[^a-z0-9_-]+/gi, "_") || "wg-peer";
    const blob = new Blob([created.conf], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName}.conf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="w-remote">
      <div
        className={"w-dev" + (on || submitting ? " on" : "")}
        role="switch"
        aria-checked={on || submitting}
        aria-disabled={inert || undefined}
        aria-label="Remote access"
        aria-describedby="w-remote-sub"
        tabIndex={0}
        onClick={flip}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            flip();
          }
        }}
      >
        <span className="di">
          <Globe size={14} />
        </span>
        <span className="dn">
          <div className="nm">Droplet VPN</div>
          <div className="sb" id="w-remote-sub">{sub}</div>
        </span>
        <span className="w-toggle">
          <span className="ball" />
        </span>
      </div>

      <div className="w-remote-addr">
        {fqdn ? (
          <span className="addr">https://{fqdn}</span>
        ) : (
          <span className="ph">your secure address</span>
        )}
        <a className="w-remote-link" href="/remote-access">
          Remote access
          <ArrowUpRight size={12} />
        </a>
      </div>

      {error && (
        <div className="w-remote-err" role="alert">
          <AlertTriangle size={12} />
          <span>{error}</span>
        </div>
      )}

      {created && (
        <Dialog
          open
          onClose={() => setCreated(null)}
          labelledBy="w-remote-qr-title"
          maxWidth="md"
          flush
        >
          <div>
            <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
              <h3
                id="w-remote-qr-title"
                className="type-headline text-label-primary"
              >
                Scan to connect
              </h3>
              <button
                onClick={() => setCreated(null)}
                className="p-1 text-label-tertiary hover:text-label-primary"
                aria-label="Close"
                type="button"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <ol className="type-footnote text-label-secondary list-decimal pl-5 space-y-1">
                <li>
                  Install <strong>WireGuard</strong> from the App Store or Play
                  Store.
                </li>
                <li>
                  Open the app, tap <strong>+</strong>, choose{" "}
                  <strong>Create from QR code</strong>, and scan the code below.
                </li>
                <li>
                  Activate the tunnel, then open{" "}
                  <strong className="font-mono break-all">
                    {dashboardUrlFromConf(
                      created.conf,
                      status?.publicFqdn ?? undefined,
                    )}
                  </strong>{" "}
                  in the browser —{" "}
                  {/* WARP-993: only promise "from anywhere" when the minted
                      conf is actually routable off-LAN (echoed on the create
                      response; missing ⇒ stay honest). */}
                  {created.offLanReachable === true
                    ? "that’s this Droplet from anywhere."
                    : "that’s this Droplet on your local network."}
                </li>
              </ol>
              <div className="flex justify-center">
                <div className="p-4 bg-white rounded-lg">
                  <QRCodeSVG
                    value={created.conf}
                    size={224}
                    level="M"
                    includeMargin={false}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={copyConf}
                  className="flex-1 dp-btn-secondary type-footnote !min-h-[36px] !py-1.5"
                  type="button"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copied" : "Copy text"}
                </button>
                <button
                  onClick={downloadConf}
                  className="flex-1 dp-btn-secondary type-footnote !min-h-[36px] !py-1.5"
                  type="button"
                >
                  <Download size={14} />
                  Download .conf
                </button>
              </div>
              <div className="p-3 bg-system-orange/10 border border-system-orange/20 rounded type-caption-1 text-system-orange flex items-start gap-2">
                <ShieldOff size={14} className="mt-0.5 flex-shrink-0" />
                <span>
                  Save this now — the private key is shown once. If you lose it,
                  revoke this device and add a new one.
                </span>
              </div>
              <div className="flex justify-end pt-1">
                <button
                  onClick={() => setCreated(null)}
                  className="dp-btn-primary type-subheadline !min-h-[36px] !py-1.5"
                  type="button"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </Dialog>
      )}

      <ConfirmDialog
        open={confirmOff}
        onConfirm={disconnect}
        onCancel={() => setConfirmOff(false)}
        title="Turn off remote access?"
        description={
          "Your devices will be disconnected immediately and the WireGuard config on each of them will stop working. You can reconnect any time with one tap." +
          (peers.length > mine.length
            ? " Other members’ devices stay connected."
            : "")
        }
        confirmLabel="Turn off"
        variant="destructive"
      />
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
  // WARP-648: the Home bento tile's chrome title is the visible label a user
  // sees for the /chat destination on this surface (also shown in the
  // "add widget" catalog). It must match the Sidebar nav label ("Ask AI") —
  // one product noun for the one destination. The greeting copy and composer
  // placeholder inside the widget are conversational hint text, not a
  // destination label, so they're intentionally left as "Ask Droplet ...".
  chat:     { title: "Ask AI",        icon: Sparkles,     Comp: ChatWidget,     minW: 3, minH: 4, maxW: 12, maxH: 7, feature: true },
  calendar: { title: "Calendar",      icon: Calendar,     Comp: CalendarWidget, minW: 3, minH: 3, maxW: 6,  maxH: 6 },
  status:   { title: "System status", icon: Network,      Comp: StatusWidget,   minW: 2, minH: 2, maxW: 6,  maxH: 4 },
  remote:   { title: "Remote access", icon: Globe,        Comp: RemoteAccessWidget, minW: 2, minH: 2, maxW: 6, maxH: 4 },
  files:    { title: "Recent files",  icon: Folder,       Comp: FilesWidget,    minW: 2, minH: 2, maxW: 6,  maxH: 6, scroll: true },
  cameras:  { title: "Cameras",       icon: Video,        Comp: CamerasWidget,  minW: 2, minH: 2, maxW: 6,  maxH: 5 },
  models:   { title: "Models",        icon: Brain,        Comp: ModelsWidget,   minW: 2, minH: 2, maxW: 6,  maxH: 5, scroll: true },
  notes:    { title: "Notes",         icon: PenLine,      Comp: NotesWidget,    minW: 2, minH: 2, maxW: 12, maxH: 5 },
};

// Feature-flagged widgets (no backend yet — default OFF).
const GATED_WIDGETS: Array<[boolean, string, WidgetMeta]> = [
  [FEATURES.homeActivity,    "activity", { title: "Activity",      icon: ActivityIcon, Comp: ActivityWidget, minW: 3, minH: 3, maxW: 6, maxH: 7, scroll: true }],
  [FEATURES.homeScenes,      "scenes",   { title: "Smart devices", icon: Lightbulb,    Comp: ScenesWidget,   minW: 2, minH: 2, maxW: 6, maxH: 5 }],
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
