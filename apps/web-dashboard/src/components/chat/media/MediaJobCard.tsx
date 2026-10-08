"use client";
import { useEffect, useRef, useState } from "react";
import { parseChatMedia, type MediaJobMedia, type FileMedia } from "@droplet/shared-types";
import { useAuth } from "@/lib/auth";
import { FileMediaCard } from "./FileMediaCard";

/** Polls owner-authorized job metadata; descriptor URLs cannot select another API. */
export function MediaJobCard({ media }: { media: MediaJobMedia }) {
  const { user } = useAuth();
  const key = `${user?.id ?? ""}:${user?.role ?? ""}:${media.jobId}:${media.statusUrl}`;
  const latestKey = useRef(key);
  latestKey.current = key;
  const activeController = useRef<AbortController | null>(null);
  const [stateKey, setStateKey] = useState(key);
  const [status, setStatus] = useState("running");
  const [error, setError] = useState("");
  const [file, setFile] = useState<FileMedia | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    activeController.current = controller;
    const current = () => !controller.signal.aborted && latestKey.current === key;
    async function poll() {
      try {
        const response = await fetch(media.statusUrl, { credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), cache: "no-store" });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Sign in again to view this result." : response.status === 404 ? "This job is no longer available." : "Cannot check this job right now.");
        const body = await response.json();
        if (body.id !== media.jobId || !["running", "saving", "succeeded", "failed", "cancelled"].includes(body.status)) throw new Error("Invalid job status.");
        if (!current()) return;
        setStatus(body.status); setError(typeof body.error === "string" ? body.error : "");
        if (body.status === "succeeded") {
          const result = parseChatMedia(body).find((m): m is FileMedia => m.kind === "file");
          if (!result) throw new Error("The job finished without saved-file metadata.");
          setFile(result);
        } else if (body.status === "running" || body.status === "saving") timer = setTimeout(() => void poll(), 3000);
      } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "Cannot check this job right now."); }
    }
    setStateKey(key); setStatus("running"); setFile(null); setError("");
    if (user) void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [key, media.jobId, media.statusUrl, retry]);
  async function cancel() {
    const controller = activeController.current;
    if (!controller || controller.signal.aborted) return;
    const current = () => !controller.signal.aborted && latestKey.current === key && activeController.current === controller;
    try {
      const response = await fetch(`${media.statusUrl}/cancel`, { method: "POST", credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || "Could not cancel this job."); }
      if (current()) setRetry((n) => n + 1);
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "Could not cancel this job."); }
  }
  if (!user) return null;
  if (stateKey !== key) return <div role="status">Checking your media…</div>;
  if (file) return <FileMediaCard media={file} />;
  return <div className="rounded-lg border p-3 max-w-md" aria-live="polite" data-testid="media-job-card">
    <p>{status === "cancelled" ? "Media creation cancelled." : status === "failed" ? "Media creation failed." : status === "saving" ? "Saving your media…" : "Creating your media…"}</p>
    {error && <p role="alert" className="text-sm mt-1">{error}</p>}
    {error && <button type="button" onClick={() => setRetry((n) => n + 1)} className="underline text-sm">Check again</button>}
    {status === "running" && <button type="button" onClick={() => void cancel()} className="underline text-sm ml-2">Cancel</button>}
  </div>;
}
