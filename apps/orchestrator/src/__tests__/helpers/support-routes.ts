/**
 * Shared fixtures for the support route suites (WARP-3528): the table of every
 * route the router mounts, with a valid request for each, and an effective-access
 * result builder. Test-only; nothing in production imports this.
 */
import type { ModuleId } from "@prisma/client";
import type { FeatureLevel } from "../../services/access-catalog.js";
import type { EffectiveAccessResult } from "../../services/effective-access.service.js";

export function grants(entries: Array<[ModuleId, FeatureLevel]>): EffectiveAccessResult {
  return {
    tier: "family",
    features: entries.map(([moduleId, level]) => ({ moduleId, level })),
    toolDomains: [],
    locks: false,
    cloud: false,
    connectors: {},
    connectorGrants: null,
    usage: {
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      source: "default",
      sources: { storageQuotaBytes: "default", maxUploadSizeMb: "default", llmDailyMessageCap: "default" },
    },
    deptRights: [],
    exceptions: [],
  };
}

export interface RouteCase {
  method: "get" | "post" | "patch" | "put";
  path: string;
  url: string;
  body?: unknown;
  ok: number;
  /** Desk setup is admin work: `family` is refused by role. */
  adminOnly?: boolean;
}

export const ROUTES: RouteCase[] = [
  { method: "get", path: "/support/agents", url: "/api/support/agents", ok: 200 },
  { method: "get", path: "/support/contacts", url: "/api/support/contacts?q=da", ok: 200 },
  { method: "post", path: "/support/contacts", url: "/api/support/contacts", body: { displayName: "Dana" }, ok: 201 },
  { method: "get", path: "/support/desks", url: "/api/support/desks", ok: 200 },
  { method: "post", path: "/support/desks", url: "/api/support/desks", body: { name: "Support" }, ok: 201, adminOnly: true },
  { method: "patch", path: "/support/desks/:id", url: "/api/support/desks/d1", body: { name: "X" }, ok: 200, adminOnly: true },
  { method: "get", path: "/support/email/accounts", url: "/api/support/email/accounts", ok: 200, adminOnly: true },
  { method: "get", path: "/support/desks/:id/email-channel", url: "/api/support/desks/d1/email-channel", ok: 200, adminOnly: true },
  { method: "put", path: "/support/desks/:id/email-channel", url: "/api/support/desks/d1/email-channel", body: { emailAccountId: null }, ok: 200, adminOnly: true },
  { method: "get", path: "/support/queues", url: "/api/support/queues", ok: 200 },
  { method: "get", path: "/support/tickets", url: "/api/support/tickets", ok: 200 },
  { method: "post", path: "/support/tickets", url: "/api/support/tickets", body: { deskId: "d1", subject: "s" }, ok: 201 },
  { method: "get", path: "/support/tickets/:ref", url: "/api/support/tickets/SUP-1", ok: 200 },
  { method: "patch", path: "/support/tickets/:id", url: "/api/support/tickets/t1", body: { priority: "low" }, ok: 200 },
  { method: "get", path: "/support/tickets/:id/conversation", url: "/api/support/tickets/t1/conversation", ok: 200 },
  { method: "post", path: "/support/tickets/:id/replies", url: "/api/support/tickets/t1/replies", body: { bodyHtml: "<p>x</p>" }, ok: 201 },
  { method: "post", path: "/support/tickets/:id/replies/:commentId/retry", url: "/api/support/tickets/t1/replies/cm1/retry", ok: 200 },
  { method: "post", path: "/support/tickets/:id/notes", url: "/api/support/tickets/t1/notes", body: { bodyHtml: "<p>x</p>" }, ok: 201 },
  { method: "post", path: "/support/tickets/:id/escalate", url: "/api/support/tickets/t1/escalate", body: { projectId: "p1" }, ok: 201 },
  { method: "get", path: "/support/requesters/:contactId/tickets", url: "/api/support/requesters/c1/tickets", ok: 200 },
];
