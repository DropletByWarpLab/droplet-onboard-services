/**
 * WARP-279 — Jira adapter for the meta-observability dashboard.
 *
 * Two exports:
 *   - getCompliancePhaseChain(): the WARP-229..278 sequential ticket chain
 *     (50 tickets) with per-ticket status. Powers the "WARP-228 chain
 *     progress" widget — done / in-progress / next-up / blocked + percent.
 *   - getInFlightTickets(): everything in the WARP project that isn't Done
 *     and has been updated recently. Powers the "in-flight tickets" panel.
 *
 * Both calls are wrapped in a 60s Redis cache (same TTL as GitHub) on keys
 * `claude-activity:jira:<fn>`. If Redis is down we fall through to the
 * live REST call with a warn log.
 *
 * Auth: Atlassian Cloud basic auth (email + API token base64-encoded).
 * Without all three of `JIRA_HOST` / `JIRA_EMAIL` / `JIRA_API_TOKEN` we
 * skip the calls entirely and return empty arrays — the dashboard renders
 * an "unconfigured" banner over the panel rather than 500-ing.
 */

import pino from "pino";
import { config } from "../../config.js";
import { cacheGet, cacheSet } from "../cache.service.js";

const logger = pino({ name: "claude-activity:jira" });

const CACHE_TTL_SECONDS = 60;
const CACHE_PREFIX = "claude-activity:jira:";
const REQUEST_TIMEOUT_MS = 8000;

// WARP-228 sequential chain: 50 tickets, WARP-229..278. Hard-coded
// because the ordering is the canonical truth in compliance-progress.md
// (which is also our fallback if Jira is unreachable).
const CHAIN_START = 229;
const CHAIN_END = 278;

// Common ticket-status taxonomy. Atlassian status names vary by project;
// we map them to a small enum the dashboard renders the same way.
export type TicketStatus = "todo" | "in_progress" | "blocked" | "done" | "unknown";

export interface JiraTicket {
  key: string;
  summary: string;
  status: TicketStatus;
  status_name: string; // raw Atlassian status (for tooltips)
  url: string;
  updated: string | null;
  assignee: string | null;
}

export interface JiraSnapshot {
  /** Configured at all? If false, the Jira panels render an "unconfigured" hint. */
  configured: boolean;
  /** WARP-229..278 in the canonical order. Empty when unconfigured. */
  chain: JiraTicket[];
  /** Open tickets across the project, newest update first. Empty when unconfigured. */
  in_flight: JiraTicket[];
  /** Counts derived from chain — saves the dashboard from re-deriving them. */
  chain_progress: {
    total: number;
    done: number;
    in_progress: number;
    blocked: number;
    not_started: number;
    percent: number;
  };
}

interface JiraRequestOpts {
  bypassCache?: boolean;
}

function isConfigured(): boolean {
  return !!(config.JIRA_HOST && config.JIRA_EMAIL && config.JIRA_API_TOKEN);
}

function authHeader(): string {
  const raw = `${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

async function jiraFetch<T>(searchPath: string): Promise<T | null> {
  if (!isConfigured()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `https://${config.JIRA_HOST}${searchPath}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: authHeader(),
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, url }, "jira request failed");
      return null;
    }
    return (await resp.json()) as T;
  } catch (err) {
    logger.warn({ err, searchPath }, "jira request errored");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function withCache<T>(
  key: string,
  loader: () => Promise<T>,
  opts: JiraRequestOpts = {},
): Promise<T> {
  const cacheKey = CACHE_PREFIX + key;
  if (!opts.bypassCache) {
    try {
      const cached = await cacheGet<T>(cacheKey);
      if (cached !== null) return cached;
    } catch (err) {
      logger.warn({ err, key }, "cache get failed; falling through to live");
    }
  }
  const fresh = await loader();
  try {
    await cacheSet(cacheKey, fresh, CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, key }, "cache set failed; continuing");
  }
  return fresh;
}

