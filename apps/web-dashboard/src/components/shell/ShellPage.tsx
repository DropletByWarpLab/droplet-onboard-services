"use client";

/**
 * ShellPage — the indigo design language's page wrapper for every secondary
 * dashboard surface (Files, Network, Health, …). Mirrors the Claude Design
 * handoff's `AppShell` + `PageTop` (shell.jsx).
 *
 * The global Sidebar + mobile nav are supplied by `AuthGate`; this renders
 * INSIDE the existing `<main>` (which already carries the 260px sidebar
 * offset). It provides:
 *   · the indigo token scope (`.droplet-shell`) + ambient decorative layer
 *   · a slim sticky top bar with the device id + a LIVE rolled-up health chip
 *   · a centered, animated content column (`.page-inner`)
 *
 * Pages pass `icon`/`label` for the slim bar and optionally `title`/`sub`/
 * `actions` for the big page header (`Phead`). Everything else is children.
 */

import type { ReactNode } from "react";
import useSWR from "swr";
import { fetchSystemHealth, type SystemHealth } from "@/lib/api";
import { useDevice } from "@/lib/hooks/useDevice";
import { boxDisplayHost } from "@/lib/box-identity";
import { resolveHealthCopy } from "@/app/health-copy";
import { AmbientLayer } from "@/components/home/AmbientLayer";
import { Phead } from "./primitives";

import "./indigo-tokens.css";
import "./droplet-shell.css";
// AmbientLayer's `.dh-ambient` / `.dh-drop` rules live in the home stylesheet;
// import it so the decorative layer is styled on shell pages too. The `--blob-*`
// opacities it reads are defined in the `.droplet-shell` token scope above.
import "@/components/home/home-bento.css";

function ShellStatusChip() {
  const { device } = useDevice();
  const { data } = useSWR<SystemHealth>("/api/orchestrator/health", fetchSystemHealth, {
    refreshInterval: 15_000,
  });
  const status = data?.status ?? "unknown";
  const copy = resolveHealthCopy(status);
  // WARP-992: canonical display identity — masks a leaked container-id
  // hostname (stale Device row) and covers the not-yet-loaded state.
  const host = boxDisplayHost(device?.hostname);
  return (
    <span className={"pt-chip is-" + status}>
      <span className="dot" />
      <b>{host}</b>
      <span> · {copy.label}</span>
    </span>
  );
}

export interface ShellPageProps {
  /** Slim top-bar icon (e.g. `<Files size={15} />`). */
  icon?: ReactNode;
  /** Slim top-bar label — the section name. */
  label: string;
  /** Big page header title (H1). Omit to render no header. */
  title?: string;
  /** Big page header subtitle. */
  sub?: string;
  /** Right-aligned header actions. */
  actions?: ReactNode;
  /** Render the decorative ambient layer (default true). */
  ambient?: boolean;
  children: ReactNode;
}

export function ShellPage({
  icon,
  label,
  title,
  sub,
  actions,
  ambient = true,
  children,
}: ShellPageProps) {
  return (
    <div className="droplet-shell" data-screen-label={"Droplet — " + label}>
      {ambient && <AmbientLayer />}
      <header className="page-top">
        <span className="pt-id">
          {icon ? <span className="pt-ic">{icon}</span> : null}
          <span className="pt-t">{label}</span>
        </span>
        <span className="pt-spring" />
        <ShellStatusChip />
      </header>
      <div className="page-body">
        <div className="page-inner">
          {title ? <Phead title={title} sub={sub} actions={actions} /> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
