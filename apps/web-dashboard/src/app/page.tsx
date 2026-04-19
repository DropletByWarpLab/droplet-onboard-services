"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  ArrowUpRight,
  ArrowRight,
  FolderOpen,
  Home as HomeIcon,
  Sparkles,
  Lightbulb,
  Thermometer,
  Video,
  Network as NetworkIcon,
  HardDrive,
  Cpu,
  Cloud,
  MessageSquare,
  Settings,
  Users,
  Clock,
  type LucideIcon,
} from "lucide-react";
import { useDevice } from "@/lib/hooks/useDevice";
import { useModels } from "@/lib/hooks/useModels";
import { useStorage } from "@/lib/hooks/useStorage";
import { useRecents } from "@/lib/hooks/useRecents";
import { useSmartHome } from "@/lib/hooks/useSmartHome";
import { useAuth } from "@/lib/auth";
import { fetchSystemHealth, type SystemHealth } from "@/lib/api";
import type { FileEntryInfo } from "@/lib/types";

// ─────────────────────────────── helpers ───────────────────────────────

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

const SUGGESTIONS = [
  "Summarize the files I uploaded today",
  "Dim the living-room lights to 30%",
  "What's using the most storage?",
  "Draft a changelog from recent notes",
];

const HEALTH_COPY: Record<SystemHealth["status"], { label: string; dot: string }> = {
  ok:       { label: "All systems operational", dot: "bg-system-green" },
  degraded: { label: "Degraded",                dot: "bg-system-orange" },
  down:     { label: "Needs attention",         dot: "bg-system-red" },
};

