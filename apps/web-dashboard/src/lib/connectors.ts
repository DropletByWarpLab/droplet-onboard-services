/**
 * Static connector catalog for the Integrations hub (WARP-1101). Eaglesoft is
 * provider #1; the rest are framework placeholders so the hub reads as
 * "systems you can connect", not a one-off. Live connection *status* is merged
 * in from the backend (GET /api/integrations) by useIntegrations — this file
 * is only the descriptive metadata, which is safe to know client-side.
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
      "Connect your Dentrix database to bring its schedule and patients into Droplet.",
    availability: "coming-soon",
  },
  {
    id: "opendental",
    name: "Open Dental",
    category: "Practice management",
    description:
      "Link your Open Dental database for schedule, patients, and production.",
    availability: "coming-soon",
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    category: "Accounting",
    description:
      "Bring your books into Droplet to see production and receivables together.",
    availability: "coming-soon",
  },
];

export function connectorMeta(id: string): ConnectorMeta | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
