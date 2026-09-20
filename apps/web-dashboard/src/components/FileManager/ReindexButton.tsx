"use client";

/**
 * WARP-287 — admin "re-index this file" trigger.
 *
 * Wires the file detail UI to `POST /api/admin/files/:id/reindex` on
 * the orchestrator. That endpoint enforces:
 *   - admin RBAC (403 for non-admins),
 *   - recent MFA (401 with `error: "mfa_required"` when the admin's
 *     last MFA challenge is older than the configured window),
 *   - an advisory lock so concurrent re-indexes of the same file
 *     can't trample each other (409 `index_in_progress`).
 *
 * The button surfaces each path inline:
 *   - mfa_required → bounce to /settings/mfa?returnTo=... so the user
 *     can re-auth without losing their place;
 *   - index_in_progress / 5xx → show the message next to the button;
 *   - 200 → show "Re-indexed N chunks" so the admin has confirmation
 *     the rewrite landed.
 */

import { useState, type JSX } from "react";
import { RefreshCw } from "lucide-react";
import { authFetch } from "@/lib/auth";

export interface ReindexButtonProps {
  /**
   * Opaque file identifier accepted by the file-indexer's
   * `POST /reindex/:fileId`. Today this is the Nextcloud file path
   * (the file manager's primary key); when the dashboard plumbs
   * `ncFileId` end-to-end this prop will switch to the numeric id
   * without the button having to change.
   */
  fileId: string;
}

type Status = "idle" | "running" | "mfa" | "done" | "error";

export function ReindexButton({ fileId }: ReindexButtonProps): JSX.Element {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string>("");

  async function onClick() {
    setStatus("running");
    setMessage("");
    try {
      const resp = await authFetch(
        `/api/admin/files/${encodeURIComponent(fileId)}/reindex`,
        { method: "POST" },
      );
      if (resp.status === 401) {
        const body = await resp.json().catch(() => ({} as Record<string, unknown>));
        if ((body as { error?: string }).error === "mfa_required") {
          setStatus("mfa");
          setMessage("Recent MFA required — redirecting…");
          window.location.href = `/settings/mfa?returnTo=${encodeURIComponent(
            window.location.pathname,
          )}`;
          return;
        }
      }
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({} as Record<string, unknown>));
        setStatus("error");
        setMessage(
          (body as { message?: string }).message ?? `re-index failed (${resp.status})`,
        );
        return;
      }
      const body = (await resp.json()) as { chunksWritten?: number };
      setStatus("done");
      setMessage(`Re-indexed ${body.chunksWritten ?? 0} chunks.`);
    } catch (err) {
      setStatus("error");
      setMessage((err as Error).message);
    }
  }

  const toneColor =
    status === "error"
      ? "var(--danger)"
      : status === "done"
        ? "var(--success)"
        : "var(--text-muted)";

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={status === "running"}
        className="p-1.5 rounded-full text-[color:var(--text-muted)] hover:text-[color:var(--brand)] hover:bg-[var(--hover)] transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        title={status === "running" ? "Re-indexing…" : "Re-index"}
        aria-label="Re-index file"
        data-testid="reindex-button"
      >
        <RefreshCw size={16} className={status === "running" ? "animate-spin" : ""} />
      </button>
      {message && (
        <span
          role={status === "error" ? "alert" : "status"}
          style={{ color: toneColor, fontSize: "11.5px" }}
        >
          {message}
        </span>
      )}
    </div>
  );
}
