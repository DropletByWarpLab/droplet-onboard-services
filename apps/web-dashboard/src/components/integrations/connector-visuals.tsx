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
  type LucideIcon,
} from "lucide-react";
import type { BadgeKind } from "@/components/shell/primitives";
import type { ConnectorId, IntegrationStatus } from "@/lib/erp-types";

export function connectorIcon(id: ConnectorId): LucideIcon {
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

/** Hub-tile / connected-row status pill. NOT_CONFIGURED is handled by the tile
 *  itself (it shows the "Connect"/"Coming soon" affordance, not a pill). */
export function statusView(status: IntegrationStatus): StatusView {
  switch (status) {
    case "CONNECTED":
      return { label: "Connected", kind: "ok", icon: CheckCircle2 };
    case "DEGRADED":
    case "DRIFT_LOCKED":
      return { label: "Needs attention", kind: "warn", icon: AlertTriangle };
    case "ERROR":
      return { label: "Can't connect", kind: "danger", icon: AlertTriangle };
    case "PROVISIONING":
      return { label: "Waiting for setup", kind: "warn", icon: Clock };
    case "DISABLED":
      return { label: "Disconnected", kind: "muted", icon: Plug };
    case "NOT_CONFIGURED":
    default:
      return { label: "Available", kind: "muted", icon: Plug };
  }
}