function classifyStatus(name: string): TicketStatus {
  const lower = name.toLowerCase();
  if (lower === "done" || lower === "closed" || lower === "resolved") return "done";
  if (lower === "blocked" || lower === "on hold") return "blocked";
  if (
    lower === "to do" ||
    lower === "todo" ||
    lower === "open" ||
    lower === "backlog" ||
    lower === "selected for development"
  )
    return "todo";
  if (
    lower === "in progress" ||
    lower === "in review" ||
    lower === "in development" ||
    lower === "code review"
  )
    return "in_progress";
  return "unknown";
}

interface RawIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    updated?: string;
    assignee?: { displayName?: string } | null;
  };
}

interface RawSearchResponse {
  issues?: RawIssue[];
  total?: number;
}

function toTicket(issue: RawIssue): JiraTicket {
  const statusName = issue.fields?.status?.name ?? "Unknown";
  const host = config.JIRA_HOST || "warp-lab.atlassian.net";
  return {
    key: issue.key,
    summary: issue.fields?.summary ?? issue.key,
    status: classifyStatus(statusName),
    status_name: statusName,
    url: `https://${host}/browse/${issue.key}`,
    updated: issue.fields?.updated ?? null,
    assignee: issue.fields?.assignee?.displayName ?? null,
  };
}

/** WARP-229..278 ordered by ticket number (the chain order). */
export async function getCompliancePhaseChain(
  opts: JiraRequestOpts = {},
): Promise<JiraTicket[]> {
  return withCache(
    "chain",
    async () => {
      if (!isConfigured()) return [];
      const keys = Array.from({ length: CHAIN_END - CHAIN_START + 1 }, (_, i) =>
        `WARP-${CHAIN_START + i}`,
      );
      // JQL `key in (...)` is the cheapest single call. Atlassian search
      // caps at 100 results which more than covers our 50 tickets.
      const jql = `key in (${keys.join(",")})`;
      const params = new URLSearchParams({
        jql,
        fields: "summary,status,updated,assignee",
        maxResults: "100",
      });
      const data = await jiraFetch<RawSearchResponse>(
        `/rest/api/3/search?${params.toString()}`,
      );
      if (!data?.issues) return [];

      const byKey = new Map<string, RawIssue>();
      for (const issue of data.issues) byKey.set(issue.key, issue);

      // Walk the canonical key list so the result is always in chain order
      // even when Jira returns issues out-of-order.
      const out: JiraTicket[] = [];
      for (const key of keys) {
        const issue = byKey.get(key);
        if (issue) {
          out.push(toTicket(issue));
        } else {
          // Ticket exists in the spec but not in Jira (or not visible to
          // the API user). Surface as unknown rather than silently
          // dropping — the dashboard shows "unknown" cells distinctly.
          out.push({
            key,
            summary: "(not found in Jira)",
            status: "unknown",
            status_name: "Unknown",
            url: `https://${config.JIRA_HOST}/browse/${key}`,
            updated: null,
            assignee: null,
          });
        }
      }
      return out;
    },
    opts,
  );
}

/** Open tickets across the WARP project, newest update first. */
export async function getInFlightTickets(
  opts: JiraRequestOpts = {},
): Promise<JiraTicket[]> {
  return withCache(
    "in_flight",
    async () => {
      if (!isConfigured()) return [];
      const jql = `project = WARP AND statusCategory != Done ORDER BY updated DESC`;
      const params = new URLSearchParams({
        jql,
        fields: "summary,status,updated,assignee",
        maxResults: "25",
      });
      const data = await jiraFetch<RawSearchResponse>(
        `/rest/api/3/search?${params.toString()}`,
      );
      if (!data?.issues) return [];
      return data.issues.map(toTicket);
    },
    opts,
  );
}

export async function getJiraSnapshot(
  opts: JiraRequestOpts = {},
): Promise<JiraSnapshot> {
  const configured = isConfigured();
  const [chain, inFlight] = await Promise.all([
    getCompliancePhaseChain(opts),
    getInFlightTickets(opts),
  ]);

  let done = 0;
  let in_progress = 0;
  let blocked = 0;
  let not_started = 0;
  for (const t of chain) {
    if (t.status === "done") done++;
    else if (t.status === "in_progress") in_progress++;
    else if (t.status === "blocked") blocked++;
    else not_started++;
  }
  const total = chain.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return {
    configured,
    chain,
    in_flight: inFlight,
    chain_progress: { total, done, in_progress, blocked, not_started, percent },
  };
}
