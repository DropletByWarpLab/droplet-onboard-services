"use client";

/**
 * WARP-2977 P2b (ADR-059 §3.6) — the site mode, at the top of /security.
 *
 * Shows the EFFECTIVE mode (Open, Closed or Away) the server resolved, and one
 * line saying why and until when. Three rules shape it:
 *
 *   1. Every time is SITE time: `SecurityModeView.displayTimezone`, else the
 *      device's zone (never UTC). An owner checking from another city must
 *      read the shop's 6 PM, not their own.
 *   2. The mode controls are rendered only at the `act` level or above
 *      (`useModuleLevel`), never rendered and then refused: a refused click
 *      is an auth/warn ActivityRow that the threat mirror would show as a
 *      threat. `requireFeatureAccess` on the orchestrator stays the boundary.
 *   3. The mode is not an alarm. The disclaimer under the controls is always
 *      visible, and nothing here claims the site is being watched over.
 *
 * A failed read is an error state, never a guessed "Open". A failed RE-read
 * (the 30 s poll, a refocus) keeps the last mode the server gave and says it
 * couldn't refresh — the view is still the server's, not a guess.
 *
 * Keyboard and screen readers: while a write is in flight the controls are
 * aria-disabled, never `disabled` — disabling the focused button would drop
 * focus to <body> after every mode change. Choosing a More item returns focus
 * to More, and the Open up dialog opens on the checked choice.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Moon, MoreHorizontal, Plane, RefreshCw, Store, TriangleAlert, type LucideIcon } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { levelAtLeast, useModuleLevel } from "@/lib/hooks/useModuleGate";
import { useSecurityHealth, useSecurityMode } from "@/lib/hooks/useSecurity";
import { deviceTimeZone, formatSiteTime, formatSiteWhen, siteDateOf } from "@/lib/security-time";
import type {
  SecurityHealthRow,
  SecurityMode,
  SecurityModeAction,
  SecurityModeActionResult,
  SecurityModeView,
} from "@/lib/types";

/**
 * Every string the card shows. `{slot}`s are filled by `fill()`, so this
 * object stays plain strings for the Security copy lint.
 */
export const COPY = {
  title: "Site mode",
  badgeOpen: "Open",
  badgeClosed: "Closed",
  badgeAway: "Away",
  loadError: "Droplet can't tell the site's mode right now.",
  refreshFailed: "Couldn't refresh the mode just now. This is the last mode Droplet reported.",
  retry: "Retry",

  // Following the opening hours.
  closesAt: "Closes {at}",
  opensAt: "Opens {at}",
  alwaysOpen: "The opening hours keep the site open all the time.",
  neverOpens: "The opening hours don't open the site on any day.",
  notSet: "No opening hours set, so Droplet counts the site as open.",
  setHours: "Set opening hours",
  managerSetsHours: "Someone who manages Security can set opening hours.",

  // Set by hand. `{who}` is " by <name>", or empty when nobody is on record.
  closedUp: "Closed up{who} {at}",
  openedUp: "Opened{who} {at}",
  awaySince: "Away since {when}{who}",
  hoursTakeOver: "Opening hours take over {at}",
  backToClosed: "Back to closed {at}",
  endsAt: "Ends {at}",
  untilChanged: "Stays this way until someone changes it",

  staleSince: "Droplet hasn't checked the opening hours since {when}, so the mode may be out of date.",
  staleNever: "Droplet hasn't checked the opening hours yet, so the mode may be out of date.",
  staleUnknown: "Droplet can't confirm it has checked the opening hours lately, so the mode may be out of date.",
  timesIn: "Times are in {tz}.",

  closeUp: "Close up",
  openUp: "Open up",
  more: "More",
  moreLabel: "More site mode options",
  away: "Away",
  resume: "Back to opening hours",

  openDialogTitle: "Open up for how long?",
  openDialogSub: "Droplet counts the site as open until then. After that the opening hours take over again.",
  openFor1h: "1 hour",
  openFor2h: "2 hours",
  openFor4h: "4 hours",
  openUntil: "Until {when}",
  openUntilOpening: "Until {when}, when the site opens",
  cancel: "Cancel",

  toastClosedUntil: "Closed until {when}.",
  toastClosedUntilChanged: "Closed until someone changes it.",
  toastOpenUntil: "Open until {when}.",
  toastOpen: "Open.",
  toastAway: "Set to away. It stays this way until someone changes it.",
  toastResumed: "Back to opening hours.",
  undo: "Undo",
} as const;

