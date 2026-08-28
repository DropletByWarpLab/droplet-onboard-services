"use client";

/**
 * Connector iconography + status presentation shared by the hub and the ERP
 * surface. Status → {label, badge kind, icon} for the hub tile pill / connected
 * row; the ERP hero computes its own Eaglesoft-specific headlines inline.
 */

import {
  Stethoscope,
  Database,
  Calculator,
  Plug,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Lock,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";
import type { BadgeKind } from "@/components/shell/primitives";
import type { IntegrationStatus } from "@/lib/erp-types";

/**
 * Takes any tile id, not only a catalog one: the hub also renders providers the
 * box reports that the catalog does not list (WARP-2291), and those arrive as
 * raw provider keys. The `Plug` default is the honest icon for "a connector we
 * have no picture of".
 */
export function connectorIcon(id: string): LucideIcon {
  switch (id) {
    case "eaglesoft":
      return Stethoscope;
    case "dentrix":
    case "opendental":
      return Database;
    case "quickbooks":
      return Calculator;
    default:
      return Plug;
  }
}

export interface StatusView {
  label: string;
  kind: BadgeKind;
  icon: LucideIcon;
}

/**
 * Hub-tile / connected-row status pill.
 *
 * All seven `IntegrationStatus` values get their own treatment (WARP-2291).
 * Fixing the status merge made five of them reachable in the hub for the first
 * time, and collapsing DRIFT_LOCKED into DEGRADED loses the one distinction
 * that tells an owner whether to fix something or whether a schema change
 * locked writes. The wording matches the reports surface's `PILL` map
 * (`app/reports/connectors.ts:22-30`) so one connection reads the same in both
 * places.
 *
 * `NOT_CONFIGURED` now gets a pill of its own because the hub finally
 * distinguishes "the box says this is not configured" from "the box has not
 * told us anything about it" — the latter is a `ConnectionState`, not a status,
 * and never reaches this function.
 *
 * The `default` is for a status a newer box invents. It reads as "look at
 * this", never as healthy: an unclassifiable state rendered as fine is exactly
 * how a broken connection stays invisible.
 */
export function statusView(status: IntegrationStatus): StatusView {
  switch (status) {
    case "CONNECTED":
      return { label: "Connected", kind: "ok", icon: CheckCircle2 };
    case "DEGRADED":
      return { label: "Needs attention", kind: "warn", icon: AlertTriangle };
    case "DRIFT_LOCKED":
      return { label: "Locked — schema changed", kind: "danger", icon: Lock };
    case "ERROR":
      return { label: "Can't connect", kind: "danger", icon: AlertTriangle };
    case "PROVISIONING":
      return { label: "Setting up", kind: "warn", icon: Clock };
    case "DISABLED":
      return { label: "Turned off", kind: "muted", icon: Plug };
    case "NOT_CONFIGURED":
      return { label: "Not connected", kind: "muted", icon: Plug };
    default:
      return { label: "Unknown state", kind: "warn", icon: HelpCircle };
  }
}
