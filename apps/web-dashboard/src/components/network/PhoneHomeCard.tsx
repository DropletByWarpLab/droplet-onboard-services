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
} from "lucide-react";
import { useAuth } from "@/lib/auth";

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

const fetcher = async (url: string): Promise<PhoneHomeView> => {
  const r = await fetch(url);
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
  size = "sm",
  disabled,
  onToggle,
}: {
  on: boolean;
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
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={[
        "relative inline-flex shrink-0 items-center rounded-full transition-colors duration-150 ease-smooth",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        lg ? "h-7 w-12" : "h-[18px] w-8",
        on ? "bg-accent" : "bg-label-quaternary",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block rounded-full bg-white shadow transition-transform duration-150 ease-smooth",
          lg ? "h-[22px] w-[22px]" : "h-3.5 w-3.5",
          on
            ? lg
              ? "translate-x-[23px]"
              : "translate-x-[16px]"
            : "translate-x-[3px]",
        ].join(" ")}
      />
    </button>
  );
}

// ── status chip per scope ───────────────────────────────────────
function ScopeStatus({ sc, active }: { sc: ScopeView; active: boolean }) {
  if (!active) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-tertiary px-2 py-0.5 type-caption-1 text-label-tertiary">
        <span className="h-1.5 w-1.5 rounded-full bg-label-quaternary" />
        Paused
      </span>
    );
  }
  if (sc.desired !== sc.applied) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-system-orange/15 px-2 py-0.5 type-caption-1 text-system-orange">
        <RefreshCw size={11} className="animate-spin motion-reduce:animate-none" />
        Applying…
      </span>
    );
  }
  if (sc.applied) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 type-caption-1 font-semibold text-accent">
        <ShieldCheck size={11} />
        Blocked
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-separator bg-surface-primary px-2 py-0.5 type-caption-1 text-label-secondary">
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
    <li className="flex items-center gap-3 border-b border-separator px-3.5 py-2.5 last:border-b-0">
      <span
        className={[
          "grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors duration-150",
          lit ? "bg-accent/10 text-accent" : "bg-surface-tertiary text-label-tertiary",
        ].join(" ")}
      >
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="type-subheadline text-label-primary">{title}</div>
        <div className="type-caption-2 text-label-tertiary">
          {sub}
          {enforced && sc.appliedAt && (
            <span className="font-medium text-accent"> · enforced {ago(sc.appliedAt)}</span>
          )}
        </div>
      </div>
      <ScopeStatus sc={sc} active={active} />
      <Switch on={sc.desired} disabled={disabled || !active} onToggle={onToggle} />
    </li>
  );
}

function SkelRow() {
  return (
    <li className="flex items-center gap-3 border-b border-separator px-3.5 py-2.5 last:border-b-0">
      <span className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-surface-tertiary" />
      <div className="min-w-0 flex-1 space-y-2">
        <span className="block h-2.5 w-2/5 animate-pulse rounded bg-surface-tertiary" />
        <span className="block h-2 w-3/5 animate-pulse rounded bg-surface-tertiary" />
      </div>
      <span className="h-[22px] w-[70px] shrink-0 animate-pulse rounded-full bg-surface-tertiary" />
      <span className="h-[18px] w-8 shrink-0 animate-pulse rounded-full bg-surface-tertiary" />
    </li>
  );
}