/**
 * The one sentence that must name what the mode does NOT do. Kept out of
 * `COPY` on purpose: it has to say "arm" (negated), which the Security copy
 * lint bans in every positive claim. Pinned verbatim by ModeCard.test.
 */
export const MODE_DISCLAIMER =
  "The mode tells Droplet when the site should be empty. It doesn't lock doors, arm anything, or call anyone.";

export type OpenFor = "1h" | "2h" | "4h";
export const OPEN_FOR_OPTIONS: ReadonlyArray<{ value: OpenFor; hours: number; label: string }> = [
  { value: "1h", hours: 1, label: COPY.openFor1h },
  { value: "2h", hours: 2, label: COPY.openFor2h },
  { value: "4h", hours: 4, label: COPY.openFor4h },
];
export const DEFAULT_OPEN_FOR: OpenFor = "2h";

/** Exported for the Security wall (WARP-2981), which shows the same badge. */
export const MODE_BADGE: Record<SecurityMode, { cls: string; text: string; icon: LucideIcon }> = {
  open: { cls: "badge ok", text: COPY.badgeOpen, icon: Store },
  closed: { cls: "badge muted", text: COPY.badgeClosed, icon: Moon },
  away: { cls: "badge info", text: COPY.badgeAway, icon: Plane },
};

export function fill(template: string, slots: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => slots[k] ?? "");
}

// ── time, always in the site zone ──

/**
 * The zone every time on the card is formatted in. `undefined` only when the
 * runtime cannot even name the device zone — Intl then uses its own default,
 * which IS the device zone. Never UTC.
 */
export function displayZoneOf(view: Pick<SecurityModeView, "displayTimezone">): string | undefined {
  return view.displayTimezone ?? deviceTimeZone() ?? undefined;
}

// The shared formatters take a zone string; `undefined` is Intl's runtime default.
const zoneArg = (tz: string | undefined) => tz as string;

/** "9:00 AM tomorrow", "Fri 6:02 PM" — the spec's wording, for toasts, "since" and "until". */
export function whenIn(instant: string, tz: string | undefined, now: Date): string {
  return formatSiteWhen(instant, zoneArg(tz), now);
}

/**
 * The same instant as a phrase that follows a verb: "at 6:00 PM",
 * "at 9:00 AM tomorrow", "on Fri at 6:02 PM", "on Sep 30 at 6:02 PM".
 */
export function atPhrase(instant: string, tz: string | undefined, now: Date): string {
  const zone = zoneArg(tz);
  const time = formatSiteTime(instant, zone);
  const utcDay = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  const diff = Math.round((utcDay(siteDateOf(instant, zone)) - utcDay(siteDateOf(now, zone))) / 86_400_000);
  if (diff === 0) return `at ${time}`;
  if (diff === 1) return `at ${time} tomorrow`;
  const at = new Date(instant);
  if (Math.abs(diff) <= 6) {
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(at);
    return `on ${weekday} at ${time}`;
  }
  const date = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" }).format(at);
  return `on ${date} at ${time}`;
}

/** The next time the opening hours OPEN the site, when that is what they do next. */
function upcomingOpening(view: SecurityModeView): string | null {
  const h = view.hours;
  return h.state === "set" && h.upcoming && h.upcoming.mode === "open" ? h.upcoming.at : null;
}

