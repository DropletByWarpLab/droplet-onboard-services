"use client";

/**
 * Droplet Home — a chat-centered bento dashboard.
 *
 * The chat hero is the centerpiece (a bare, card-less block — the page IS the
 * chat), surrounded by modular widgets the user can rearrange and resize in an
 * explicit Edit-layout mode: drag to reorder with live reflow + split-to-share,
 * drag a corner to resize, and the board auto-fills gaps on settle. Display
 * density (Balanced / Dense / Airy) lives in a Settings panel and persists, as
 * does each density's layout. Below 760px it collapses to a sound single-column
 * stack (the app shell already supplies the mobile bottom nav).
 *
 * The app shell (AuthGate) provides the violet Sidebar + mobile nav around this
 * `<main>`. This file is just the Home surface content. The indigo identity and
 * all generic class names are scoped under `.droplet-home` (see the two CSS
 * imports) so nothing leaks into the rest of the dashboard, and it tracks the
 * repo's light/dark theme via the `.dark` class on <html>.
 *
 * Note: chat / files / cameras / models / system-status read live data via the
 * dashboard's SWR hooks; calendar, activity, tasks, notes, tools and the
 * smart-home toggles are representative local content for now.
 */

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  Check,
  LayoutGrid,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Crosshair,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useDevice } from "@/lib/hooks/useDevice";
import { fetchSystemHealth, type SystemHealth } from "@/lib/api";
import { resolveHealthCopy } from "./health-copy";
import { BentoBoard } from "@/components/home/BentoBoard";
import { AmbientLayer } from "@/components/home/AmbientLayer";
import { WIDGETS, CATALOG } from "@/components/home/widgets";
import { fillGaps, type LayoutItem } from "@/components/home/bento-engine";
import "@/components/home/home-bento.css";
import "@/components/home/home-widgets.css";

/* The chat capsule carries `focus-within:ring-2 focus-within:ring-accent/40`
   and the textarea an `aria-label="Ask Droplet"` (WARP-298) — both defined in
   components/home/widgets.tsx (ChatWidget), which is also where the WARP-298
   source-guard test (home.hero-focus.test.tsx) asserts the contract. */

type DensityKey = "balanced" | "dense" | "airy";

interface Density {
  label: string;
  cols: number;
  gap: number;
  rowH: number;
  desc: string;
  cells: number;
}

const DIRECTIONS: Record<DensityKey, Density> = {
  balanced: { label: "Balanced", cols: 12, gap: 16, rowH: 96, desc: "Comfortable spacing. The default home.", cells: 6 },
  dense: { label: "Dense", cols: 12, gap: 12, rowH: 78, desc: "Tighter grid — more on screen at once.", cells: 9 },
  airy: { label: "Airy", cols: 12, gap: 22, rowH: 104, desc: "Generous spacing — calmer, larger cards.", cells: 4 },
};

const DEFAULTS: Record<DensityKey, LayoutItem[]> = {
  balanced: [
    { id: "chat", w: 8, h: 5 }, { id: "calendar", w: 4, h: 3 }, { id: "status", w: 4, h: 2 },
    { id: "activity", w: 4, h: 3 }, { id: "files", w: 4, h: 3 }, { id: "cameras", w: 4, h: 3 },
    { id: "tasks", w: 3, h: 3 }, { id: "scenes", w: 3, h: 3 }, { id: "models", w: 3, h: 3 },
    { id: "tools", w: 3, h: 3 }, { id: "notes", w: 12, h: 2 },
  ],
  dense: [
    { id: "chat", w: 6, h: 5 }, { id: "status", w: 3, h: 2 }, { id: "calendar", w: 3, h: 5 },
    { id: "models", w: 3, h: 2 }, { id: "cameras", w: 4, h: 3 }, { id: "activity", w: 4, h: 4 },
    { id: "files", w: 4, h: 4 }, { id: "tasks", w: 3, h: 2 }, { id: "tools", w: 3, h: 2 },
    { id: "scenes", w: 3, h: 2 }, { id: "notes", w: 12, h: 2 },
  ],
  airy: [
    { id: "chat", w: 7, h: 5 }, { id: "calendar", w: 5, h: 5 }, { id: "activity", w: 4, h: 3 },
    { id: "tasks", w: 4, h: 3 }, { id: "scenes", w: 4, h: 3 }, { id: "status", w: 6, h: 2 },
    { id: "notes", w: 6, h: 2 },
  ],
};

const ADD_SIZE: Record<string, { w: number; h: number }> = {
  chat: { w: 6, h: 5 }, calendar: { w: 3, h: 4 }, status: { w: 3, h: 2 }, activity: { w: 4, h: 3 },
  files: { w: 3, h: 3 }, scenes: { w: 3, h: 3 }, cameras: { w: 4, h: 3 }, models: { w: 3, h: 3 },
  tools: { w: 3, h: 3 }, tasks: { w: 3, h: 3 }, notes: { w: 3, h: 2 },
};

const LS = "droplet-home-bento-v1-";
const VALID_IDS = Object.keys(WIDGETS);

