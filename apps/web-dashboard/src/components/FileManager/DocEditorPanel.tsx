"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, FileText, Eye, RefreshCw, FileWarning } from "lucide-react";
import { getEditorSession } from "@/lib/api";
import type { FileEntryInfo, DocEditorSession } from "@/lib/types";

interface DocEditorPanelProps {
  file: FileEntryInfo;
  onClose: () => void;
}

type PanelState =
  | { kind: "loading" }
  | { kind: "ready"; session: DocEditorSession }
  | { kind: "unavailable" }
  | { kind: "error" };

/**
 * WARP-882 / WS-4 — Droplet-chrome iframe that hosts the OnlyOffice editor.
 *
 * The session (editorUrl + server-decided mode) is minted by the orchestrator;
 * this panel never asks for edit vs view. States: loading · ready (iframe,
 * with a "View only" badge when the server returned mode=view) · unavailable
 * (engine 503 → calm copy, no raw error) · error (retry). Closes on Escape or
 * the close control. Motion is restrained per the design contract — a single
 * opacity transition on the iframe reveal, disabled under reduced-motion.
 */
export function DocEditorPanel({ file, onClose }: DocEditorPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [frameLoaded, setFrameLoaded] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    setFrameLoaded(false);
    try {
      const session = await getEditorSession(file.path);
      setState({ kind: "ready", session });
    } catch (err) {
      // A 503 / DOCS_UNAVAILABLE is a calm "editing unavailable" state, not an
      // error the user did anything wrong to cause.
      const msg = err instanceof Error ? err.message : String(err);
      if (/503|DOCS_UNAVAILABLE/i.test(msg)) {
        setState({ kind: "unavailable" });
      } else {
        setState({ kind: "error" });
      }
    }
  }, [file.path]);

  useEffect(() => {
    void load();
  }, [load]);

  // Close on Escape — same affordance as PreviewPane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isView = state.kind === "ready" && state.session.mode === "view";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="bg-surface-primary rounded-lg w-full max-w-6xl h-[92vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-separator flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileText size={16} className="text-label-tertiary flex-shrink-0" />
            <h3 className="type-headline text-label-primary truncate">{file.name}</h3>
            {isView && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-secondary text-label-secondary type-caption-1 flex-shrink-0">
                <Eye size={11} />
                View only
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2.5 rounded-full text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
            aria-label="Close editor"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 relative bg-surface-secondary">
          {state.kind === "loading" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-label-tertiary">
              <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin motion-reduce:animate-none" />
              <p className="type-subheadline">Preparing the editor…</p>
            </div>
          )}

          {state.kind === "ready" && (
            <iframe
              title={`${file.name} editor`}
              src={state.session.editorUrl}
              className="w-full h-full border-0 transition-opacity duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none"
              style={{ opacity: frameLoaded ? 1 : 0 }}
              onLoad={() => setFrameLoaded(true)}
              // The editor needs same-origin script + forms; co-authoring rides
              // the gateway's /docs/ WebSocket upgrade.
              allow="clipboard-read; clipboard-write"
            />
          )}

          {state.kind === "ready" && !frameLoaded && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin motion-reduce:animate-none" />
            </div>
          )}

          {state.kind === "unavailable" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center text-label-tertiary">
              <FileWarning size={32} className="text-label-quaternary" />
              <p className="type-subheadline text-label-secondary">
                This document can&apos;t be edited right now
              </p>
              <p className="type-footnote text-label-tertiary max-w-sm">
                The document editor isn&apos;t available on this Droplet. You can still
                download the file to edit it on your computer.
              </p>
            </div>
          )}

          {state.kind === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center text-label-tertiary">
              <FileWarning size={32} className="text-label-quaternary" />
              <p className="type-subheadline text-label-secondary">
                Couldn&apos;t open the editor
              </p>
              <button
                onClick={() => void load()}
                className="dp-btn-primary type-subheadline inline-flex items-center gap-1.5"
              >
                <RefreshCw size={14} />
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