/** The reason line under the badge, per state, in the site zone. */
export function modeReason(view: SecurityModeView, now: Date): string {
  const tz = displayZoneOf(view);
  const at = (iso: string) => atPhrase(iso, tz, now);

  if (view.source === "schedule") {
    if (view.hours.state === "not_set") return COPY.notSet;
    const upcoming = view.hours.upcoming;
    if (view.mode === "open") return upcoming ? fill(COPY.closesAt, { at: at(upcoming.at) }) : COPY.alwaysOpen;
    return upcoming ? fill(COPY.opensAt, { at: at(upcoming.at) }) : COPY.neverOpens;
  }

  const who = view.setBy ? ` by ${view.setBy.name}` : "";
  if (view.mode === "away") {
    const lead = fill(COPY.awaySince, {
      when: whenIn(view.setAt, tz, now),
      who: view.setBy ? ` (${view.setBy.name})` : "",
    });
    return `${lead} · ${COPY.untilChanged}`;
  }
  if (view.mode === "closed") {
    const lead = fill(COPY.closedUp, { who, at: at(view.setAt) });
    const tail =
      view.manualEnd === "next_opening" && view.until
        ? fill(COPY.hoursTakeOver, { at: at(view.until) })
        : COPY.untilChanged;
    return `${lead} · ${tail}`;
  }
  // Opened up: bounded (at_time), capped at the next opening.
  const lead = fill(COPY.openedUp, { who, at: at(view.setAt) });
  if (!view.until) return `${lead} · ${COPY.untilChanged}`;
  const opening = upcomingOpening(view);
  const opensByThen = opening !== null && Date.parse(opening) <= Date.parse(view.until);
  const tail = opensByThen
    ? fill(COPY.hoursTakeOver, { at: at(view.until) })
    : view.hours.state === "set" && view.hours.scheduledMode === "closed"
      ? fill(COPY.backToClosed, { at: at(view.until) })
      : fill(COPY.endsAt, { at: at(view.until) });
  return `${lead} · ${tail}`;
}

/**
 * Whether "Open up" needs a duration. Only when the opening hours say closed
 * right now: with no hours, or hours that say open, the server resumes the
 * opening hours instead (spec §6.3 planModeAction), so a "for how long?"
 * dialog would promise an end that never comes.
 */
export function openUpNeedsDuration(view: SecurityModeView): boolean {
  return view.hours.state === "set" && view.hours.scheduledMode === "closed";
}

/** Each Open up choice's end: now + N hours, capped at the next opening, as the server caps it. */
export function openUpEnds(
  view: SecurityModeView,
  now: Date,
): Array<{ value: OpenFor; label: string; endsAt: string; capped: boolean }> {
  const opening = upcomingOpening(view);
  const cap = opening === null ? Number.POSITIVE_INFINITY : Date.parse(opening);
  return OPEN_FOR_OPTIONS.map((o) => {
    const plain = now.getTime() + o.hours * 3_600_000;
    const capped = cap <= plain;
    return { value: o.value, label: o.label, endsAt: new Date(Math.min(plain, cap)).toISOString(), capped };
  });
}

/** The success toast for a mode write, read off the server's answer (never the request). */
export function modeToast(action: SecurityModeAction["action"], view: SecurityModeView, now: Date): string {
  const tz = displayZoneOf(view);
  let line: string;
  if (view.mode === "away") {
    line = COPY.toastAway;
  } else if (view.mode === "closed") {
    const end = view.until ?? upcomingOpening(view);
    line = end ? fill(COPY.toastClosedUntil, { when: whenIn(end, tz, now) }) : COPY.toastClosedUntilChanged;
  } else {
    const h = view.hours;
    const end = view.until ?? (h.state === "set" && h.upcoming && h.upcoming.mode === "closed" ? h.upcoming.at : null);
    line = end ? fill(COPY.toastOpenUntil, { when: whenIn(end, tz, now) }) : COPY.toastOpen;
  }
  return action === "resume" ? `${COPY.toastResumed} ${line}` : line;
}

