# Admin dashboards

LAN-only views surfaced to `owner` / `admin` roles in the web dashboard. Authenticated by the existing Nextcloud OCS cookie + JWT session; the orchestrator gates each backing endpoint server-side, the dashboard hides the nav link client-side. Both checks fail closed if the role hydrate misses.

## `/admin/claude-activity` — meta-observability

**What it shows.** A live view of what the AI engineer (Claude) is doing on this repo. Seven widgets in a responsive 3-column grid:

| Widget | Source | What it answers |
|---|---|---|
| **Claude now** | `.claude/session-state.json` `now` field | Current task, ticket, branch, started_at, blocked_on. Idle / working / blocked badge. |
| **Recent activity** | GitHub commits + PRs + CI runs + Jira in-flight + session-state `recent_actions` + decisions, interleaved | The last 25 things that moved, newest first. |
| **Open PRs** | GitHub `/pulls?state=open` + per-head-sha combined-status + check-runs reduction | Which PRs need attention and whether their CI is green. |
| **WARP-228 chain** | Jira `key in (WARP-229..WARP-278)` (with fallback to `docs/compliance-progress.md`) | Compliance ticket chain — done / in-progress / blocked / not-started + percent. |
| **Compliance workstreams** | `docs/compliance-progress.md` workstream-rollup table | Where the 50 chain tickets sit by workstream. |
| **Decisions log** | `.claude/session-state.json` `decisions` field (last 10) | Why Claude picked the path it did, with rationale. |
| **CI status** | GitHub Actions `/actions/workflows` + latest run per workflow | Are all workflows green? |

**Auth.**
- Server-side: `apps/orchestrator/src/routes/admin-claude-activity.ts` returns 403 unless `req.user.role` is `owner` or `admin`.
- Client-side: `apps/web-dashboard/src/components/Sidebar.tsx` only renders the **Activity** nav link when the cached user role is `owner` / `admin`. The page itself shows an "Admin access required" placeholder for any role that lands on the URL directly.

**Polling cadence.** 30 seconds. Each request sends `If-Modified-Since` with the previous response's `Last-Modified`; the orchestrator returns `304 Not Modified` when none of:
- session-state most-recent decision/action timestamp
- session-state `now.started_at`
- any GitHub commit / PR / CI updated_at
- any Jira chain / in-flight ticket updated
- `docs/compliance-progress.md` mtime

…have moved past the request's `If-Modified-Since`.

**Caching.**
- GitHub adapter — 60s Redis TTL on `claude-activity:github:{commits,prs,ci_runs}`. Cache failures (Redis down) fall through to live API + warn-log.
- Jira adapter — 60s Redis TTL on `claude-activity:jira:{chain,in_flight}`. Same fall-through behavior.
- Session-state + compliance-progress.md are read fresh every request; both are local file reads and cheap.

**Failure modes.** Each leaf has a "down" mode that doesn't take the dashboard with it:
- GitHub unreachable / rate-limited → `null` snapshot, panels render an "GitHub unavailable" hint.
- Jira unconfigured (any of `JIRA_HOST` / `JIRA_EMAIL` / `JIRA_API_TOKEN` empty) → `configured: false`, panels render "unconfigured" hint, the chain widget falls back to `docs/compliance-progress.md`.
- `.claude/session-state.json` missing or malformed → empty default, ClaudeNow panel shows "no active task" hint.
- `docs/compliance-progress.md` missing or unparseable → `parsed: false`, workstream + chain-fallback panels show diagnostic hint.

The endpoint itself never 500s; the dashboard always renders.

## Updating `.claude/session-state.json`

The file lives at the repo root, is gitignored (only `.claude/session-state.example.json` is tracked), and is rewritten by the AI engineer's runtime as it works. Schema is versioned (`v: 1`):

```json
{
  "v": 1,
  "now": {
    "task": "Building WARP-279 dashboard",
    "ticket": "WARP-279",
    "branch": "WARP-279",
    "started_at": "2026-05-10T18:00:00Z",
    "blocked_on": null
  },
  "decisions": [
    { "ts": "...", "summary": "...", "rationale": "..." }
  ],
  "recent_actions": [
    { "ts": "...", "kind": "commit", "ref": "abc123", "summary": "..." }
  ]
}
```

**Bounds.** `decisions` is FIFO-capped at 20, `recent_actions` at 50 — the writer is expected to evict oldest-first. The reader trims defensively in case a buggy writer overshoots.

**Schema-version policy.** The reader accepts only `v: 1`. Bumps need a coordinated change in `apps/orchestrator/src/services/claude-activity/session-state.ts` (raise `SCHEMA_VERSION`) and any external writer; otherwise the reader returns the empty default and logs a warning.

**Where the example lives.** `.claude/session-state.example.json` (committed). New writers should copy it as the starting shape.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `GITHUB_TOKEN` | empty | Optional fine-grained PAT scoped to this repo with `metadata: read`, `actions: read`, `pull-requests: read`, `contents: read`. Without one, calls go unauthenticated (60 req/h ceiling — fine for sandbox/dev). |
| `GITHUB_REPO_OWNER` | `DropletByWarpLab` | Override for forks. |
| `GITHUB_REPO_NAME` | `droplet-onboard-services` | Override for forks. |
| `JIRA_HOST` | `warp-lab.atlassian.net` | Bare cloud subdomain (no scheme). |
| `JIRA_EMAIL` | empty | Atlassian account email. |
| `JIRA_API_TOKEN` | empty | Generate at id.atlassian.com → Security → API tokens. |
| `CLAUDE_SESSION_STATE_PATH` | `<cwd>/.claude/session-state.json` | Override the file location (mostly for tests/fixtures). |
| `COMPLIANCE_PROGRESS_PATH` | `<cwd>/docs/compliance-progress.md` | Same — override the file location. |

## Future panels

This is the Tier 2 surface: data + Claude-now + decisions + compliance. Tier 3 candidates (not in WARP-279):
- Per-ticket time-budget burn-down ("we said this was 1 day; we're at 3").
- Cross-repo aggregator that pulls in `inference-engine` and `mobile-app` activity as separate lanes.
- Soft alerts on stuck tickets (no movement in N hours while still in-progress).

Open separate tickets and reuse the orchestrator endpoint shape rather than scope-creeping this one.
