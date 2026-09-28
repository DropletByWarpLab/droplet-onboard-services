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
import { useBoxAddress } from "@/lib/hooks/useBoxAddress";
import { resolveHealthCopy } from "@/app/health-copy";
import { AmbientLayer } from "@/components/home/AmbientLayer";
import { Phead } from "./primitives";

import "./indigo-tokens.css";
import "./droplet-shell.css";
// AmbientLayer's `.dh-drop` rules live in the home stylesheet; import it so
// the load indicator is styled on shell pages too.
import "@/components/home/home-bento.css";

function ShellStatusChip() {
  const { data } = useSWR<SystemHealth>("/api/orchestrator/health", fetchSystemHealth, {
    refreshInterval: 15_000,
  });
  const status = data?.status ?? "unknown";
  const copy = resolveHealthCopy(status);
  // WARP-992 + WARP-1342: canonical display identity — masks a leaked
  // container-id hostname and upgrades the droplet.local fallback to the
  // issued per-device FQDN (the address that also works over the VPN).
  const host = useBoxAddress();
  // The host and its separator are their own elements so the phone layer can
  // drop them: measured at 375px this chip is 282px of `white-space: nowrap`
  // against a 333px content box, and with `.pt-id` beside it the row made the
  // DOCUMENT 390-437px wide on every shell route. The status label is the
  // actionable half and stays — the dot alone would be a colour-only signal.
  // Their display is owned solely by `droplet-shell.css` (no Tailwind utility
  // and no `hidden` attribute here), so the WARP-1792 display-ownership rule
  // is not in play.
  return (
    <span className={"pt-chip is-" + status}>
      <span className="dot" />
      <b className="pt-host">{host}</b>
      <span className="pt-sep" aria-hidden="true"> · </span>
      <span className="pt-status">{copy.label}</span>
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
  /**
   * Opt into the page-rhythm rule (`.page-inner.rhythm`, droplet-shell.css):
   * one 24px gap between every direct child, 34px above a `.sect`. Only pass
   * it from a page whose children carry NO outer margin utilities of their
   * own — the two stack. WARP-2961.
   */
  rhythm?: boolean;
  children: ReactNode;
}

export function ShellPage({
  icon,
  label,
  title,
  sub,
  actions,
  ambient = true,
  rhythm = false,
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
        <div className={rhythm ? "page-inner rhythm" : "page-inner"}>
          {title ? <Phead title={title} sub={sub} actions={actions} /> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