// The default layout, minus any widget not in the active registry (a
// feature-flagged widget whose backend isn't built yet is absent from
// WIDGETS), repacked so removing it leaves no gap.
function defaultsFor(dir: DensityKey): LayoutItem[] {
  const valid = DEFAULTS[dir].filter((x) => VALID_IDS.includes(x.id)).map((x) => ({ ...x }));
  return fillGaps(valid, DIRECTIONS[dir].cols, WIDGETS);
}

function loadLayout(dir: DensityKey): LayoutItem[] {
  if (typeof window === "undefined") return defaultsFor(dir);
  try {
    const raw = JSON.parse(window.localStorage.getItem(LS + dir) ?? "null");
    if (Array.isArray(raw) && raw.length) {
      // Bound w/h so a corrupted or crafted entry can't blow up the board:
      // width never exceeds the grid; height capped well above any real widget.
      const cols = DIRECTIONS[dir].cols;
      const clean = raw.filter(
        (it) =>
          it &&
          VALID_IDS.includes(it.id) &&
          Number.isFinite(it.w) &&
          it.w > 0 &&
          it.w <= cols &&
          Number.isFinite(it.h) &&
          it.h > 0 &&
          it.h <= 20,
      );
      if (clean.length) return fillGaps(clean, cols, WIDGETS);
    }
  } catch {
    /* ignore */
  }
  return defaultsFor(dir);
}

