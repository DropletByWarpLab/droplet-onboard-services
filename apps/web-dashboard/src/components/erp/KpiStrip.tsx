"use client";

/**
 * The practice at a glance (design brief §4.2) — four read-only KPI tiles.
 * Values are facts pulled from Eaglesoft: mono, never editable. Schedule +
 * recall carry a unit ("appointments" / "patients") per the design handoff.
 * When there's no snapshot yet (not connected / loading) each shows an em-dash
 * placeholder rather than a fake zero.
 */

import { CalendarDays, DollarSign, Activity, UserRound } from "lucide-react";
import { Kpi } from "@/components/shell/primitives";
import type { ErpKpis } from "@/lib/erp-types";
import { formatUsd } from "@/lib/erp-format";

const DASH = "—";

export function KpiStrip({ kpis }: { kpis?: ErpKpis }) {
  return (
    <div className="grid c4" style={{ marginBottom: 4 }}>
      <Kpi
        icon={<CalendarDays size={13} />}
        label="Today's schedule"
        value={kpis ? kpis.appointmentsToday : DASH}
        unit={kpis ? "appointments" : undefined}
        note={
          kpis?.openChairsPm != null
            ? `${kpis.openChairsPm} open chairs this afternoon.`
            : "on the books today."
        }
      />
      <Kpi
        icon={<DollarSign size={13} />}
        label="Production today"
        value={kpis ? formatUsd(kpis.productionTodayCents) : DASH}
        note="scheduled · does not include walk-ins."
      />
      <Kpi
        icon={<Activity size={13} />}
        label="Accounts receivable"
        value={kpis ? formatUsd(kpis.arBalanceCents) : DASH}
        note="outstanding balance across all accounts."
      />
      <Kpi
        icon={<UserRound size={13} />}
        label="Recall due"
        value={kpis ? kpis.recallDue : DASH}
        unit={kpis ? "patients" : undefined}
        note="overdue for recare this month."
      />
    </div>
  );
}
