/**
 * WARP-279 — GitHub adapter for the meta-observability dashboard.
 *
 * Reads recent commits, open PRs, and CI workflow runs from the GitHub
 * REST API. Wraps each call in a 60s Redis cache so the polling dashboard
 * doesn't hammer GitHub (the unauthenticated rate limit is 60 req/h, and
 * even with a token the dashboard would burn through quota fast at 30s
 * polling × 3 calls).
 *
 * Deviation note: WARP-279 originally specified `@octokit/rest`. That
 * package is not in this repo's dependencies (and the orchestrator already
 * has a global `fetch`), so we use the REST API directly. Adding a new
 * dep just for this dashboard would be more code, not less.
 *
 * Auth: `GITHUB_TOKEN` env var. Falls back to unauthenticated requests
 * (much lower rate limit) so dev laptops without a token can still hit
 * /admin/claude-activity. Public-repo reads work fine without a token.
 *
 * Failure modes: when GitHub is slow, errors, or rate-limits us, each
 * function logs and returns an empty array. The dashboard renders a
 * "GitHub unavailable" banner over the panel rather than going blank or
 * 500-ing; partial data is more useful than nothing.
 */

import { cacheGet, cacheSet } from "../cache.service.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("claude-activity:github");

// Hard-coded for our own repo. If we ever multi-tenant the dashboard
// these become env vars; until then a constant beats one more env knob.
const OWNER = process.env.GITHUB_REPO_OWNER || "DropletByWarpLab";
const REPO = process.env.GITHUB_REPO_NAME || "droplet-onboard-services";

const CACHE_TTL_SECONDS = 60;
const CACHE_PREFIX = "claude-activity:github:";
const REQUEST_TIMEOUT_MS = 5000;

export interface GitHubCommit {
  sha: string;
  short_sha: string;
  message: string;
  author: string | null;
  url: string;
  ts: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: "open";
  draft: boolean;
  user: string | null;
  url: string;
  head_sha: string;
  branch: string;
  ci_state: "success" | "failure" | "pending" | "neutral" | "unknown";
  updated_at: string;
}

export interface GitHubCIRun {
  id: number;
  workflow_name: string;
  branch: string | null;
  event: string;
  status: "queued" | "in_progress" | "completed" | "unknown";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  url: string;
  updated_at: string;
}

export interface GitHubSnapshot {
  commits: GitHubCommit[];
  prs: GitHubPR[];
  ci_runs: GitHubCIRun[];
}

interface GhRequestOpts {
  /** Bypass the cache (used by tests). */
  bypassCache?: boolean;
}

