"use client";

/**
 * Setup wizard — Project Management step (WARP-507).
 *
 * Per spec WARP-498. User names their first workspace + project; we
 * POST /api/pm/onboard and either render a "View your Inbox" link or
 * surface the failure with a retry affordance.
 *
 * Per ADR-002 home-user-supervision persona: copy stays plain-spoken,
 * explainer surfaces what the user can do here later. "Skip" lets the
 * user complete this from the dashboard later.
 */

import { useState } from "react";
import { ArrowRight, FolderKanban, Loader2 } from "lucide-react";

interface PmStepProps {
  /** Customer's business name from a prior wizard step — used as a default. */
  defaultWorkspaceName?: string;
  onNext: () => void;
  onSkip: () => void;
}

interface OnboardResponse {
  workspace: { id: string; slug: string; name: string };
  project: { id: string; name: string; identifier: string };
  url: string;
  /** WARP-860 — Plane CE's only auth is email+password; the orchestrator
   *  bootstraps the instance admin and hands the owner its credentials. */
  auth?: { email: string; password: string; signInUrl: string };
}

export function PmStep({
  defaultWorkspaceName = "",
  onNext,
  onSkip,
}: PmStepProps): JSX.Element {
  const [workspaceName, setWorkspaceName] = useState(defaultWorkspaceName);
  const [projectName, setProjectName] = useState("Inbox");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OnboardResponse | null>(null);

  async function submit() {
    if (!workspaceName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch("/api/pm/onboard", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_name: workspaceName.trim(),
          project_name: projectName.trim() || "Inbox",
        }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`/api/pm/onboard ${resp.status}: ${detail}`);
      }
      const data = (await resp.json()) as OnboardResponse;
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="flex flex-col gap-6 p-8">
        <div className="flex items-center gap-3">
          <FolderKanban className="h-6 w-6 text-accent" />
          <h1 className="type-title-3 text-label-primary">Projects ready</h1>
        </div>
        <p className="type-subheadline text-label-secondary">
          Your workspace <strong>{result.workspace.name}</strong> and project{" "}
          <strong>{result.project.name}</strong> are set up.
        </p>
        {result.auth && (
          <div className="dp-card !p-4 flex flex-col gap-2" data-testid="pm-credentials">
            <p className="type-subheadline font-medium text-label-primary">
              Your Projects sign-in
            </p>
            <p className="type-footnote text-label-secondary">
              The first time you open Projects, sign in with these — your
              browser stays signed in for a week at a time.
            </p>
            <dl className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <dt className="type-caption-1 text-label-tertiary w-16 shrink-0">Email</dt>
                <dd className="type-footnote text-label-primary font-mono break-all">
                  {result.auth.email}
                </dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="type-caption-1 text-label-tertiary w-16 shrink-0">Password</dt>
                <dd className="type-footnote text-label-primary font-mono break-all">
                  {result.auth.password}
                </dd>
              </div>
            </dl>
          </div>
        )}
        <div className="flex gap-3">
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="dp-btn-primary no-underline"
          >
            View {result.project.name} →
          </a>
          <button type="button" onClick={onNext} className="dp-btn-secondary">
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-center gap-3">
        <FolderKanban className="h-6 w-6 text-accent" />
        <h1 className="type-title-3 text-label-primary">Project Management</h1>
      </div>
      <p className="type-subheadline text-label-secondary">
        Keep your projects, tickets, and comments on this appliance rather than
        a third-party service. Name your first workspace and project to get
        started, or skip to set this up later from the dashboard.
      </p>

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="type-subheadline font-medium text-label-primary">Workspace name</span>
          <input
            type="text"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder="e.g. Acme Photography"
            maxLength={80}
            className="dp-input"
            data-testid="pm-workspace-name-input"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="type-subheadline font-medium text-label-primary">First project name</span>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Inbox"
            maxLength={80}
            className="dp-input"
            data-testid="pm-project-name-input"
          />
        </label>
      </div>

      {error && (
        <div
          className="rounded-lg border px-3 py-2 type-subheadline"
          style={{
            borderColor: "var(--color-system-red)",
            background: "rgba(255,59,48,0.08)",
            color: "var(--color-system-red)",
          }}
        >
          Couldn&apos;t set up the project — {error}. Try again, or skip and
          set up later.
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!workspaceName.trim() || submitting}
          className="dp-btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="pm-submit-btn"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Setting up…
            </>
          ) : (
            <>
              Create <ArrowRight className="h-4 w-4" />
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="dp-btn-secondary"
          data-testid="pm-skip-btn"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