/** The stale warning, read off the `site_mode` health row's lastSeenAt. */
export function staleLine(row: SecurityHealthRow | null, view: SecurityModeView, now: Date): string {
  if (!row) return COPY.staleUnknown;
  if (row.lastSeenAt === null) return COPY.staleNever;
  return fill(COPY.staleSince, { when: whenIn(row.lastSeenAt, displayZoneOf(view), now) });
}

// ── the card ──

export interface ModeCardProps {
  /** Called after every mode write, success or failure: the page refreshes the feed. */
  onModeChanged?: () => void;
  /** Test seam for "now"; defaults to the render time. */
  now?: Date;
}

export function ModeCard({ onModeChanged, now: nowProp }: ModeCardProps) {
  const now = nowProp ?? new Date();
  const level = useModuleLevel("security");
  const canAct = levelAtLeast(level, "act");
  const canManage = levelAtLeast(level, "manage");
  const { mode: view, error, mutate, act } = useSecurityMode();
  const health = useSecurityHealth();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  // The in-flight guard itself: the controls stay focusable (aria-disabled), so a second
  // activation between renders must be refused here, not by the `disabled` attribute.
  const busyRef = useRef(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const openUpRef = useRef<HTMLButtonElement | null>(null);

  const run = useCallback(
    async (action: SecurityModeAction, prior: SecurityModeView) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const r: SecurityModeActionResult = await act(action);
        onModeChanged?.();
        // Undo is "back to opening hours", which only reverses a change that
        // started FROM the opening hours — and only when something changed.
        const undoable = action.action !== "resume" && r.changed && prior.source === "schedule";
        toast(
          modeToast(action.action, r.mode, nowProp ?? new Date()),
          "success",
          undoable ? { label: COPY.undo, onClick: () => void run({ action: "resume" }, r.mode) } : undefined,
        );
      } catch (err) {
        // Typed copy only (409 MODE_CONFLICT, 503 AUDIT_UNAVAILABLE, …) —
        // never err.message. Then re-read, since the mode may have moved.
        toast(translateError(err, "security"), "error");
        void mutate();
        onModeChanged?.();
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [act, mutate, onModeChanged, toast, nowProp],
  );

  if (!view && error) {
    return (
      <section className="card" aria-labelledby="security-mode-title" data-mode-state="error">
        <CardHead />
        <div className="rows">
          <div className="lrow" role="alert">
            <span className="rt">
              <span className="nm" style={{ whiteSpace: "normal" }}>
                {COPY.loadError}
              </span>
            </span>
            <button type="button" className="btn sm" onClick={() => void mutate()}>
              <RefreshCw size={14} aria-hidden />
              {COPY.retry}
            </button>
          </div>
        </div>
        <Disclaimer />
      </section>
    );
  }

  if (!view) {
    return (
      <section className="card" aria-labelledby="security-mode-title" aria-busy="true" data-mode-state="loading">
        <CardHead />
        <Loader2 size={18} className="animate-spin" aria-hidden />
        <Disclaimer />
      </section>
    );
  }

  const badge = MODE_BADGE[view.mode];
  const tz = view.displayTimezone;
  const device = deviceTimeZone();
  // Absent until the header loads (or when it failed): the stale line then says it can't tell.
  const siteModeRow = health.sources?.find((s) => s.id === "site_mode") ?? null;
  const menuItems: MenuItem[] = [];
  if (view.mode !== "away") {
    menuItems.push({ label: COPY.away, icon: Plane, onSelect: () => void run({ action: "away" }, view) });
  }
  if (view.source === "manual") {
    menuItems.push({ label: COPY.resume, icon: RefreshCw, onSelect: () => void run({ action: "resume" }, view) });
  }

  return (
    <section className="card" aria-labelledby="security-mode-title" data-mode={view.mode} data-source={view.source}>
      <CardHead icon={badge.icon} badge={<span className={badge.cls}>{badge.text}</span>} />

      <p className="mode-reason" style={{ margin: 0, color: "var(--text)", fontSize: 14, overflowWrap: "anywhere" }}>
        {modeReason(view, now)}
      </p>

      {error && (
        <p
          role="status"
          data-refresh-failed
          style={{ margin: "8px 0 0", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 13, color: "var(--text-muted)" }}
        >
          <span style={{ flex: "1 1 200px" }}>{COPY.refreshFailed}</span>
          <button type="button" className="btn sm" onClick={() => void mutate()}>
            <RefreshCw size={14} aria-hidden />
            {COPY.retry}
          </button>
        </p>
      )}

      {tz && device && tz !== device && (
        <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 12.5 }}>{fill(COPY.timesIn, { tz })}</p>
      )}

      {view.stale && (
        <p
          role="status"
          data-stale
          style={{ margin: "10px 0 0", display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "var(--text)" }}
        >
          <span className="badge warn" aria-hidden style={{ flexShrink: 0 }}>
            <TriangleAlert size={12} />
          </span>
          <span style={{ overflowWrap: "anywhere" }}>{staleLine(siteModeRow, view, now)}</span>
        </p>
      )}

      {view.source === "schedule" && view.hours.state === "not_set" && (
        <div style={{ marginTop: 10 }}>
          {canManage ? (
            <Link href="/security/settings" className="btn sm">
              {COPY.setHours}
            </Link>
          ) : (
            <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}>{COPY.managerSetsHours}</p>
          )}
        </div>
      )}

      {canAct && (
        <ModeActions
          view={view}
          busy={busy}
          openUpRef={openUpRef}
          menuItems={menuItems}
          onCloseUp={() => void run({ action: "close" }, view)}
          onOpenUp={() => {
            if (busyRef.current) return;
            if (openUpNeedsDuration(view)) setDialogOpen(true);
            // No duration applies: the server resumes the opening hours, which say open.
            else void run({ action: "open", for: DEFAULT_OPEN_FOR }, view);
          }}
        />
      )}

      <Disclaimer />

      {canAct && (
        <OpenUpDialog
          open={dialogOpen}
          view={view}
          now={now}
          triggerRef={openUpRef}
          onClose={() => setDialogOpen(false)}
          onConfirm={(value) => {
            setDialogOpen(false);
            void run({ action: "open", for: value }, view);
          }}
        />
      )}
    </section>
  );
}

