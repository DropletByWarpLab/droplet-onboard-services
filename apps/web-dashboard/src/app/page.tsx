"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  ArrowUpRight,
  ArrowRight,
  Activity,
  AlertTriangle,
  Cloud,
  Clock,
  Cpu,
  FolderOpen,
  HardDrive,
  Home as HomeIcon,
  Lightbulb,
  MessageSquare,
  Network as NetworkIcon,
  Settings,
  ShieldCheck,
  Sparkles,
  Thermometer,
  UserPlus,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import { ContextWidget } from "@/components/context/ContextWidget";
import { useDevice } from "@/lib/hooks/useDevice";
import { useModels } from "@/lib/hooks/useModels";
import { useStorage } from "@/lib/hooks/useStorage";
import { useRecents } from "@/lib/hooks/useRecents";
import { useSmartHome } from "@/lib/hooks/useSmartHome";
import { useAuth } from "@/lib/auth";
import { useWorkspace, type HomeVariant } from "@/lib/workspace";
import { fetchSystemHealth, type SystemHealth } from "@/lib/api";
import { resolveHealthCopy } from "@/app/health-copy";
import type { FileEntryInfo } from "@/lib/types";

/* ─────────────────────────────── helpers ─────────────────────────────── */

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Working late";
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const SUGGESTIONS = [
  "Summarize the files I uploaded today",
  "Dim the living-room lights to 30%",
  "What's using the most storage?",
  "Draft a changelog from recent notes",
];

/* ─────────────────────────────── page ─────────────────────────────── */

/**
 * Home page — workspace-aware.
 *
 * Variant selection (see lib/workspace.tsx getHomeVariant):
 *   • Home workspace          → Variant B (ops-first; Stefan 2026-05-18)
 *   • Business + owner/admin  → Variant C (admin overview)
 *   • Business + family/guest → Variant A (chat-first)
 *
 * All three variants share the same data hooks + chat capsule machinery
 * so test contracts (focus-within:ring on capsule, aria-label on textarea)
 * survive across variants. Layout differs.
 */
