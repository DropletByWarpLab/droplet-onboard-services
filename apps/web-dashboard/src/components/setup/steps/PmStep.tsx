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
  onComplete: () => void;
  onSkip: () => void;
}

interface OnboardResponse {
  workspace: { id: string; slug: string; name: string };
  project: { id: string; name: string; identifier: string };
  url: string;
}

export function PmStep({
  defaultWorkspaceName = "",
  onComplete,
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
          <FolderKanban className="h-6 w-6 text-blue-600" />
          <h1 className="text-xl font-semibold">Projects ready</h1>
        </div>
        <p className="text-sm text-gray-700">
          Your workspace <strong>{result.workspace.name}</strong> and project{" "}
          <strong>{result.project.name}</strong> are set up.
        </p>
        <div className="flex gap-3">
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            View {result.project.name} →
          </a>
          <button
            type="button"
            onClick={onComplete}
            className="rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-300"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-center gap-3">
        <FolderKanban className="h-6 w-6 text-blue-600" />
        <h1 className="text-xl font-semibold">Project Management</h1>
      </div>
      <p className="text-sm text-gray-700">
        Droplet runs a self-hosted PM tool — Plane — so your projects, tickets,
        and comments stay on this appliance instead of going to a SaaS. Name
        your first workspace + project to get started, or skip to set this up
        later from the dashboard.
      </p>

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Workspace name</span>
          <input
            type="text"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder="e.g. Acme Photography"
            maxLength={80}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
            data-testid="pm-workspace-name-input"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">First project name</span>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Inbox"
            maxLength={80}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
            data-testid="pm-project-name-input"
          />
        </label>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          Couldn&apos;t set up the project — {error}. Try again, or skip and
          set up later.
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!workspaceName.trim() || submitting}
          className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-400"
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
          className="rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-300"
          data-testid="pm-skip-btn"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