function useIsMobile(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

function greetingNow(): string {
  const hr = new Date().getHours();
  if (hr < 5) return "Still up";
  if (hr < 12) return "Good morning";
  if (hr < 18) return "Good afternoon";
  if (hr < 22) return "Good evening";
  return "Working late";
}

/* ─────────────────────────── Settings (density) ─────────────────────────── */
function SettingsModal({
  open,
  onClose,
  dir,
  setDir,
}: {
  open: boolean;
  onClose: () => void;
  dir: DensityKey;
  setDir: (d: DensityKey) => void;
}) {
  // Keep the modal mounted through its exit animation, then unmount.
  const [render, setRender] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setRender(true);
      setClosing(false);
      return;
    }
    if (render) {
      setClosing(true);
      const t = window.setTimeout(() => {
        setRender(false);
        setClosing(false);
      }, 150);
      return () => window.clearTimeout(t);
    }
  }, [open, render]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!render) return null;
  return (
    <div className={"dh-modal-overlay" + (closing ? " closing" : "")} onClick={onClose}>
      <div className="dh-modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="dh-modal-head">
          <span className="dh-modal-title">Settings</span>
          <button className="dh-modal-x" onClick={onClose} aria-label="Close" type="button">
            <X size={16} />
          </button>
        </div>
        <div className="dh-modal-body">
          <div className="dh-set-h">
            <span className="dh-set-ico"><LayoutGrid size={15} /></span>
            <div>
              <div className="t">Display density</div>
              <div className="d">Choose how much information fits on screen. Applies to the Home board.</div>
            </div>
          </div>
          <div className="dh-density" role="radiogroup" aria-label="Display density">
            {(Object.keys(DIRECTIONS) as DensityKey[]).map((k) => {
              const o = DIRECTIONS[k];
              const active = dir === k;
              return (
                <button
                  key={k}
                  className={"dh-opt" + (active ? " active" : "")}
                  onClick={() => setDir(k)}
                  role="radio"
                  aria-checked={active}
                  type="button"
                >
                  <span className={"dh-prev " + k}>
                    {Array.from({ length: o.cells }).map((_, i) => <i key={i} />)}
                  </span>
                  <span className="dh-opt-txt">
                    <span className="t">{o.label}</span>
                    <span className="d">{o.desc}</span>
                  </span>
                  <span className="dh-radio" />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Mobile (single column) ─────────────────────────── */
function MobileBoard({ items }: { items: LayoutItem[] }) {
  return (
    <div className="dh-m-board">
      {items.map((it) => {
        const reg = WIDGETS[it.id];
        if (!reg) return null;
        const Comp = reg.Comp;
        const Icon = reg.icon;
        return (
          <div key={it.id} className={"bento" + (reg.feature ? " bento--hero" : "")}>
            {!reg.feature && (
              <div className="bento-head">
                <span className="wi"><Icon size={14} /></span>
                <span className="wt">{reg.title}</span>
              </div>
            )}
            <div className={"bento-body" + (reg.scroll ? " scroll" : "")}>
              <Comp w={4} h={Math.max(it.h, 3)} editing={false} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────── Page ─────────────────────────── */
export default function DashboardPage() {
  const { user } = useAuth();
  const { device } = useDevice();
  const isMobile = useIsMobile();

  const [dir, setDir] = useState<DensityKey>("balanced");
  const [editMode, setEditMode] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [layouts, setLayouts] = useState<Record<DensityKey, LayoutItem[]>>({
    balanced: defaultsFor("balanced"),
    dense: defaultsFor("dense"),
    airy: defaultsFor("airy"),
  });

  // Hydrate persisted density + layouts after mount (avoids SSR mismatch).
  useEffect(() => {
    const d = window.localStorage.getItem(LS + "dir") as DensityKey | null;
    setDir(d && DIRECTIONS[d] ? d : "balanced");
    setLayouts({
      balanced: loadLayout("balanced"),
      dense: loadLayout("dense"),
      airy: loadLayout("airy"),
    });
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(LS + "dir", dir);
    } catch {
      /* ignore */
    }
  }, [dir]);

  const items = layouts[dir];
  const cfg = DIRECTIONS[dir];

  const persist = (next: LayoutItem[]) => {
    setLayouts((L) => {
      const n = { ...L, [dir]: next };
      try {
        window.localStorage.setItem(LS + dir, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return n;
    });
  };

  const onChange = (next: LayoutItem[]) => persist(next);
  const onRemove = (id: string) =>
    persist(fillGaps(items.filter((it) => it.id !== id), cfg.cols, WIDGETS));
  const onAdd = (id: string) => {
    const s = ADD_SIZE[id] || { w: 3, h: 3 };
    persist(fillGaps([...items, { id, ...s }], cfg.cols, WIDGETS));
  };
  const onReset = () => persist(defaultsFor(dir));

  const hidden = CATALOG.filter((c) => !items.some((it) => it.id === c.id));

  const firstName = useMemo(() => {
    const raw = user?.displayName || user?.username || "";
    return raw.split(/[\s@.]/)[0] || "";
  }, [user]);

  const greeting = greetingNow();
  const dateStr = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const host = device?.hostname || "droplet";

  // Live rolled-up system health (WARP-43) drives the always-visible toolbar
  // chip — dot colour + label track ok / degraded / down rather than being
  // hardcoded green. `unknown` covers loading, fetch errors, and any status
  // outside the union (resolveHealthCopy is total — see app/health-copy.ts).
  const { data: systemHealth } = useSWR<SystemHealth>(
    "/api/orchestrator/health",
    fetchSystemHealth,
    { refreshInterval: 15_000 },
  );
  const healthStatus = systemHealth?.status ?? "unknown";
  const healthCopy = resolveHealthCopy(healthStatus);

  if (isMobile) {
    return (
      <div className="droplet-home dh-mobile">
        <AmbientLayer />
        <h1 className="sr-only">Droplet Home</h1>
        <div className="dh-m-greet">
          <div className="g">{greeting}{firstName && <b>, {firstName}</b>}</div>
          <div className="d">{dateStr.toLowerCase()} · {host}</div>
        </div>
        <MobileBoard items={items} />
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} dir={dir} setDir={setDir} />
      </div>
    );
  }

  return (
    <div className={"droplet-home" + (editMode ? " editing" : "")}>
      <AmbientLayer />
      <h1 className="sr-only">Droplet Home</h1>

      <div className="dh-top">
        <div className="dh-greet">
          <span className="g">{greeting}{firstName && <b>, {firstName}</b>}</span>
          <span className="d">{dateStr.toLowerCase()}</span>
        </div>

        <span className="dh-spring" />

        <span className={"dh-status-chip is-" + healthStatus}>
          <span className="dot" />
          <span className="host">{host}</span>
          <span className="mid extra">·</span>
          <span className="extra">{healthCopy.label}</span>
        </span>

        <button
          className="dh-icon-btn"
          onClick={() => setSettingsOpen(true)}
          title="Settings — display density"
          aria-label="Settings"
          type="button"
        >
          <SettingsIcon size={16} />
        </button>

        <button
          className={"dh-edit-toggle" + (editMode ? " on" : "")}
          onClick={() => setEditMode((v) => !v)}
          type="button"
        >
          {editMode ? <Check size={15} strokeWidth={2.2} /> : <LayoutGrid size={14} />}
          {editMode ? "Done" : "Edit layout"}
        </button>
      </div>

      <div className="dh-edit-bar">
        <div className="dh-edit-bar-pad">
          <span className="dh-edit-hint">
            <Crosshair size={14} style={{ color: "var(--brand)" }} />
            Drag a card to rearrange · drag its corner <span className="k">⌟</span> to resize
          </span>
          <span className="dh-divider" />
          <div className="dh-tray">
            <span className="dh-tray-label">Add</span>
            {hidden.length === 0 && <span className="dh-tray-empty">all widgets placed</span>}
            {hidden.map((c) => {
              const Icon = c.icon;
              return (
                <button key={c.id} className="dh-tray-chip" onClick={() => onAdd(c.id)} type="button">
                  <Icon size={14} />
                  {c.title}
                  <span className="pl"><Plus size={13} strokeWidth={2.2} /></span>
                </button>
              );
            })}
          </div>
          <span className="dh-tray-spring" />
          <button className="dh-reset-btn" onClick={onReset} type="button">
            <RefreshCw size={13} />Reset {cfg.label}
          </button>
        </div>
      </div>

      <div className="dh-board-scroll">
        <BentoBoard
          items={items}
          onChange={onChange}
          onRemove={onRemove}
          editMode={editMode}
          cols={cfg.cols}
          gap={cfg.gap}
          rowH={cfg.rowH}
          registry={WIDGETS}
        />
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} dir={dir} setDir={setDir} />
    </div>
  );
}