export default function DashboardPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { homeVariant, isHome } = useWorkspace();

  /* ── shared data ── */
  const { device, health } = useDevice();
  const { models } = useModels();
  const { storage } = useStorage();
  const { items: recents } = useRecents(5);
  const { grouped, totalDevices } = useSmartHome();
  const { data: systemHealth } = useSWR<SystemHealth>(
    "/api/orchestrator/health",
    fetchSystemHealth,
    { refreshInterval: 15_000 },
  );

  const firstName = useMemo(() => {
    const raw = user?.displayName || user?.username || "";
    return raw.split(/[\s@.]/)[0] || "";
  }, [user]);

  const localModels = models.filter((m) => m.provider === "ollama");
  const cloudModels = models.filter((m) => m.provider !== "ollama");

  /* ── chat capsule (shared across variants) ── */
  const [prompt, setPrompt] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const send = (text?: string) => {
    const body = (text ?? prompt).trim();
    if (!body) return;
    try {
      window.sessionStorage.setItem("droplet.pendingPrompt", body);
    } catch {
      /* private mode — /chat still opens */
    }
    router.push("/chat");
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const autoGrow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  useEffect(autoGrow, [prompt]);

  const hasPrompt = prompt.trim().length > 0;
  const storagePct =
    storage && storage.total > 0 ? (storage.used / storage.total) * 100 : 0;
  const deviceCounts = grouped
    ? {
        lights: grouped.lights.length,
        climate: grouped.climate.length,
        cameras: 0,
      }
    : { lights: 0, climate: 0, cameras: 0 };

  const sharedContext = {
    user,
    firstName,
    device,
    health,
    storage,
    storagePct,
    recents,
    totalDevices,
    deviceCounts,
    localModels,
    cloudModels,
    systemHealth,
    prompt,
    setPrompt,
    taRef,
    send,
    handleKey,
    hasPrompt,
    homeVariant,
    isHome,
  };

  /* ── variant switch ── */
  switch (homeVariant) {
    case "C":
      return <VariantC ctx={sharedContext} />;
    case "A":
      return <VariantA ctx={sharedContext} />;
    case "B":
    default:
      return <VariantB ctx={sharedContext} />;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   VARIANT A — Chat-first (Business member/family/guest)
   Big aurora hero, narrow centered column. Closest to the legacy Home.
   ═══════════════════════════════════════════════════════════════════════ */

function VariantA({ ctx }: { ctx: SharedContext }) {
  return (
    <div className="relative min-h-screen">
      {/* Aurora backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] aurora-bg opacity-[0.55] animate-aurora"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[420px] h-32 bg-gradient-to-b from-surface-secondary/0 to-surface-secondary"
      />

      <div className="relative p-6 lg:p-12 max-w-6xl mx-auto">
        <GreetingStrip ctx={ctx} />

        <section
          className="mb-14 animate-fade-rise"
          style={{ animationDelay: "120ms" }}
        >
          <h1 className="type-display text-label-primary text-[56px] sm:text-[72px] lg:text-[88px] mb-8 max-w-4xl">
            What can I{" "}
            <span
              className="type-display-italic"
              style={{ color: "var(--aurora-ink)" }}
            >
              help you
            </span>{" "}
            with today?
          </h1>

          <ChatCapsule ctx={ctx} size="large" />

          <Suggestions ctx={ctx} />

          <ModelStatus ctx={ctx} />
        </section>

        <PrimaryTiles ctx={ctx} delay="220ms" />

        <QuickLinksRow delay="320ms" />

        <StatusRibbon ctx={ctx} delay="400ms" />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   VARIANT B — Ops-first (Home default, Business manager fallback)
   KPI strip up top, smaller AI hero, then 2-column body.
   ═══════════════════════════════════════════════════════════════════════ */

function VariantB({ ctx }: { ctx: SharedContext }) {
  return (
    <div className="relative min-h-screen">
      {/* Aurora — pulled tighter and lower opacity, hero is no longer
          the dominant element here. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[360px] aurora-bg opacity-[0.35] animate-aurora"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[300px] h-32 bg-gradient-to-b from-surface-secondary/0 to-surface-secondary"
      />

      <div className="relative p-6 lg:p-10 max-w-7xl mx-auto">
        <GreetingStrip ctx={ctx} />

        {/* KPI strip — first thing the user reads. */}
        <KpiStrip ctx={ctx} delay="120ms" />

        {/* Two-column body: left ops, right AI + alerts. On narrow
            viewports it collapses to one column with AI on top so the
            chat capsule remains immediately reachable. */}
        <section
          className="
            mt-8 grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-6
            animate-fade-rise
          "
          style={{ animationDelay: "200ms" }}
        >
          {/* AI capsule — shown FIRST on mobile (above ops) so the most
              important affordance stays one tap away. Desktop puts the
              same capsule in the right rail. */}
          <div className="lg:col-start-2 lg:row-start-1 flex flex-col gap-5">
            <AICapsuleCard ctx={ctx} />
            <NeedsAttentionCard ctx={ctx} />
            <RecentActivityCard />
          </div>

          {/* Left rail — live cameras + network top talkers */}
          <div className="lg:col-start-1 lg:row-start-1 flex flex-col gap-5">
            <LiveCamerasCard ctx={ctx} />
            <FilesRecentCard ctx={ctx} />
          </div>
        </section>

        <ContextSection delay="320ms" />

        <QuickLinksRow delay="380ms" />

        <StatusRibbon ctx={ctx} delay="440ms" />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   VARIANT C — Admin-first (Business owner/admin)
   People, plan, security posture, approvals queue.
   ═══════════════════════════════════════════════════════════════════════ */

function VariantC({ ctx }: { ctx: SharedContext }) {
  return (
    <div className="relative min-h-screen">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[280px] aurora-bg opacity-[0.25] animate-aurora"
      />
      <div className="relative p-6 lg:p-10 max-w-7xl mx-auto">
        <GreetingStrip ctx={ctx} subtitle="Admin overview · workspace running locally" />

        <KpiStrip ctx={ctx} delay="120ms" admin />

        <section
          className="
            mt-8 grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-6
            animate-fade-rise
          "
          style={{ animationDelay: "200ms" }}
        >
          {/* Left — approvals + admin activity */}
          <div className="flex flex-col gap-5">
            <ApprovalsQueueCard />
            <NeedsAttentionCard ctx={ctx} />
            <RecentActivityCard />
          </div>

          {/* Right — plan / health / security */}
          <div className="flex flex-col gap-5">
            <AICapsuleCard ctx={ctx} />
            <PlanTileCard />
            <SystemHealthCard ctx={ctx} />
            <SecurityPostureCard />
          </div>
        </section>

        <QuickLinksRow delay="380ms" />

        <StatusRibbon ctx={ctx} delay="440ms" />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Shared sub-components
   ═══════════════════════════════════════════════════════════════════════ */

type SharedContext = ReturnType<typeof useSharedContextInferenceShim>;
// We don't actually call this — it's a TS shim to derive the inferred
// shape of `sharedContext` above without hand-writing the type. The
// declaration is purely for the type system.
function useSharedContextInferenceShim() {
  return null as unknown as {
    user: ReturnType<typeof useAuth>["user"];
    firstName: string;
    device: ReturnType<typeof useDevice>["device"];
    health: ReturnType<typeof useDevice>["health"];
    storage: ReturnType<typeof useStorage>["storage"];
    storagePct: number;
    recents: FileEntryInfo[];
    totalDevices: number;
    deviceCounts: { lights: number; climate: number; cameras: number };
    localModels: ReturnType<typeof useModels>["models"];
    cloudModels: ReturnType<typeof useModels>["models"];
    systemHealth: SystemHealth | undefined;
    prompt: string;
    setPrompt: (v: string) => void;
    taRef: React.RefObject<HTMLTextAreaElement>;
    send: (text?: string) => void;
    handleKey: (e: React.KeyboardEvent) => void;
    hasPrompt: boolean;
    homeVariant: HomeVariant;
    isHome: boolean;
  };
}

function GreetingStrip({
  ctx,
  subtitle,
}: {
  ctx: SharedContext;
  subtitle?: string;
}) {
  return (
    <div className="flex items-start justify-between mb-8 animate-fade-rise">
      <div>
        <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
          {greeting()}
          {ctx.firstName && (
            <span className="text-label-secondary">, {ctx.firstName}</span>
          )}
        </p>
        <p className="type-footnote text-label-tertiary mt-1">
          {subtitle ??
            new Date().toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
        </p>
      </div>

      {ctx.systemHealth && (
        <div
          className="dp-status-chip animate-fade-rise"
          style={{ animationDelay: "80ms" }}
          title={
            ctx.device
              ? `${ctx.device.hostname} • ${ctx.device.ip ?? "no ip"}`
              : "Device status"
          }
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${resolveHealthCopy(ctx.systemHealth.status).dot}`}
          />
          <span className="text-label-primary font-medium">
            {ctx.device?.hostname ?? "Droplet"}
          </span>
          <span className="text-label-tertiary">·</span>
          <span>{resolveHealthCopy(ctx.systemHealth.status).label}</span>
        </div>
      )}
    </div>
  );
}

function ChatCapsule({
  ctx,
  size = "small",
}: {
  ctx: SharedContext;
  size?: "small" | "large";
}) {
  const padX = size === "large" ? "pl-5 p-3" : "pl-4 p-2";
  const minH = size === "large" ? "min-h-[44px]" : "min-h-[40px]";
  return (
    <div
      className={`
        aurora-ring rounded-[22px] shadow-[var(--shadow-hero)]
        focus-within:ring-2 focus-within:ring-accent/40 transition-shadow
      `}
      style={{ background: "var(--color-surface-raised)" }}
    >
      <div className={`flex items-end gap-3 ${padX}`}>
        <Sparkles
          size={size === "large" ? 18 : 16}
          className="self-center flex-shrink-0"
          style={{ color: "var(--aurora-ink)" }}
        />
        <textarea
          ref={ctx.taRef}
          rows={1}
          value={ctx.prompt}
          onChange={(e) => ctx.setPrompt(e.target.value)}
          onKeyDown={ctx.handleKey}
          placeholder="Ask anything — files, cameras, the network, your team…"
          aria-label="Ask Droplet"
          className={`
            flex-1 resize-none bg-transparent py-3 type-body text-label-primary
            placeholder:text-label-tertiary focus:outline-none ${minH} max-h-[180px]
          `}
        />
        <button
          onClick={() => ctx.send()}
          disabled={!ctx.hasPrompt}
          aria-label="Send to chat"
          className={`
            ${size === "large" ? "h-11 px-4" : "h-9 px-3"} rounded-full flex items-center gap-1.5
            type-subheadline font-medium transition-all duration-200 ease-smooth
            ${
              ctx.hasPrompt
                ? "bg-accent text-white hover:opacity-90 active:scale-[0.97]"
                : "bg-surface-secondary text-label-tertiary cursor-not-allowed"
            }
          `}
        >
          Ask
          <ArrowUpRight size={size === "large" ? 16 : 14} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

function Suggestions({ ctx }: { ctx: SharedContext }) {
  return (
    <div className="flex flex-wrap gap-2 mt-5">
      {SUGGESTIONS.map((s) => (
        <button
          key={s}
          onClick={() => ctx.send(s)}
          className="
            px-3.5 h-8 inline-flex items-center type-footnote
            text-label-secondary rounded-full border border-separator
            bg-surface-raised hover:border-accent/40
            hover:text-accent transition-colors
          "
        >
          {s}
        </button>
      ))}
    </div>
  );
}

function ModelStatus({ ctx }: { ctx: SharedContext }) {
  return (
    <div className="mt-5 flex items-center gap-3 type-caption-1 text-label-tertiary">
      <Cpu size={12} />
      <span>
        {ctx.localModels.length > 0
          ? `${ctx.localModels.length} local model${ctx.localModels.length > 1 ? "s" : ""} ready`
          : "Local models unavailable"}
      </span>
      <span className="text-label-quaternary">·</span>
      <Cloud size={12} />
      <span>
        {ctx.cloudModels.length > 0
          ? `${ctx.cloudModels.length} cloud model${ctx.cloudModels.length > 1 ? "s" : ""}`
          : "No cloud keys configured"}
      </span>
    </div>
  );
}

function KpiStrip({
  ctx,
  delay,
  admin = false,
}: {
  ctx: SharedContext;
  delay: string;
  admin?: boolean;
}) {
  const items = admin
    ? [
        {
          icon: Users,
          label: "People",
          value: "—",
          hint: "Multi-user support coming soon",
        },
        {
          icon: Activity,
          label: "Admin actions",
          value: "—",
          hint: "Audit feed coming soon",
        },
        {
          icon: HardDrive,
          label: "Storage",
          value:
            ctx.storage && ctx.storage.total > 0
              ? `${Math.round(ctx.storagePct)}%`
              : "—",
          hint:
            ctx.storage && ctx.storage.total > 0
              ? `${formatBytes(ctx.storage.used)} of ${formatBytes(ctx.storage.total)}`
              : "Measuring…",
        },
        {
          icon: ShieldCheck,
          label: "Posture",
          value: ctx.systemHealth?.status === "ok" ? "OK" : "Review",
          hint: "TLS · FIPS · BYOK",
        },
      ]
    : [
        {
          icon: HardDrive,
          label: "Storage",
          value:
            ctx.storage && ctx.storage.total > 0
              ? `${Math.round(ctx.storagePct)}%`
              : "—",
          hint:
            ctx.storage && ctx.storage.total > 0
              ? `${formatBytes(ctx.storage.available)} free`
              : "Measuring…",
        },
        {
          icon: NetworkIcon,
          label: "Network",
          value: ctx.device?.ip ?? "—",
          hint: ctx.device?.networkMode?.toUpperCase() ?? "no link",
          mono: true,
        },
        {
          icon: HomeIcon,
          label: "Devices",
          value: `${ctx.totalDevices}`,
          hint: ctx.totalDevices === 0 ? "Pair a Matter device" : "paired",
        },
        {
          icon: Sparkles,
          label: "AI",
          value: `${ctx.localModels.length + ctx.cloudModels.length}`,
          hint: `${ctx.localModels.length} local · ${ctx.cloudModels.length} cloud`,
        },
      ];

  return (
    <section
      className="grid grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-rise"
      style={{ animationDelay: delay }}
    >
      {items.map((item) => (
        <KpiTile key={item.label} {...item} />
      ))}
    </section>
  );
}

function KpiTile({
  icon: Icon,
  label,
  value,
  hint,
  mono,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
  mono?: boolean;
}) {
  return (
    <div className="dp-tile p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
          {label}
        </span>
        <Icon size={14} className="text-label-tertiary" />
      </div>
      <div>
        <p
          className={`type-title-2 text-label-primary tabular-nums truncate ${mono ? "font-mono" : ""}`}
        >
          {value}
        </p>
        <p className="type-caption-1 text-label-tertiary mt-1 truncate">{hint}</p>
      </div>
    </div>
  );
}

function AICapsuleCard({ ctx }: { ctx: SharedContext }) {
  return (
    <section className="dp-tile p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-accent" />
        <span className="type-caption-1 text-accent uppercase tracking-[0.18em]">
          Ask AI
        </span>
        <span className="type-caption-2 text-label-tertiary ml-auto">
          {ctx.localModels.length > 0
            ? `${ctx.localModels[0].name ?? "local"} · local`
            : "local model offline"}
        </span>
      </div>
      <h3 className="type-headline text-label-primary">Ask anything</h3>
      <p className="type-footnote text-label-tertiary">
        Files, cameras, devices, the network. {ctx.isHome ? "Your household" : "Your team"}'s brain.
      </p>
      <ChatCapsule ctx={ctx} size="small" />
      <div className="flex flex-wrap gap-1.5">
        {SUGGESTIONS.slice(0, 3).map((s) => (
          <button
            key={s}
            onClick={() => ctx.send(s)}
            className="
              px-2.5 h-7 inline-flex items-center type-caption-1
              text-label-secondary rounded-full border border-separator
              bg-surface-tertiary hover:border-accent/40 hover:text-accent
              transition-colors
            "
          >
            {s}
          </button>
        ))}
      </div>
    </section>
  );
}

function LiveCamerasCard({ ctx: _ctx }: { ctx: SharedContext }) {
  // Phase 2 placeholder — pulls from /api/cameras in Phase 2b. For now
  // a tasteful empty state with a CTA so the layout still reads.
  return (
    <section className="dp-tile p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="type-headline text-label-primary">Live cameras</h3>
          <p className="type-footnote text-label-tertiary">
            Paired ONVIF + Matter cameras
          </p>
        </div>
        <Link
          href="/cameras"
          className="
            type-footnote text-accent hover:underline
            inline-flex items-center gap-1
          "
        >
          Open wall <ArrowRight size={12} />
        </Link>
      </div>
      <div className="rounded-xl border border-dashed border-separator p-6 text-center">
        <Video
          size={20}
          className="mx-auto text-label-tertiary mb-2"
          strokeWidth={1.5}
        />
        <p className="type-footnote text-label-tertiary">
          No cameras paired yet. Open the Cameras page to discover ONVIF
          devices on your network.
        </p>
      </div>
    </section>
  );
}

function NeedsAttentionCard({ ctx }: { ctx: SharedContext }) {
  // Phase 2: pulls from /api/notifications + /api/orchestrator/health.
  // For now we surface the system health status as a single row + a
  // link out to the notifications drawer.
  if (!ctx.systemHealth) {
    return null;
  }
  if (ctx.systemHealth.status === "ok") {
    return (
      <section className="dp-tile p-5">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-full bg-system-green/15 flex items-center justify-center flex-shrink-0">
            <ShieldCheck size={16} className="text-system-green" />
          </span>
          <div className="flex-1">
            <p className="type-subheadline text-label-primary font-medium">
              All systems operational
            </p>
            <p className="type-caption-1 text-label-tertiary">
              {ctx.health ? `${formatUptime(ctx.health.uptime)} uptime` : "Up"}
            </p>
          </div>
        </div>
      </section>
    );
  }
  const tone =
    ctx.systemHealth.status === "down"
      ? "text-system-red bg-system-red/15"
      : "text-system-orange bg-system-orange/15";
  return (
    <section className="dp-tile p-5">
      <div className="flex items-center gap-3">
        <span
          className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${tone}`}
        >
          <AlertTriangle size={16} />
        </span>
        <div className="flex-1">
          <p className="type-subheadline text-label-primary font-medium">
            {resolveHealthCopy(ctx.systemHealth.status).label}
          </p>
          <p className="type-caption-1 text-label-tertiary">
            {ctx.systemHealth.components?.length
              ? `${ctx.systemHealth.components.length} component${ctx.systemHealth.components.length > 1 ? "s" : ""} reporting`
              : "Open Settings for detail"}
          </p>
        </div>
        <Link
          href="/settings"
          className="type-footnote text-accent hover:underline"
        >
          Triage
        </Link>
      </div>
    </section>
  );
}

function RecentActivityCard() {
  // Phase 2 placeholder — pulls from /api/admin-claude-activity for
  // owners/admins, /api/notifications for others. For now an empty
  // state that doesn't lie about data we don't have.
  return (
    <section className="dp-tile p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="type-headline text-label-primary">Recent activity</h3>
        <Link
          href="/admin/claude-activity"
          className="type-footnote text-accent hover:underline"
        >
          View all
        </Link>
      </div>
      <p className="type-footnote text-label-tertiary italic">
        Activity feed coming soon, once the orchestrator audit-log
        endpoint goes live. For now you can view AI tool calls in the
        Activity page.
      </p>
    </section>
  );
}

function FilesRecentCard({ ctx }: { ctx: SharedContext }) {
  return (
    <section className="dp-tile p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="type-headline text-label-primary">Files</h3>
          <p className="type-footnote text-label-tertiary">
            {ctx.storage && ctx.storage.total > 0
              ? `${formatBytes(ctx.storage.used)} of ${formatBytes(ctx.storage.total)} used`
              : "Ready to sync"}
          </p>
        </div>
        <Link
          href="/files"
          className="type-footnote text-accent hover:underline inline-flex items-center gap-1"
        >
          Open Files <ArrowRight size={12} />
        </Link>
      </div>
      <div className="mb-4">
        <div className="h-[6px] rounded-full overflow-hidden bg-surface-secondary">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.max(2, Math.min(100, ctx.storagePct))}%`,
              background:
                ctx.storagePct > 90
                  ? "var(--color-system-red)"
                  : ctx.storagePct > 75
                    ? "var(--color-system-orange)"
                    : "var(--color-accent)",
            }}
          />
        </div>
      </div>
      {ctx.recents.length === 0 ? (
        <p className="type-footnote text-label-tertiary italic">
          No recent files yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {ctx.recents.slice(0, 5).map((f) => (
            <li
              key={f.path}
              className="flex items-center justify-between gap-3 type-footnote"
            >
              <span className="truncate text-label-primary">{f.name}</span>
              <span className="type-caption-2 text-label-tertiary flex-shrink-0">
                {f.isDirectory ? "folder" : formatBytes(f.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ApprovalsQueueCard() {
  // Phase 3 — wires to /api/auth/invites + /api/auth/new-device-requests.
  // Empty-state for Phase 2.
  return (
    <section className="dp-tile p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="type-headline text-label-primary">Approvals queue</h3>
        <Link
          href="/users"
          className="type-footnote text-accent hover:underline"
        >
          Manage
        </Link>
      </div>
      <p className="type-footnote text-label-tertiary italic">
        Pending invites + new-device sign-ins surface here. None right now.
      </p>
    </section>
  );
}

function PlanTileCard() {
  // Phase 3 — wires to billing. Stefan 2026-05-18: lease info stays
  // visible in both Home and Business workspaces so customers can manage
  // payment + see when the lease is up.
  return (
    <section className="dp-tile p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="type-headline text-label-primary">Plan</h3>
          <p className="type-footnote text-label-tertiary">
            3-year lease · monthly billing
          </p>
        </div>
        <Link
          href="/settings"
          className="type-footnote text-accent hover:underline"
        >
          Manage
        </Link>
      </div>
      <p className="type-footnote text-label-tertiary italic">
        Lease detail, storage upgrade, and payment management coming soon.
      </p>
    </section>
  );
}

function SystemHealthCard({ ctx }: { ctx: SharedContext }) {
  const components = ctx.systemHealth?.components ?? [];
  return (
    <section className="dp-tile p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="type-headline text-label-primary">System health</h3>
        <Link
          href="/settings"
          className="type-footnote text-accent hover:underline"
        >
          Detail
        </Link>
      </div>
      {components.length === 0 ? (
        <p className="type-footnote text-label-tertiary italic">
          Health check pending. The orchestrator probes each service every
          15 seconds.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {components.slice(0, 5).map((c) => {
            // SystemComponentStatus is only "ok" | "down" per api.ts;
            // overall SystemHealth.status carries the "degraded" middle.
            const tone = c.status === "ok" ? "bg-system-green" : "bg-system-red";
            return (
              <li key={c.name} className="flex items-center gap-2.5">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${tone} flex-shrink-0`}
                />
                <span className="type-footnote text-label-primary flex-1 truncate">
                  {c.name}
                </span>
                <span className="type-caption-1 text-label-tertiary capitalize">
                  {c.status}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SecurityPostureCard() {
  // Phase 3 — pulls from /api/fips + /api/auth/providers.
  return (
    <section className="dp-tile p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="type-headline text-label-primary">Security posture</h3>
      </div>
      <ul className="space-y-2.5">
        <PostureRow
          icon={ShieldCheck}
          label="On-device authentication"
          state="ok"
          detail="Local accounts only — no cloud SSO required"
        />
        <PostureRow
          icon={ShieldCheck}
          label="Transport TLS"
          state="ok"
          detail="Self-signed cert on .local · Let's Encrypt remote"
        />
        <PostureRow
          icon={ShieldCheck}
          label="FIPS 140-3"
          state="ok"
          detail="Fernet keys · TLS 1.3"
        />
        <PostureRow
          icon={UserPlus}
          label="Invite key rotation"
          state="neutral"
          detail="Manual, automation coming soon"
        />
      </ul>
    </section>
  );
}

function PostureRow({
  icon: Icon,
  label,
  state,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  state: "ok" | "warn" | "neutral";
  detail: string;
}) {
  const tone =
    state === "ok"
      ? "text-system-green"
      : state === "warn"
        ? "text-system-orange"
        : "text-label-tertiary";
  return (
    <li className="flex items-start gap-2.5">
      <Icon size={14} className={`${tone} mt-0.5 flex-shrink-0`} />
      <div className="min-w-0 flex-1">
        <p className="type-footnote text-label-primary truncate">{label}</p>
        <p className="type-caption-2 text-label-tertiary truncate">{detail}</p>
      </div>
    </li>
  );
}

function PrimaryTiles({
  ctx,
  delay,
}: {
  ctx: SharedContext;
  delay: string;
}) {
  return (
    <section
      className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-10 animate-fade-rise"
      style={{ animationDelay: delay }}
    >
      <Link
        href="/files"
        className="dp-tile dp-tile-interactive p-6 flex flex-col gap-5 group"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-accent-subtle flex items-center justify-center">
              <FolderOpen size={18} className="text-accent" />
            </span>
            <div>
              <h3 className="type-headline text-label-primary">Files</h3>
              <p className="type-footnote text-label-tertiary">
                {ctx.storage && ctx.storage.total > 0
                  ? `${formatBytes(ctx.storage.used)} of ${formatBytes(ctx.storage.total)} used`
                  : "Ready to sync"}
              </p>
            </div>
          </div>
          <ArrowRight
            size={16}
            className="text-label-tertiary group-hover:text-accent group-hover:translate-x-1 transition-all"
          />
        </div>
        <div>
          <div className="h-[6px] rounded-full overflow-hidden bg-surface-secondary">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${Math.max(2, Math.min(100, ctx.storagePct))}%`,
                background:
                  ctx.storagePct > 90
                    ? "var(--color-system-red)"
                    : ctx.storagePct > 75
                      ? "var(--color-system-orange)"
                      : "var(--color-accent)",
              }}
            />
          </div>
        </div>
        <div className="border-t border-separator pt-4">
          <p className="type-caption-1 text-label-tertiary uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Clock size={11} /> Recent
          </p>
          {ctx.recents.length === 0 ? (
            <p className="type-footnote text-label-tertiary italic">
              No recent files yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {ctx.recents.slice(0, 4).map((f) => (
                <li
                  key={f.path}
                  className="flex items-center justify-between gap-3 type-footnote"
                >
                  <span className="truncate text-label-primary">{f.name}</span>
                  <span className="type-caption-2 text-label-tertiary flex-shrink-0">
                    {f.isDirectory ? "folder" : formatBytes(f.size)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Link>

      <Link
        href="/devices"
        className="dp-tile dp-tile-interactive p-6 flex flex-col gap-5 group"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-accent-subtle flex items-center justify-center">
              <HomeIcon size={18} className="text-accent" />
            </span>
            <div>
              <h3 className="type-headline text-label-primary">Devices</h3>
              <p className="type-footnote text-label-tertiary">
                {ctx.totalDevices > 0
                  ? `${ctx.totalDevices} device${ctx.totalDevices === 1 ? "" : "s"} online`
                  : "No devices paired yet"}
              </p>
            </div>
          </div>
          <ArrowRight
            size={16}
            className="text-label-tertiary group-hover:text-accent group-hover:translate-x-1 transition-all"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <DeviceStat icon={Lightbulb} label="Lights" count={ctx.deviceCounts.lights} />
          <DeviceStat icon={Thermometer} label="Climate" count={ctx.deviceCounts.climate} />
          <DeviceStat icon={Video} label="Cameras" count={ctx.deviceCounts.cameras} hint="Scan" />
        </div>
        <div className="border-t border-separator pt-4 type-footnote text-label-tertiary italic flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              ctx.totalDevices > 0
                ? "bg-system-green animate-pulse"
                : "bg-label-quaternary"
            }`}
          />
          {ctx.totalDevices > 0
            ? "Matter controller discovering on your network"
            : "Pair a Matter device to see it here"}
        </div>
      </Link>
    </section>
  );
}

function DeviceStat({
  icon: Icon,
  label,
  count,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl bg-surface-secondary/70 p-3 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <Icon size={14} className="text-label-tertiary" />
        <span className="type-title-3 text-label-primary tabular-nums">
          {count}
        </span>
      </div>
      <p className="type-caption-1 text-label-tertiary">
        {count === 0 && hint ? hint : label}
      </p>
    </div>
  );
}

function ContextSection({ delay }: { delay: string }) {
  return (
    <section
      className="mt-6 animate-fade-rise"
      style={{ animationDelay: delay }}
    >
      <ContextWidget />
    </section>
  );
}

function QuickLinksRow({ delay }: { delay: string }) {
  const links: Array<{ href: string; label: string; icon: LucideIcon }> = [
    { href: "/chat", label: "Chats", icon: MessageSquare },
    { href: "/cameras", label: "Cameras", icon: Video },
    { href: "/network", label: "Network", icon: NetworkIcon },
    { href: "/users", label: "Users", icon: Users },
  ];
  return (
    <section
      className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-8 animate-fade-rise"
      style={{ animationDelay: delay }}
    >
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="dp-tile dp-tile-interactive px-4 py-4 flex items-center gap-3 group"
        >
          <span className="w-8 h-8 rounded-lg bg-surface-secondary flex items-center justify-center">
            <l.icon
              size={15}
              className="text-label-secondary group-hover:text-accent transition-colors"
            />
          </span>
          <span className="type-subheadline text-label-primary flex-1">
            {l.label}
          </span>
          <ArrowRight
            size={13}
            className="text-label-quaternary group-hover:text-accent group-hover:translate-x-0.5 transition-all"
          />
        </Link>
      ))}
    </section>
  );
}

function StatusRibbon({
  ctx,
  delay,
}: {
  ctx: SharedContext;
  delay: string;
}) {
  return (
    <section className="animate-fade-rise mt-8" style={{ animationDelay: delay }}>
      <div className="dp-tile px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-0 sm:divide-x sm:divide-separator">
        <StatusSegment
          icon={HardDrive}
          primary={
            ctx.storage && ctx.storage.total > 0
              ? `${Math.round(ctx.storagePct)}%`
              : "—"
          }
          secondary="Storage"
        />
        <StatusSegment
          icon={Cpu}
          primary={`${ctx.localModels.length + ctx.cloudModels.length}`}
          secondary="AI models"
        />
        <StatusSegment
          icon={NetworkIcon}
          primary={ctx.device?.ip ?? "—"}
          secondary={ctx.device?.networkMode?.toUpperCase() ?? "Network"}
          mono
        />
        <StatusSegment
          icon={Sparkles}
          primary={ctx.health ? formatUptime(ctx.health.uptime) : "—"}
          secondary={`v${ctx.health?.version ?? "0.1.0"}`}
        />
        <Link
          href="/settings"
          className="
            sm:ml-auto sm:pl-6 type-footnote text-label-tertiary hover:text-accent
            flex items-center gap-1.5 transition-colors
          "
        >
          <Settings size={13} />
          Settings
        </Link>
      </div>
    </section>
  );
}

function StatusSegment({
  icon: Icon,
  primary,
  secondary,
  mono,
}: {
  icon: LucideIcon;
  primary: string;
  secondary: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 sm:px-5 first:sm:pl-0">
      <Icon size={14} className="text-label-tertiary" />
      <div className="min-w-0">
        <p
          className={`type-subheadline text-label-primary truncate ${mono ? "font-mono tabular-nums" : "font-medium"}`}
        >
          {primary}
        </p>
        <p className="type-caption-2 text-label-tertiary uppercase tracking-wider">
          {secondary}
        </p>
      </div>
    </div>
  );
}
