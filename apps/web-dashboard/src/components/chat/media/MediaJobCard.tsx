"use client";
import { useEffect, useState } from "react";
import { parseChatMedia, type MediaJobMedia, type FileMedia } from "@droplet/shared-types";
import { FileMediaCard } from "./FileMediaCard";

/** Polls owner-authorized job metadata; descriptor URLs cannot select another API. */
export function MediaJobCard({ media }: { media: MediaJobMedia }) {
  const [status, setStatus] = useState("running");
  const [error, setError] = useState("");
  const [file, setFile] = useState<FileMedia | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch(media.statusUrl, { credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), cache: "no-store" });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Sign in again to view this result." : response.status === 404 ? "This job is no longer available." : "Cannot check this job right now.");
        const body = await response.json();
        if (body.id !== media.jobId || !["running", "saving", "succeeded", "failed", "cancelled"].includes(body.status)) throw new Error("Invalid job status.");
        if (controller.signal.aborted) return;
        setStatus(body.status); setError(typeof body.error === "string" ? body.error : "");
        if (body.status === "succeeded") {
          const result = parseChatMedia(body).find((m): m is FileMedia => m.kind === "file");
          if (!result) throw new Error("The job finished without saved-file metadata.");
          setFile(result);
        } else if (body.status === "running" || body.status === "saving") timer = setTimeout(() => void poll(), 3000);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Cannot check this job right now."); }
    }
    setError(""); void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [media.jobId, media.statusUrl, retry]);
  async function cancel() {
    try {
      const response = await fetch(`${media.statusUrl}/cancel`, { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || "Could not cancel this job."); }
      setRetry((n) => n + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel this job."); }
  }
  if (file) return <FileMediaCard media={file} />;
  return <div className="rounded-lg border p-3 max-w-md" aria-live="polite" data-testid="media-job-card">
    <p>{status === "cancelled" ? "Media creation cancelled." : status === "failed" ? "Media creation failed." : status === "saving" ? "Saving your media…" : "Creating your media…"}</p>
    {error && <p role="alert" className="text-sm mt-1">{error}</p>}
    {error && <button type="button" onClick={() => setRetry((n) => n + 1)} className="underline text-sm">Check again</button>}
    {status === "running" && <button type="button" onClick={() => void cancel()} className="underline text-sm ml-2">Cancel</button>}
  </div>;
}
