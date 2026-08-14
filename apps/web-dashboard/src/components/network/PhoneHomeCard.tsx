"use client";

// Block phone-home (WARP-613, ADR-012) — home-user egress control.
// Declarative: the card writes *desired* state; the egress reconciler enforces
// it on the router within ≤30s. Each scope shows desired → applied so the owner
// sees enforcement land. Recreated from design_handoff_phone_home against the
// dashboard's tokens + lucide-react. API contract (option A — applied-state):
//   GET   /api/network/phone-home → { enabled, cameras, groups[], lastSync, pending }
//   PATCH /api/network/phone-home   { enabled?, cameras? }
//   PATCH /api/network/groups/:id   { blockPhoneHome }

import { useEffect, useState, type ComponentType } from "react";
import useSWR from "swr";
import {
  ShieldCheck,
  Globe,
  Video,
  Users,
  Lock,
  Clock,
  RefreshCw,
  AlertTriangle,
  Plus,
  Info,
  ChevronDown,
} from "lucide-react";
import { useAuth, authFetch } from "@/lib/auth";

interface ScopeView {
  desired: boolean;
  applied: boolean;
  appliedAt: string | null;
}
interface GroupView extends ScopeView {
  id: string;
  name: string;
  deviceCount: number;
}
interface PhoneHomeView {
  enabled: ScopeView;
  cameras: ScopeView & { count: number | null };
  groups: GroupView[];
  lastSync: string | null;
  pending: number;
}

const KEY = "/api/network/phone-home";

// authFetch attaches the session cookie + transparently refreshes on 401, so an
// expired session doesn't silently drop writes (UX review note).
const fetcher = async (url: string): Promise<PhoneHomeView> => {
  const r = await authFetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 3) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// 1s re-render so "enforced 8s ago" stays live.
function useHeartbeat() {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

// ── switch (two sizes) ──────────────────────────────────────────
function Switch({
  on,
  label,
  size = "sm",
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  size?: "sm" | "lg";
  disabled?: boolean;
  onToggle: () => void;
}) {
  const lg = size === "lg";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={[
        "relative inline-flex shrink-0 items-center rounded-full transition-colors duration-150 ease-smooth",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        lg ? "h-7 w-12" : "h-[18px] w-8",
      ].join(" ")}
      style={{ background: on ? "var(--brand)" : "var(--text-faint)" }}
    >
      <span
        className={[
          "inline-block rounded-full shadow transition-transform duration-150 ease-smooth",
          lg ? "h-[22px] w-[22px]" : "h-3.5 w-3.5",
          on
            ? lg
              ? "translate-x-[23px]"
              : "translate-x-[16px]"
            : "translate-x-[3px]",
        ].join(" ")}
        // WARP-1358: the knob is the only thing distinguishing on from off, so
        // it owes 3:1 against the track (WCAG 1.4.11). White on the dark
        // --brand (#818cf8) is 2.98:1; --on-brand carries it (5.64:1 dark,
        // 4.47:1 light). The off track is --text-faint, not a brand fill, so
        // white still clears there — mirrors `.droplet-shell .sw` in
        // droplet-shell.css.
        style={{ background: on ? "var(--on-brand)" : "#fff" }}
      />
    </button>
  );
}

// ── status chip per scope ───────────────────────────────────────
function ScopeStatus({ sc, active }: { sc: ScopeView; active: boolean }) {
  if (!active) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 type-caption-1"
        style={{ background: "var(--card-inner)", color: "var(--text-muted)" }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--text-faint)" }} />
        Paused
      </span>
    );
  }
  if (sc.desired !== sc.applied) {
    // var(--text) (not text-system-orange) for WCAG AA contrast on the
    // faint amber tint; the orange spinner carries the colour cue (UX note).
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-system-orange/15 px-2 py-0.5 type-caption-1 font-medium"
        style={{ color: "var(--text)" }}
      >
        <RefreshCw size={11} className="text-system-orange animate-spin motion-reduce:animate-none" />
        Applying…
      </span>
    );
  }
  if (sc.applied) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 type-caption-1 font-semibold"
        style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
      >
        <ShieldCheck size={11} />
        Blocked
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 type-caption-1"
      style={{ borderColor: "var(--card-bd)", background: "var(--surface)", color: "var(--text-muted)" }}
    >
      <Globe size={11} />
      Can phone home
    </span>
  );
}

