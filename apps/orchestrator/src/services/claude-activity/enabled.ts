/**
 * WARP-3433 — is Warp Lab's engineering dashboard (/admin/claude-activity) on?
 *
 * One definition, read by the capability probe (admin-capabilities.ts) and by
 * the route itself, so the nav entry and the endpoint can never disagree.
 *
 * It needs BOTH halves:
 *   - the explicit developer flag DROPLET_DEV_ENGINEERING_DASHBOARD (default
 *     OFF; a customer box never sets it), and
 *   - at least one backing integration: a GitHub token, or a fully configured
 *     Jira (host + email + token).
 * A token's presence alone never turns the dashboard on.
 */
import { config } from "../../config.js";

/** Mirrors jira-adapter.ts isConfigured(). */
export function jiraConfigured(): boolean {
  return !!(config.JIRA_HOST && config.JIRA_EMAIL && config.JIRA_API_TOKEN);
}

/** A non-blank GITHUB_TOKEN (github-adapter.ts reads process.env directly). */
export function githubConfigured(): boolean {
  const t = process.env.GITHUB_TOKEN;
  return !!(t && t.trim().length > 0);
}

/** The `claudeActivity` capability. */
export function claudeActivityEnabled(): boolean {
  return (
    config.DROPLET_DEV_ENGINEERING_DASHBOARD &&
    (githubConfigured() || jiraConfigured())
  );
}