async function ghFetch<T>(pathname: string): Promise<T | null> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `${OWNER}-orchestrator-warp-279`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Hand-rolled timeout — global fetch on Node 20 supports AbortSignal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `https://api.github.com${pathname}`;
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) {
      logger.warn(
        { status: resp.status, url },
        "github request failed",
      );
      return null;
    }
    return (await resp.json()) as T;
  } catch (err) {
    logger.warn({ err, pathname }, "github request errored");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cache wrapper. Returns the cached value if present; otherwise runs the
 * loader and stores the result for 60s. Cache failures (Redis down,
 * malformed JSON, etc.) fall through to the live call without crashing.
 */
async function withCache<T>(
  key: string,
  loader: () => Promise<T>,
  opts: GhRequestOpts = {},
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

/** Recent commits on the default branch. */
export async function getRecentCommits(
  opts: GhRequestOpts = {},
): Promise<GitHubCommit[]> {
  return withCache(
    "commits",
    async () => {
      const items = await ghFetch<RawCommit[]>(
        `/repos/${OWNER}/${REPO}/commits?per_page=25`,
      );
      if (!items) return [];
      return items.map((c) => ({
        sha: c.sha,
        short_sha: c.sha.slice(0, 7),
        message: (c.commit?.message ?? "").split("\n")[0]!.slice(0, 200),
        author: c.author?.login ?? c.commit?.author?.name ?? null,
        url: c.html_url,
        ts: c.commit?.author?.date ?? c.commit?.committer?.date ?? "",
      }));
    },
    opts,
  );
}

/** Open PRs with CI status badge derived from each PR's head ref. */
export async function getOpenPRs(
  opts: GhRequestOpts = {},
): Promise<GitHubPR[]> {
  return withCache(
    "prs",
    async () => {
      const prs = await ghFetch<RawPR[]>(
        `/repos/${OWNER}/${REPO}/pulls?state=open&per_page=25&sort=updated&direction=desc`,
      );
      if (!prs) return [];

      // For each PR fetch combined CI status. Sequential to keep it
      // simple — the cache absorbs the cost across polls and the open-PR
      // count is tiny (typically <10).
      const out: GitHubPR[] = [];
      for (const pr of prs) {
        const ci = await ghCombinedStatus(pr.head?.sha);
        out.push({
          number: pr.number,
          title: pr.title,
          state: "open",
          draft: pr.draft ?? false,
          user: pr.user?.login ?? null,
          url: pr.html_url,
          head_sha: pr.head?.sha ?? "",
          branch: pr.head?.ref ?? "",
          ci_state: ci,
          updated_at: pr.updated_at,
        });
      }
      return out;
    },
    opts,
  );
}

async function ghCombinedStatus(
  sha: string | undefined,
): Promise<GitHubPR["ci_state"]> {
  if (!sha) return "unknown";
  // Combined status covers commit-statuses; we additionally check
  // check-runs for Actions-only signals. Conservative reduction:
  // any failure → failure, else any pending → pending, else success.
  const combined = await ghFetch<RawCombinedStatus>(
    `/repos/${OWNER}/${REPO}/commits/${sha}/status`,
  );
  const checks = await ghFetch<RawCheckRuns>(
    `/repos/${OWNER}/${REPO}/commits/${sha}/check-runs`,
  );
  const allStates: string[] = [];
  if (combined?.statuses) for (const s of combined.statuses) allStates.push(s.state);
  if (checks?.check_runs) {
    for (const c of checks.check_runs) {
      if (c.status === "completed") {
        allStates.push(c.conclusion ?? "neutral");
      } else {
        allStates.push("pending");
      }
    }
  }
  if (allStates.some((s) => s === "failure" || s === "timed_out" || s === "action_required" || s === "cancelled"))
    return "failure";
  if (allStates.some((s) => s === "pending" || s === "queued" || s === "in_progress"))
    return "pending";
  if (allStates.some((s) => s === "success")) return "success";
  if (allStates.length > 0) return "neutral";
  return "unknown";
}

/** Latest run per workflow on the default branch. */
export async function getCIRuns(
  opts: GhRequestOpts = {},
): Promise<GitHubCIRun[]> {
  return withCache(
    "ci_runs",
    async () => {
      const wf = await ghFetch<RawWorkflows>(
        `/repos/${OWNER}/${REPO}/actions/workflows`,
      );
      if (!wf?.workflows) return [];

      // For each workflow, fetch its latest run. We cap at the 25 most
      // recently active to stay polite — every entry costs one extra
      // API call inside this 60s cache window.
      const limited = wf.workflows.slice(0, 25);
      const out: GitHubCIRun[] = [];
      for (const w of limited) {
        const runs = await ghFetch<RawWorkflowRuns>(
          `/repos/${OWNER}/${REPO}/actions/workflows/${w.id}/runs?per_page=1`,
        );
        const run = runs?.workflow_runs?.[0];
        if (!run) continue;
        out.push({
          id: run.id,
          workflow_name: w.name,
          branch: run.head_branch ?? null,
          event: run.event ?? "",
          status: (run.status as GitHubCIRun["status"]) ?? "unknown",
          conclusion: (run.conclusion as GitHubCIRun["conclusion"]) ?? null,
          url: run.html_url,
          updated_at: run.updated_at,
        });
      }
      return out;
    },
    opts,
  );
}

/**
 * One call that fetches everything for the dashboard. Each leaf is its own
 * cache entry so a 60s expiry on commits doesn't force a re-fetch of the
 * (much costlier) PR + CI lists.
 */
export async function getGitHubSnapshot(
  opts: GhRequestOpts = {},
): Promise<GitHubSnapshot> {
  const [commits, prs, ci_runs] = await Promise.all([
    getRecentCommits(opts),
    getOpenPRs(opts),
    getCIRuns(opts),
  ]);
  return { commits, prs, ci_runs };
}

// ── Raw shapes returned by the GitHub REST API (subset we use) ──

interface RawCommit {
  sha: string;
  html_url: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
  author?: { login?: string } | null;
}

interface RawPR {
  number: number;
  title: string;
  draft?: boolean;
  user?: { login?: string } | null;
  html_url: string;
  updated_at: string;
  head?: { sha?: string; ref?: string };
}

interface RawCombinedStatus {
  state?: string;
  statuses?: Array<{ state: string }>;
}

interface RawCheckRuns {
  check_runs?: Array<{ status?: string; conclusion?: string | null }>;
}

interface RawWorkflows {
  workflows?: Array<{ id: number; name: string }>;
}

interface RawWorkflowRuns {
  workflow_runs?: Array<{
    id: number;
    head_branch?: string;
    event?: string;
    status?: string;
    conclusion?: string | null;
    html_url: string;
    updated_at: string;
  }>;
}
