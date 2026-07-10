/**
 * Static connector catalog for the Integrations hub (WARP-1101). Eaglesoft is
 * provider #1; the rest are framework placeholders so the hub reads as
 * "systems you can connect", not a one-off. Copy + order match the Claude
 * Design handoff (Eaglesoft · Dentrix · QuickBooks · Open Dental). Live
 * connection *status* is merged in from the backend (GET /api/integrations) by
 * useIntegrations — this file is only the descriptive metadata.
 */

import type { ConnectorMeta } from "./erp-types";

export const CONNECTORS: ConnectorMeta[] = [
  {
    id: "eaglesoft",
    name: "Eaglesoft",
    category: "Practice management",
    description:
      "Read your schedule, patients, and balances — directly from Eaglesoft, on your network.",
    availability: "available",
  },
  {
    id: "dentrix",
    name: "Dentrix",
    category: "Practice management",
    description:
      "Schedule, patients, and ledgers from Dentrix — read on your own network.",
    availability: "coming-soon",
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    category: "Accounting",
    description:
      "Production, receivables, and deposits from your books — no export, no upload.",
    availability: "coming-soon",
  },
  {
    id: "opendental",
    name: "Open Dental",
    category: "Practice management",
    description:
      "Read the schedule and patient records straight from your Open Dental database.",
    availability: "coming-soon",
  },
];

export function connectorMeta(id: string): ConnectorMeta | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