// ── one scope row ───────────────────────────────────────────────
function ScopeRow({
  icon: Icon,
  title,
  sub,
  sc,
  active,
  disabled,
  onToggle,
}: {
  icon: ComponentType<{ size?: number | string; className?: string }>;
  title: string;
  sub: string;
  sc: ScopeView;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const enforced = active && sc.applied && sc.desired === sc.applied;
  const lit = sc.desired && active;
  return (
    <li
      className="flex items-center gap-3 border-b px-3.5 py-2.5 last:border-b-0"
      style={{ borderColor: "var(--card-bd)" }}
    >
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors duration-150"
        style={
          lit
            ? { background: "var(--brand-subtle)", color: "var(--brand)" }
            : { background: "var(--card-inner)", color: "var(--text-muted)" }
        }
      >
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="type-subheadline" style={{ color: "var(--text)" }}>{title}</div>
        <div className="type-caption-2" style={{ color: "var(--text-muted)" }}>
          {sub}
          {enforced && sc.appliedAt && (
            <span className="font-medium" style={{ color: "var(--brand)" }}> · enforced {ago(sc.appliedAt)}</span>
          )}
        </div>
      </div>
      <ScopeStatus sc={sc} active={active} />
      <Switch
        on={sc.desired}
        label={`Block phone-home for ${title}`}
        disabled={disabled || !active}
        onToggle={onToggle}
      />
    </li>
  );
}

function SkelRow() {
  return (
    <li
      className="flex items-center gap-3 border-b px-3.5 py-2.5 last:border-b-0"
      style={{ borderColor: "var(--card-bd)" }}
    >
      <span
        className="h-8 w-8 shrink-0 animate-pulse rounded-lg"
        style={{ background: "var(--surface-2)" }}
      />
      <div className="min-w-0 flex-1 space-y-2">
        <span
          className="block h-2.5 w-2/5 animate-pulse rounded"
          style={{ background: "var(--surface-2)" }}
        />
        <span
          className="block h-2 w-3/5 animate-pulse rounded"
          style={{ background: "var(--surface-2)" }}
        />
      </div>
      <span
        className="h-[22px] w-[70px] shrink-0 animate-pulse rounded-full"
        style={{ background: "var(--surface-2)" }}
      />
      <span
        className="h-[18px] w-8 shrink-0 animate-pulse rounded-full"
        style={{ background: "var(--surface-2)" }}
      />
    </li>
  );
}

export function PhoneHomeCard({ onManageGroups }: { onManageGroups?: () => void }) {
  const { user } = useAuth();
  const canEdit = user?.role === "owner" || user?.role === "admin";
  useHeartbeat();

  const { data, error, isLoading, mutate } = useSWR<PhoneHomeView>(KEY, fetcher, {
    refreshInterval: (d) => (d && d.pending > 0 ? 5000 : 30000),
  });
  const [mutErr, setMutErr] = useState<string | null>(null);

  // Optimistic write: flip desired locally (so the switch + "Applying…" show
  // instantly), PATCH, then revalidate. On error, restore the pre-mutation
  // snapshot rather than leave the failed desired state on screen (UX note).
  async function send(
    optimistic: (cur: PhoneHomeView) => PhoneHomeView,
    req: () => Promise<Response>,
  ) {
    setMutErr(null);
    const snapshot = data;
    if (snapshot) mutate(optimistic(snapshot), { revalidate: false });
    try {
      const r = await req();
      if (!r.ok) throw new Error(String(r.status));
      mutate();
    } catch {
      setMutErr("Couldn't save that change — please try again.");
      if (snapshot) mutate(snapshot, { revalidate: false });
    }
  }

  const patchRoot = (body: Record<string, boolean>) =>
    authFetch(KEY, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const toggleMaster = () =>
    send(
      (c) => ({ ...c, enabled: { ...c.enabled, desired: !c.enabled.desired, applied: false }, pending: c.pending + 1 }),
      () => patchRoot({ enabled: !data!.enabled.desired }),
    );
  const toggleCameras = () =>
    send(
      (c) => ({ ...c, cameras: { ...c.cameras, desired: !c.cameras.desired, applied: false }, pending: c.pending + 1 }),
      () => patchRoot({ cameras: !data!.cameras.desired }),
    );
  const toggleGroup = (g: GroupView) =>
    send(
      (c) => ({
        ...c,
        groups: c.groups.map((x) => (x.id === g.id ? { ...x, desired: !x.desired, applied: false } : x)),
        pending: c.pending + 1,
      }),
      () =>
        authFetch(`/api/network/groups/${encodeURIComponent(g.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blockPhoneHome: !g.desired }),
        }),
    );

  const phase: "loading" | "error" | "ready" =
    isLoading && !data ? "loading" : error && !data ? "error" : "ready";

  const active = !!data && data.enabled.desired;
  const masterApplying = !!data && data.enabled.desired !== data.enabled.applied;
  const pending = data?.pending ?? 0;

  const blockedGroups = data?.groups.filter((g) => g.applied && g.desired) ?? [];
  const blockedDevices =
    blockedGroups.reduce((n, g) => n + g.deviceCount, 0) +
    (data?.cameras.applied ? data.cameras.count ?? 0 : 0);

  const HeroIcon = phase === "error" ? AlertTriangle : active ? ShieldCheck : Globe;
  const heroTone = phase === "error" ? "bg-system-red/10 text-system-red" : "";
  const heroStyle =
    phase === "error"
      ? undefined
      : active && phase === "ready"
        ? { background: "var(--brand-subtle)", color: "var(--brand)" }
        : { background: "var(--card-inner)", color: "var(--text-muted)" };

  return (
    <section
      className="overflow-hidden rounded-[10px] border shadow-sm"
      style={{ borderColor: "var(--card-bd)", background: "var(--surface)" }}
    >
      {/* header */}
      <header
        className="flex items-start justify-between gap-4 border-b px-5 py-3"
        style={{ borderColor: "var(--card-bd)" }}
      >
        <div>
          <h3 className="type-subheadline font-semibold" style={{ color: "var(--text)" }}>Block phone-home</h3>
          <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
            Stop devices from quietly sending data back to their makers.
          </p>
        </div>
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 type-caption-1 font-medium"
          style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
        >
          <Lock size={11} />
          Owner &amp; admins
        </span>
      </header>

      {/* "Why this matters" — opt-in explainer keeps the card compact while
          giving a home owner the what + why of phone-home blocking. */}
      <details
        className="group border-b px-5 [&_summary]:list-none [&_summary::-webkit-details-marker]:hidden"
        style={{ borderColor: "var(--card-bd)", background: "var(--inset)" }}
      >
        <summary className="flex cursor-pointer select-none items-center gap-2 py-2.5 type-caption-1 font-medium text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
          <Info size={13} style={{ color: "var(--text-muted)" }} />
          Why this matters
          <ChevronDown
            size={13}
            className="ml-auto transition-transform duration-150 ease-smooth group-open:rotate-180 motion-reduce:transition-none"
            style={{ color: "var(--text-muted)" }}
          />
        </summary>
        <p
          data-testid="phone-home-explainer"
          className="pb-3 pr-1 type-caption-1 leading-relaxed"
          style={{ color: "var(--text-muted)" }}
        >
          Many smart devices and cameras quietly send usage data — telemetry —
          back to the companies that made them. Blocking phone-home keeps that
          data on your local network instead of leaving it. Essential traffic
          like time sync and security &amp; firmware updates is always allowed,
          so your devices stay safe and up to date.
        </p>
      </details>

      {/* hero + master */}
      <div className="flex items-center gap-4 px-5 py-[18px]">
        <span
          className={`grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[13px] ${heroTone}`}
          style={heroStyle}
        >
          <HeroIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          {phase === "loading" ? (
            <div className="space-y-2">
              <span
                className="block h-3.5 w-48 animate-pulse rounded"
                style={{ background: "var(--surface-2)" }}
              />
              <span
                className="block h-2.5 w-64 animate-pulse rounded"
                style={{ background: "var(--surface-2)" }}
              />
            </div>
          ) : phase === "error" ? (
            <>
              <h2 className="type-headline" style={{ color: "var(--text)" }}>Enforcement service unreachable</h2>
              <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                Your last saved rules are still in effect on the router.
              </p>
            </>
          ) : active ? (
            <>
              <h2 className="type-headline" style={{ color: "var(--text)" }}>Phone-home blocking is on</h2>
              <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                Enforced for {blockedDevices} device{blockedDevices === 1 ? "" : "s"} ·{" "}
                {blockedGroups.length} of {data!.groups.length || "—"} groups
                {data!.cameras.applied ? " + cameras" : ""}
              </p>
            </>
          ) : (
            <>
              <h2 className="type-headline" style={{ color: "var(--text)" }}>Phone-home blocking is off</h2>
              <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                Devices can send usage data and telemetry to their makers.
              </p>
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1">
          <Switch
            size="lg"
            label="Block phone-home (master switch)"
            on={!!data && data.enabled.desired}
            disabled={phase !== "ready" || !canEdit}
            onToggle={toggleMaster}
          />
          <span className="type-caption-2 font-semibold" style={{ color: "var(--text-muted)" }}>
            {phase !== "ready" ? "—" : masterApplying ? "Applying…" : active ? "On" : "Off"}
          </span>
        </div>
      </div>

      {/* always-allowed strip */}
      {phase === "ready" && active && (
        <div
          className="flex flex-wrap items-center gap-4 border-y px-5 py-2.5"
          style={{ borderColor: "var(--card-bd)", background: "var(--inset)" }}
        >
          <span
            className="type-caption-2 font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-faint)" }}
          >
            Always allowed
          </span>
          <span
            className="inline-flex items-center gap-1.5 type-caption-1"
            style={{ color: "var(--text-muted)" }}
          >
            <Clock size={12} className="text-system-green" />
            Time sync (NTP)
          </span>
          <span
            className="inline-flex items-center gap-1.5 type-caption-1"
            style={{ color: "var(--text-muted)" }}
          >
            <RefreshCw size={12} className="text-system-green" />
            Security &amp; firmware updates
          </span>
        </div>
      )}

      {/* body */}
      {phase === "loading" && (
        <ul>
          <SkelRow />
          <SkelRow />
          <SkelRow />
        </ul>
      )}

      {phase === "error" && (
        <div className="flex items-center gap-3 px-5 py-4">
          <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-system-red/10 text-system-red">
            <AlertTriangle size={18} />
          </span>
          <div className="flex-1">
            <div className="type-subheadline font-semibold" style={{ color: "var(--text)" }}>
              Couldn&apos;t reach the reconciler
            </div>
            <div className="type-caption-1" style={{ color: "var(--text-muted)" }}>
              The egress sync didn&apos;t respond. Changes you make won&apos;t apply until it&apos;s back.
            </div>
          </div>
          <button onClick={() => mutate()} className="btn text-sm">
            <RefreshCw size={13} />
            Try again
          </button>
        </div>
      )}

      {phase === "ready" && data && (
        <>
          <ul className={active ? "" : "pointer-events-none opacity-55 saturate-50"}>
            <ScopeRow
              icon={Video}
              title="Cameras"
              sub={
                data.cameras.count != null
                  ? `${data.cameras.count} cameras · feeds never leave your network`
                  : "Feeds never leave your network"
              }
              sc={data.cameras}
              active={active}
              disabled={!canEdit}
              onToggle={toggleCameras}
            />

            {data.groups.length === 0 ? (
              <li className="flex flex-col items-center gap-1.5 px-6 py-7 text-center">
                <span
                  className="mb-1 grid h-10 w-10 place-items-center rounded-[11px]"
                  style={{ background: "var(--card-inner)", color: "var(--text-faint)" }}
                >
                  <Users size={18} />
                </span>
                <div className="type-subheadline font-semibold" style={{ color: "var(--text-muted)" }}>
                  No device groups yet
                </div>
                <p className="max-w-[340px] type-caption-1" style={{ color: "var(--text-muted)" }}>
                  Group devices by team or room to block phone-home for some without affecting others.
                </p>
                {onManageGroups ? (
                  <button onClick={onManageGroups} className="btn mt-2 text-sm">
                    <Plus size={12} />
                    Create a group
                  </button>
                ) : (
                  <p className="mt-1 type-caption-2" style={{ color: "var(--text-faint)" }}>
                    Add groups from the Devices tab.
                  </p>
                )}
              </li>
            ) : (
              data.groups.map((g) => (
                <ScopeRow
                  key={g.id}
                  icon={Users}
                  title={g.name}
                  sub={`${g.deviceCount} device${g.deviceCount === 1 ? "" : "s"}`}
                  sc={g}
                  active={active}
                  disabled={!canEdit}
                  onToggle={() => toggleGroup(g)}
                />
              ))
            )}
          </ul>

          {/* reconciler heartbeat footer */}
          <div
            className="flex items-center justify-between border-t px-5 py-2.5"
            style={{ borderColor: "var(--card-bd)", background: "var(--inset)" }}
          >
            <span
              className="inline-flex items-center gap-2 type-caption-1"
              style={{ color: "var(--text-muted)" }}
            >
              <span
                className={[
                  "h-2 w-2 rounded-full",
                  pending ? "bg-system-orange animate-pulse motion-reduce:animate-none" : "bg-system-green",
                ].join(" ")}
              />
              {pending
                ? `Applying ${pending} change${pending > 1 ? "s" : ""} — enforced within 30s`
                : `Enforced & healthy · re-checked ${ago(data.lastSync)}`}
            </span>
            <span className="font-mono type-caption-2" style={{ color: "var(--text-faint)" }}>reconcile ≤ 30s</span>
          </div>
        </>
      )}

      {mutErr && (
        <p
          role="alert"
          className="border-t px-5 py-2 type-caption-1 text-system-red"
          style={{ borderColor: "var(--card-bd)" }}
        >
          {mutErr}
        </p>
      )}
    </section>
  );
}
