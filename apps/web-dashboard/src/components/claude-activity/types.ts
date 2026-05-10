/**
 * WARP-279 — Frontend types for /admin/claude-activity.
 *
 * These mirror the orchestrator response shape from
 * apps/orchestrator/src/routes/admin-claude-activity.ts. Kept as a thin
 * file with no runtime imports so widgets can import just the types.
 */

export interface NowState {
  task: string;
  ticket: string | null;
  branch: string | null;
  started_at: string | null;
  blocked_on: string | null;
}

export interface DecisionEntry {
  ts: string;
  summary: string;
  rationale: string;
}

export interface RecentActionEntry {
  ts: string;
  kind: string;
  ref: string | null;
  summary: string;
}

export interface GitHubCommit {
  sha: string;
  short_sha: string;
  message: string;
  author: string | null;
  url: string;
  ts: string;
}

export type CIBadge = "success" | "failure" | "pending" | "neutral" | "unknown";

export interface GitHubPR {
  number: number;
  title: string;
  state: "open";
  draft: boolean;
  user: string | null;
  url: string;
  head_sha: string;
  branch: string;
  ci_state: CIBadge;
  updated_at: string;
}

export interface GitHubCIRun {
  id: number;
  workflow_name: string;
  branch: string | null;
  event: string;
  status: "queued" | "in_progress" | "completed" | "unknown";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | null;
  url: string;
  updated_at: string;
}

export interface GitHubSnapshot {
  commits: GitHubCommit[];
  prs: GitHubPR[];
  ci_runs: GitHubCIRun[];
}

export type TicketStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "done"
  | "unknown";

export interface JiraTicket {
  key: string;
  summary: string;
  status: TicketStatus;
  status_name: string;
  url: string;
  updated: string | null;
  assignee: string | null;
}

export interface JiraSnapshot {
  configured: boolean;
  chain: JiraTicket[];
  in_flight: JiraTicket[];
  chain_progress: {
    total: number;
    done: number;
    in_progress: number;
    blocked: number;
    not_started: number;
    percent: number;
  };
}

export type ComplianceStatus =
  | "done"
  | "in_progress"
  | "not_started"
  | "blocked"
  | "deferred"
  | "na"
  | "unknown";

export interface WorkstreamRow {
  workstream: string;
  total: number;
  done: number;
  in_progress: number;
  not_started: number;
}

export interface QueueRow {
  index: number;
  ticket: string;
  title: string;
  workstream: string;
  status: ComplianceStatus;
}

export interface MilestoneRow {
  milestone: string;
  trigger: string;
  status: ComplianceStatus;
}

export interface ComplianceSnapshot {
  source: string;
  source_mtime_ms: number | null;
  generated_at: string;
  workstreams: WorkstreamRow[];
  queue: QueueRow[];
  milestones: MilestoneRow[];
  parsed: boolean;
}

export interface ClaudeActivityResponse {
  now: NowState;
  decisions: DecisionEntry[];
  recent_actions: RecentActionEntry[];
  github: GitHubSnapshot | null;
  jira: JiraSnapshot | null;
  compliance: ComplianceSnapshot | null;
  generated_at: string;
}

/**
 * Combined item shape for the activity feed (commits + PRs + Jira moves +
 * CI runs interleaved by timestamp).
 */
export interface FeedItem {
  ts: string;
  kind: "commit" | "pr" | "ci" | "ticket" | "decision" | "action";
  title: string;
  subtitle?: string;
  url?: string;
  badge?: string;
  badge_tone?: "ok" | "warning" | "error" | "info" | "neutral";
}
