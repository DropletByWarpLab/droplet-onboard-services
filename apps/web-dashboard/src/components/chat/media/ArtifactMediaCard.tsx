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
  const beginProbe = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (!open || !url || !nonce) return;
    const controller = new AbortController();
    const host = frame.current?.contentWindow;
    let cancelled = false;
    let ready = false;
    let started = false;
    let channel: MessageChannel | null = null;
    const closeChannel = () => { channel?.port1.close(); channel?.port2.close(); channel = null; };
    setLoaded(false);
    const fail = (message: string) => { clearTimeout(timer); controller.abort(); closeChannel(); if (!cancelled) setError(message); };
    const timer = setTimeout(() => fail(UNSUPPORTED), 15_000);
    const receive = (event: MessageEvent) => {
      // This handler belongs only to the transferred channel endpoint. Window
      // messages from generated descendants cannot impersonate the wrapper.
      if (!channel || event.data?.nonce !== nonce || controller.signal.aborted || cancelled) return;
      if (event.data.type === "droplet-artifact-ready" && !ready) {
        ready = true;
        if (event.data.supported !== true) { fail(UNSUPPORTED); return; }
        // Private bytes are fetched and transferred only after the trusted
        // HTTP host proves its connection policy active in this browser.
        const port = channel.port1;
        void fetch(url, { credentials: "same-origin", signal: controller.signal })
          .then(readArtifact)
          .then((content) => { if (!cancelled && !controller.signal.aborted && channel?.port1 === port) port.postMessage({ type: "droplet-artifact-content", nonce, content }); })
          .catch(() => { if (!cancelled && !controller.signal.aborted) fail("Preview could not be loaded."); });
      } else if (ready && event.data.type === "droplet-artifact-loaded") {
        clearTimeout(timer); setLoaded(true);
      }
    };
    beginProbe.current = async () => {
      // Never rebind after a reload/navigation: a MessagePort is tied to the
      // original document, whereas a WindowProxy can point at its replacement.
      if (started) { fail(UNSUPPORTED); return; }
      started = true;
      if (!host || frame.current?.contentWindow !== host || typeof MessageChannel !== "function") { fail(UNSUPPORTED); return; }
      try {
        const result = await fetch("/api/artifact-preview-probe", { credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal });
        if (result.status !== 204) throw new Error("Unavailable preview host");
        if (cancelled || controller.signal.aborted || frame.current?.contentWindow !== host) return;
        channel = new MessageChannel();
        channel.port1.onmessage = receive;
        channel.port1.start();
        // Opaque sandbox origins cannot be named by targetOrigin. This one
        // public bootstrap transfers a capability; all private bytes use its
        // bound MessagePort only after the trusted wrapper proves isolation.
        // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
        host.postMessage({ type: "droplet-artifact-init", nonce }, "*", [channel.port2]);
      } catch { if (!cancelled && !controller.signal.aborted) fail(UNSUPPORTED); }
    };
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); closeChannel(); beginProbe.current = null; };
  }, [open, url, nonce]);
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
      {open && nonce && !error && <iframe key={`${nonce}:${url}`} ref={frame} title={media.name} src={`/api/artifact-preview#${nonce}`} onLoad={() => { void beginProbe.current?.(); }} sandbox="allow-scripts" referrerPolicy="no-referrer" className="w-full h-[480px] border-0 bg-white" />}
    </MediaFrame>
  );
}
