"use client";
import { useEffect, useRef, useState } from "react";
import type { ArtifactMedia } from "@droplet/shared-types";
import { MediaCaption, MediaFrame, safeSrc } from "./shared";

export const ARTIFACT_MAX_BYTES = 192 * 1024;
const UNSUPPORTED = "This browser cannot isolate interactive previews. Update your browser to preview this file.";

async function readArtifact(response: Response): Promise<string> {
  if (!response.ok) throw new Error("Preview could not be loaded.");
  if (Number(response.headers.get("content-length")) > ARTIFACT_MAX_BYTES) throw new Error("Preview is too large.");
  if (!response.body) throw new Error("Preview is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > ARTIFACT_MAX_BYTES) throw new Error("Preview is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function ArtifactMediaCard({ media }: { media: ArtifactMedia }) {
  const url = safeSrc(media.downloadUrl);
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const activeController = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open || !url || !nonce) return;
    const controller = new AbortController();
    activeController.current = controller;
    let cancelled = false;
    let ready = false;
    setLoaded(false);
    const timer = setTimeout(() => { controller.abort(); if (!cancelled) setError(UNSUPPORTED); }, 15_000);
    const receive = (event: MessageEvent) => {
      // Descendant/generated frames cannot impersonate the trusted wrapper.
      if (event.source !== frame.current?.contentWindow || event.origin !== "null" || event.data?.nonce !== nonce || controller.signal.aborted) return;
      if (event.data.type === "droplet-artifact-ready" && !ready) {
        ready = true;
        if (event.data.supported !== true) { clearTimeout(timer); setError(UNSUPPORTED); return; }
        // Private bytes are fetched and transferred only after the trusted
        // HTTP host proves its connection policy active in this browser.
        void fetch(url, { credentials: "same-origin", signal: controller.signal })
          .then(readArtifact)
          .then((content) => { if (!controller.signal.aborted) frame.current?.contentWindow?.postMessage({ type: "droplet-artifact-content", nonce, content }, "*"); })
          .catch(() => { if (!cancelled) { clearTimeout(timer); setError("Preview could not be loaded."); } });
      } else if (ready && event.data.type === "droplet-artifact-loaded") {
        clearTimeout(timer); setLoaded(true);
      }
    };
    window.addEventListener("message", receive);
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); activeController.current = null; window.removeEventListener("message", receive); };
  }, [open, url, nonce]);
  async function beginProbe() {
    const controller = activeController.current;
    if (!controller || controller.signal.aborted || !nonce) return;
    try {
      const result = await fetch("/api/artifact-preview-probe", { credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal });
      if (result.status !== 204) throw new Error("Unavailable preview host");
      if (!controller.signal.aborted) frame.current?.contentWindow?.postMessage({ type: "droplet-artifact-init", nonce }, "*");
    } catch { if (!controller.signal.aborted) setError(UNSUPPORTED); }
  }
  function togglePreview() {
    if (open) { setOpen(false); return; }
    setLoaded(false); setError(null);
    if (typeof crypto.randomUUID !== "function") { setNonce(null); setError(UNSUPPORTED); }
    else setNonce(crypto.randomUUID());
    setOpen(true);
  }
  if (!url) return null;
  return (
    <MediaFrame testId="artifact-media-card" label={`Artifact, ${media.name}`}>
      <MediaCaption>
        <span className="min-w-0 flex-1 truncate">{media.name}</span>
        <button type="button" onClick={togglePreview} className="text-[var(--brand)]">{open ? "Close preview" : "Preview"}</button>
        <a href={url} download={media.name} className="text-[var(--brand)]">Download</a>
      </MediaCaption>
      {open && error && <p role="alert" className="p-3 text-sm">{error}</p>}
      {open && !loaded && !error && <p role="status" className="p-3 text-sm">Checking preview isolation…</p>}
      {open && nonce && !error && <iframe key={`${nonce}:${url}`} ref={frame} title={media.name} src={`/api/artifact-preview#${nonce}`} onLoad={() => { void beginProbe(); }} sandbox="allow-scripts" referrerPolicy="no-referrer" className="w-full h-[480px] border-0 bg-white" />}
    </MediaFrame>
  );
}