function CardHead({ icon: Icon = Store, badge }: { icon?: LucideIcon; badge?: React.ReactNode }) {
  return (
    <div className="card-h">
      <span className="ci" aria-hidden>
        <Icon size={16} />
      </span>
      <span className="ct" id="security-mode-title">
        {COPY.title}
      </span>
      {badge}
    </div>
  );
}

function Disclaimer() {
  return (
    <p className="mode-disclaimer" style={{ margin: "14px 0 0", color: "var(--text-muted)", fontSize: 12.5 }}>
      {MODE_DISCLAIMER}
    </p>
  );
}

interface MenuItem {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

function menuItemsIn(menu: HTMLElement | null): HTMLButtonElement[] {
  return menu ? [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')] : [];
}

function ModeActions({
  view,
  busy,
  openUpRef,
  menuItems,
  onCloseUp,
  onOpenUp,
}: {
  view: SecurityModeView;
  busy: boolean;
  openUpRef: React.RefObject<HTMLButtonElement | null>;
  menuItems: MenuItem[];
  onCloseUp: () => void;
  onOpenUp: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // role="menu" promises the menu keyboard pattern: focus lands on the first
  // item when it opens, and the arrow keys (plus Home/End) move between items.
  useEffect(() => {
    if (menuOpen) menuItemsIn(menuRef.current)[0]?.focus();
  }, [menuOpen]);
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = menuItemsIn(menuRef.current);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      e.key === "ArrowDown"
        ? (at + 1) % items.length
        : e.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    items[to]?.focus();
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      moreRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div ref={wrapRef} style={{ marginTop: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }} aria-busy={busy || undefined}>
        {/* aria-disabled, not disabled: a disabled focused button drops focus to <body>. The
            same <button> node serves both labels, so focus stays on it when Close up becomes Open up. */}
        {view.mode === "open" ? (
          <button type="button" className="btn primary" onClick={onCloseUp} aria-disabled={busy || undefined}>
            <Moon size={16} aria-hidden />
            {COPY.closeUp}
          </button>
        ) : (
          <button ref={openUpRef} type="button" className="btn primary" onClick={onOpenUp} aria-disabled={busy || undefined}>
            <Store size={16} aria-hidden />
            {COPY.openUp}
          </button>
        )}
        {menuItems.length > 0 && (
          <button
            ref={moreRef}
            type="button"
            className="btn ghost"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-label={COPY.moreLabel}
            onClick={() => {
              if (!busy) setMenuOpen((v) => !v);
            }}
            aria-disabled={busy || undefined}
          >
            <MoreHorizontal size={16} aria-hidden />
            {COPY.more}
          </button>
        )}
      </div>
      {/* In the flow of the card, not a floating popover: at 375 px an
          absolutely placed menu either runs off-screen or widens the page. */}
      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          id={menuId}
          aria-label={COPY.moreLabel}
          onKeyDown={onMenuKeyDown}
          className="rows"
          style={{ marginTop: 8, border: "1px solid var(--card-bd)", borderRadius: 12, padding: "2px 10px", maxWidth: 320 }}
        >
          {menuItems.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="lrow"
              style={{
                width: "100%",
                background: "transparent",
                border: 0,
                textAlign: "left",
                cursor: "pointer",
                color: "var(--text)",
              }}
              onClick={() => {
                setMenuOpen(false);
                // The menu-button pattern: choosing an item returns focus to its button.
                moreRef.current?.focus();
                item.onSelect();
              }}
            >
              <item.icon size={16} aria-hidden />
              <span className="rt">
                <span className="nm">{item.label}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OpenUpDialog({
  open,
  view,
  now,
  triggerRef,
  onClose,
  onConfirm,
}: {
  open: boolean;
  view: SecurityModeView;
  now: Date;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onConfirm: (value: OpenFor) => void;
}) {
  const headingId = useId();
  const descId = useId();
  const name = useId();
  const [choice, setChoice] = useState<OpenFor>(DEFAULT_OPEN_FOR);
  // Focus opens on the CHECKED choice (the radio-group pattern), not the first radio.
  const checkedRef = useRef<HTMLInputElement | null>(null);

  // Every opening starts from the default, whatever was picked last time.
  useEffect(() => {
    if (open) setChoice(DEFAULT_OPEN_FOR);
  }, [open]);

  const tz = displayZoneOf(view);
  const ends = openUpEnds(view, now);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      triggerRef={triggerRef}
      initialFocusRef={checkedRef}
      labelledBy={headingId}
      describedBy={descId}
      maxWidth="sm"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <h2 id={headingId} className="type-headline" style={{ color: "var(--text)", margin: 0 }}>
            {COPY.openDialogTitle}
          </h2>
          <p id={descId} className="type-subheadline" style={{ color: "var(--text-muted)", margin: "6px 0 0" }}>
            {COPY.openDialogSub}
          </p>
        </div>
        <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <legend className="sr-only">{COPY.openDialogTitle}</legend>
          <div className="rows">
            {ends.map((o) => (
              <label key={o.value} className="lrow" style={{ cursor: "pointer" }}>
                <input
                  ref={o.value === DEFAULT_OPEN_FOR ? checkedRef : undefined}
                  type="radio"
                  name={name}
                  value={o.value}
                  checked={choice === o.value}
                  onChange={() => setChoice(o.value)}
                />
                <span className="rt">
                  <span className="nm">{o.label}</span>
                  <span className="sub" style={{ whiteSpace: "normal" }}>
                    {fill(o.capped ? COPY.openUntilOpening : COPY.openUntil, { when: whenIn(o.endsAt, tz, now) })}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            {COPY.cancel}
          </button>
          <button type="button" className="btn primary" onClick={() => onConfirm(choice)}>
            {COPY.openUp}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