export function PhoneHomeCard() {
  const { user } = useAuth();
  const canEdit = user?.role === "owner" || user?.role === "admin";
  useHeartbeat();

  const { data, error, isLoading, mutate } = useSWR<PhoneHomeView>(KEY, fetcher, {
    refreshInterval: (d) => (d && d.pending > 0 ? 5000 : 30000),
  });
  const [mutErr, setMutErr] = useState<string | null>(null);

  // Optimistic write: flip desired locally (so the switch + "Applying…" show
  // instantly), PATCH, then revalidate to the reconciler's truth.
  async function send(
    optimistic: (cur: PhoneHomeView) => PhoneHomeView,
    req: () => Promise<Response>,
  ) {
    setMutErr(null);
    if (data) mutate(optimistic(data), { revalidate: false });
    try {
      const r = await req();
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      setMutErr("Couldn't save that change — please try again.");
    } finally {
      mutate();
    }
  }

  const patchRoot = (body: Record<string, boolean>) =>
    fetch(KEY, {
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
        fetch(`/api/network/groups/${encodeURIComponent(g.id)}`, {
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
  const heroTone =
    phase === "error"
      ? "bg-system-red/10 text-system-red"
      : active && phase === "ready"
        ? "bg-accent/10 text-accent"
        : "bg-surface-tertiary text-label-tertiary";

  return (
    <section className="overflow-hidden rounded-[10px] border border-separator bg-surface-primary shadow-sm">
      {/* header */}
      <header className="flex items-start justify-between gap-4 border-b border-separator px-5 py-3">
        <div>
          <h3 className="type-subheadline font-semibold text-label-primary">Block phone-home</h3>
          <p className="type-caption-1 text-label-tertiary">
            Stop devices from quietly sending data back to their makers.
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 type-caption-1 font-medium text-accent">
          <Lock size={11} />
          Owner &amp; admins
        </span>
      </header>

      {/* hero + master */}
      <div className="flex items-center gap-4 px-5 py-[18px]">
        <span className={`grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[13px] ${heroTone}`}>
          <HeroIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          {phase === "loading" ? (
            <div className="space-y-2">
              <span className="block h-3.5 w-48 animate-pulse rounded bg-surface-tertiary" />
              <span className="block h-2.5 w-64 animate-pulse rounded bg-surface-tertiary" />
            </div>
          ) : phase === "error" ? (
            <>
              <h2 className="type-headline text-label-primary">Enforcement status unavailable</h2>
              <p className="type-caption-1 text-label-tertiary">
                The dashboard couldn&apos;t reach the orchestrator. Your last saved rules are still
                enforced on the router.
              </p>
            </>
          ) : active ? (
            <>
              <h2 className="type-headline text-label-primary">Phone-home blocking is on</h2>
              <p className="type-caption-1 text-label-tertiary">
                Enforced for {blockedDevices} device{blockedDevices === 1 ? "" : "s"} ·{" "}
                {blockedGroups.length} of {data!.groups.length || "—"} groups
                {data!.cameras.applied ? " + cameras" : ""}
              </p>
            </>
          ) : (
            <>
              <h2 className="type-headline text-label-primary">Phone-home blocking is off</h2>
              <p className="type-caption-1 text-label-tertiary">
                Devices can send usage data and telemetry to their makers.
              </p>
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1">
          <Switch
            size="lg"
            on={!!data && data.enabled.desired}
            disabled={phase !== "ready" || !canEdit}
            onToggle={toggleMaster}
          />
          <span className="type-caption-2 font-semibold text-label-tertiary">
            {phase !== "ready" ? "—" : masterApplying ? "Applying…" : active ? "On" : "Off"}
          </span>
        </div>
      </div>

      {/* always-allowed strip */}
      {phase === "ready" && active && (
        <div className="flex flex-wrap items-center gap-4 border-y border-separator bg-surface-secondary px-5 py-2.5">
          <span className="type-caption-2 font-semibold uppercase tracking-wider text-label-quaternary">
            Always allowed
          </span>
          <span className="inline-flex items-center gap-1.5 type-caption-1 text-label-secondary">
            <Clock size={12} className="text-system-green" />
            Time sync (NTP)
          </span>
          <span className="inline-flex items-center gap-1.5 type-caption-1 text-label-secondary">
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
            <div className="type-subheadline font-semibold text-label-primary">
              Couldn&apos;t load phone-home status
            </div>
            <div className="type-caption-1 text-label-tertiary">
              Changes you make won&apos;t show until the orchestrator is reachable again.
            </div>
          </div>
          <button onClick={() => mutate()} className="dp-btn-secondary inline-flex items-center gap-2 text-sm">
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
                <span className="mb-1 grid h-10 w-10 place-items-center rounded-[11px] bg-surface-tertiary text-label-quaternary">
                  <Users size={18} />
                </span>
                <div className="type-subheadline font-semibold text-label-secondary">
                  No device groups yet
                </div>
                <p className="max-w-[340px] type-caption-1 text-label-tertiary">
                  Group devices by team or room to block phone-home for some without affecting others.
                </p>
                <a href="/network" className="dp-btn-secondary mt-2 inline-flex items-center gap-1.5 text-sm">
                  <Plus size={12} />
                  Create a group
                </a>
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
          <div className="flex items-center justify-between border-t border-separator bg-surface-secondary px-5 py-2.5">
            <span className="inline-flex items-center gap-2 type-caption-1 text-label-secondary">
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
            <span className="font-mono type-caption-2 text-label-quaternary">reconcile ≤ 30s</span>
          </div>
        </>
      )}

      {mutErr && (
        <p role="alert" className="border-t border-separator px-5 py-2 type-caption-1 text-system-red">
          {mutErr}
        </p>
      )}
    </section>
  );
}