// ─────────────────────────────── page ───────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const { user } = useAuth();
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

  // Hero chat — type here, hit ⏎, land in /chat with the question queued
  const [prompt, setPrompt] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const send = (text?: string) => {
    const body = (text ?? prompt).trim();
    if (!body) return;
    try {
      window.sessionStorage.setItem("droplet.pendingPrompt", body);
    } catch {
      /* private mode — /chat will still open */
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
        cameras: 0, // cameras live in their own page; surfaced below
      }
    : { lights: 0, climate: 0, cameras: 0 };

  return (
    <div className="relative min-h-screen">
      {/* ── Aurora backdrop ─────────────────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] aurora-bg opacity-[0.55] animate-aurora"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[420px] h-32 bg-gradient-to-b from-surface-secondary/0 to-surface-secondary"
      />

      <div className="relative p-6 lg:p-12 max-w-6xl mx-auto">
        {/* ── Header strip ─────────────────────────────── */}
        <div className="flex items-start justify-between mb-10 animate-fade-rise">
          <div>
            <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
              {greeting()}
              {firstName && <span className="text-label-secondary">, {firstName}</span>}
            </p>
            <p className="type-footnote text-label-tertiary mt-1">
              {new Date().toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </p>
          </div>

          {systemHealth && (
            <div
              className="dp-status-chip animate-fade-rise"
              style={{ animationDelay: "80ms" }}
              title={
                device
                  ? `${device.hostname} • ${device.ip ?? "no ip"}`
                  : "Device status"
              }
            >
              <span className={`w-1.5 h-1.5 rounded-full ${HEALTH_COPY[systemHealth.status].dot}`} />
              <span className="text-label-primary font-medium">
                {device?.hostname ?? "Droplet"}
              </span>
              <span className="text-label-tertiary">·</span>
              <span>{HEALTH_COPY[systemHealth.status].label}</span>
            </div>
          )}
        </div>

        {/* ── AI HERO ─────────────────────────────── */}
        <section
          className="mb-14 animate-fade-rise"
          style={{ animationDelay: "120ms" }}
        >
          <h1 className="type-display text-label-primary text-[56px] sm:text-[72px] lg:text-[88px] mb-8 max-w-4xl">
            What can I{" "}
            <span className="type-display-italic" style={{ color: "var(--aurora-ink)" }}>
              help you
            </span>{" "}
            with today?
          </h1>

          {/* Chat capsule */}
          <div
            className="aurora-ring rounded-[22px] shadow-[var(--shadow-hero)]"
            style={{ background: "var(--color-surface-raised)" }}
          >
            <div className="flex items-end gap-3 p-3 pl-5">
              <Sparkles size={18} className="mt-3 flex-shrink-0" style={{ color: "var(--aurora-ink)" }} />
              <textarea
                ref={taRef}
                rows={1}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Ask anything — run a command, search your files, control a device…"
                className="flex-1 resize-none bg-transparent py-3 type-body text-label-primary
                           placeholder:text-label-tertiary focus:outline-none min-h-[44px] max-h-[180px]"
              />
              <button
                onClick={() => send()}
                disabled={!hasPrompt}
                aria-label="Send to chat"
                className={`
                  h-11 px-4 rounded-full flex items-center gap-1.5
                  type-subheadline font-medium transition-all duration-200 ease-smooth
                  ${hasPrompt
                    ? "bg-accent text-white hover:opacity-90 active:scale-[0.97]"
                    : "bg-surface-secondary text-label-tertiary cursor-not-allowed"}
                `}
              >
                Ask
                <ArrowUpRight size={16} strokeWidth={2.5} />
              </button>
            </div>
          </div>

          {/* Suggestions */}
          <div className="flex flex-wrap gap-2 mt-5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="px-3.5 h-8 inline-flex items-center type-footnote
                           text-label-secondary rounded-full border border-separator
                           bg-surface-raised hover:border-accent/40
                           hover:text-accent transition-colors"
                style={{ background: "var(--color-surface-raised)" }}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="mt-5 flex items-center gap-3 type-caption-1 text-label-tertiary">
            <Cpu size={12} />
            <span>
              {localModels.length > 0
                ? `${localModels.length} local model${localModels.length > 1 ? "s" : ""} ready`
                : "Local models unavailable"}
            </span>
            <span className="text-label-quaternary">·</span>
            <Cloud size={12} />
            <span>
              {cloudModels.length > 0
                ? `${cloudModels.length} cloud model${cloudModels.length > 1 ? "s" : ""}`
                : "No cloud keys configured"}
            </span>
          </div>
        </section>

        {/* ── PRIMARY TILES: Files & Devices ─────────────── */}
        <section
          className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-10 animate-fade-rise"
          style={{ animationDelay: "220ms" }}
        >
          {/* FILES TILE */}
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
                    {storage && storage.total > 0
                      ? `${formatBytes(storage.used)} of ${formatBytes(storage.total)} used`
                      : "Ready to sync"}
                  </p>
                </div>
              </div>
              <ArrowRight
                size={16}
                className="text-label-tertiary group-hover:text-accent group-hover:translate-x-1 transition-all"
              />
            </div>

            {/* Storage meter */}
            <div>
              <div className="h-[6px] rounded-full overflow-hidden bg-surface-secondary">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${Math.max(2, Math.min(100, storagePct))}%`,
                    background:
                      storagePct > 90
                        ? "var(--color-system-red)"
                        : storagePct > 75
                          ? "var(--color-system-orange)"
                          : "var(--color-accent)",
                  }}
                />
              </div>
              <div className="flex items-center justify-between mt-2 type-caption-1 text-label-tertiary">
                <span>
                  {storage && storage.total > 0
                    ? `${Math.round(storagePct)}% used`
                    : "Measuring…"}
                </span>
                <span>
                  {storage?.available ? `${formatBytes(storage.available)} free` : " "}
                </span>
              </div>
            </div>

            {/* Recents preview */}
            <div className="border-t border-separator pt-4">
              <p className="type-caption-1 text-label-tertiary uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Clock size={11} /> Recent
              </p>
              {recents.length === 0 ? (
                <p className="type-footnote text-label-tertiary italic">No recent files yet.</p>
              ) : (
                <ul className="space-y-2">
                  {recents.slice(0, 4).map((f: FileEntryInfo) => (
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

          {/* DEVICES TILE */}
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
                  <h3 className="type-headline text-label-primary">Connected devices</h3>
                  <p className="type-footnote text-label-tertiary">
                    {totalDevices > 0
                      ? `${totalDevices} device${totalDevices === 1 ? "" : "s"} online`
                      : "No devices paired yet"}
                  </p>
                </div>
              </div>
              <ArrowRight
                size={16}
                className="text-label-tertiary group-hover:text-accent group-hover:translate-x-1 transition-all"
              />
            </div>

            {/* Device breakdown */}
            <div className="grid grid-cols-3 gap-3">
              <DeviceStat
                icon={Lightbulb}
                label="Lights"
                count={deviceCounts.lights}
              />
              <DeviceStat
                icon={Thermometer}
                label="Climate"
                count={deviceCounts.climate}
              />
              <DeviceStat icon={Video} label="Cameras" count={deviceCounts.cameras} hint="Scan" />
            </div>

            {/* Active preview or empty */}
            <div className="border-t border-separator pt-4 type-footnote text-label-tertiary italic flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  totalDevices > 0 ? "bg-system-green animate-pulse" : "bg-label-quaternary"
                }`}
              />
              {totalDevices > 0
                ? "Matter controller discovering on your network"
                : "Pair a Matter device to see it here"}
            </div>
          </Link>
        </section>

        {/* ── SECONDARY: quick-access row ────────────────── */}
        <section
          className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10 animate-fade-rise"
          style={{ animationDelay: "320ms" }}
        >
          <QuickLink href="/chat" label="Chats" icon={MessageSquare} />
          <QuickLink href="/cameras" label="Cameras" icon={Video} />
          <QuickLink href="/network" label="Network" icon={NetworkIcon} />
          <QuickLink href="/users" label="Users" icon={Users} />
        </section>

        {/* ── STATUS RIBBON ─────────────────────────────── */}
        <section
          className="animate-fade-rise"
          style={{ animationDelay: "400ms" }}
        >
          <div className="dp-tile px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-0 sm:divide-x sm:divide-separator">
            <StatusSegment
              icon={HardDrive}
              primary={
                storage && storage.total > 0
                  ? `${Math.round(storagePct)}%`
                  : "—"
              }
              secondary="Storage"
            />
            <StatusSegment
              icon={Cpu}
              primary={`${localModels.length + cloudModels.length}`}
              secondary="AI models"
            />
            <StatusSegment
              icon={NetworkIcon}
              primary={device?.ip ?? "—"}
              secondary={device?.networkMode?.toUpperCase() ?? "Network"}
              mono
            />
            <StatusSegment
              icon={Sparkles}
              primary={health ? formatUptime(health.uptime) : "—"}
              secondary={`v${health?.version ?? "0.1.0"}`}
            />

            <Link
              href="/settings"
              className="sm:ml-auto sm:pl-6 type-footnote text-label-tertiary hover:text-accent
                         flex items-center gap-1.5 transition-colors"
            >
              <Settings size={13} />
              Settings
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

// ─────────────────────────────── subcomponents ───────────────────────────────

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

function QuickLink({
  href,
  label,
  icon: Icon,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
}) {
  return (
    <Link
      href={href}
      className="dp-tile dp-tile-interactive px-4 py-4 flex items-center gap-3 group"
    >
      <span className="w-8 h-8 rounded-lg bg-surface-secondary flex items-center justify-center">
        <Icon size={15} className="text-label-secondary group-hover:text-accent transition-colors" />
      </span>
      <span className="type-subheadline text-label-primary flex-1">{label}</span>
      <ArrowRight
        size={13}
        className="text-label-quaternary group-hover:text-accent group-hover:translate-x-0.5 transition-all"
      />
    </Link>
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

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
