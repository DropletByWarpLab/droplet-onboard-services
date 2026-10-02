"use client";

/**
 * WARP-1827 — drive one catalog model download and read its NDJSON progress.
 *
 * POST /api/models/:name/pull answers with a streaming NDJSON body (the
 * box's own pull progress, proxied); this hook reads it with
 * `response.body.getReader()` — event-driven, no polling — and derives:
 *   - `progressPct` from `completed/total` when BOTH are present on a line
 *     (otherwise null → the bar renders indeterminate; a made-up % would be
 *     a fabricated number),
 *   - `progressStatus` from the stream's own words ("pulling manifest",
 *     "verifying sha256 digest" …),
 *   - a terminal outcome: a `{"status":"success"}` line refreshes via
 *     `onSuccess`; an `{"error":…}` line or a non-2xx becomes an honest
 *     inline error. The 409 disk preflight's `detail` surfaces VERBATIM —
 *     it names real gigabytes and the user deserves the real sentence.
 *   - WARP-3048: every message is a STRING by the time it reaches state. The
 *     inference-manager's raw 409 nests `{error, needed_gb, free_gb}` under
 *     `detail`, and rendering that object as a React child took the whole
 *     /models page down. See `pullErrorMessage`.
 *
 * ONE pull at a time: the box downloads sequentially anyway, and two
 * progress streams racing one page would be noise. Lines that don't parse
 * are ignored (never the reason a download "fails").
 */

import { useCallback, useRef, useState } from "react";
import { startModelPull } from "../api";

export interface ModelPullError {
  /** The model whose card should show the message. */
  model: string;
  message: string;
}

interface ModelPullState {
  /** Name of the model currently downloading, or null when idle. */
  pulling: string | null;
  /** 0–100 when the stream reports completed/total; null → indeterminate. */
  progressPct: number | null;
  /** The stream's own latest status line. */
  progressStatus: string | null;
  /** Terminal failure of the LAST attempt, or null. Cleared on a new start. */
  error: ModelPullError | null;
}

/** A non-blank string, or null. */
function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * WARP-3048 — word a refused download (contract C2 of the model-hotswap
 * fix) and coerce ANY body shape to a string.
 *
 * `insufficient_disk` with real numbers gets the models brief's §7.3
 * sentence; otherwise a string `detail` (the orchestrator's or the
 * runtime's own reason) passes through verbatim, as before. A `detail`
 * that is an object — the inference-manager's raw 409 — is read for its
 * fields instead of being handed to React.
 */
function pullErrorMessage(status: number, body: unknown): string {
  const fallback = `Couldn’t start the download (${status}). Try again in a moment.`;
  if (!body || typeof body !== "object") return fallback;
  const b = body as Record<string, unknown>;
  const nested =
    b.detail && typeof b.detail === "object"
      ? (b.detail as Record<string, unknown>)
      : null;
  const code = text(b.error) ?? text(nested?.error);
  const needed = num(b.needed_gb) ?? num(nested?.needed_gb);
  const free = num(b.free_gb) ?? num(nested?.free_gb);
  if (code === "insufficient_disk" && needed != null && free != null) {
    return `Not enough space — this model needs ${needed} GB and this Droplet has ${free} GB free.`;
  }
  const detail =
    text(b.detail) ?? text(nested?.detail) ?? text(nested?.message);
  if (detail) return detail;
  switch (code) {
    case "insufficient_disk":
      return "Not enough free space on this Droplet for this model.";
    case "already_pulled":
      return "This model is already on your Droplet.";
    case "catalog_unconfirmed":
      return "Your Droplet couldn’t confirm which models it already has, so the download didn’t start. Try again in a moment.";
    case "pull_failed":
      return "The download couldn’t be started. Try again in a moment.";
    default:
      return code ?? fallback;
  }
}

/** A mid-stream `{"error": …}` line, as a string whatever its shape. */
function streamErrorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    const inner = text(e.message) ?? text(e.error) ?? text(e.detail);
    if (inner) return inner;
  }
  return (
    text(err) ??
    "The download stopped partway. Nothing was changed — try again when your connection is steady."
  );
}

const IDLE: ModelPullState = {
  pulling: null,
  progressPct: null,
  progressStatus: null,
  error: null,
};

export function useModelPull(onSuccess?: () => void) {
  const [state, setState] = useState<ModelPullState>(IDLE);
  // Concurrency guard lives in a ref: state updates are async, so two rapid
  // clicks could both read `pulling: null` before either render lands.
  const busyRef = useRef(false);

  const startPull = useCallback(
    async (name: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setState({
        pulling: name,
        progressPct: null,
        progressStatus: "Starting download…",
        error: null,
      });
      try {
        const res = await startModelPull(name);
        if (!res.ok) {
          // Surface the orchestrator's typed error; the 409 preflight's
          // `detail` (real gigabytes) passes through verbatim.
          let body: unknown = null;
          try {
            body = await res.json();
          } catch {
            /* non-JSON error body — keep the status-code message */
          }
          const message = pullErrorMessage(res.status, body);
          setState({ ...IDLE, error: { model: name, message } });
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          setState({
            ...IDLE,
            error: {
              model: name,
              message: "The download stream couldn’t be read. Try again.",
            },
          });
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let sawSuccess = false;
        let errorLine: string | null = null;

        const handleLine = (line: string): void => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            return; // tolerate — an unparseable line is not an outcome
          }
          if (parsed.error != null) {
            errorLine = streamErrorMessage(parsed.error);
            return;
          }
          if (parsed.status === "success") {
            sawSuccess = true;
            return;
          }
          const status =
            typeof parsed.status === "string" ? parsed.status : null;
          const completed =
            typeof parsed.completed === "number" ? parsed.completed : null;
          const total = typeof parsed.total === "number" ? parsed.total : null;
          const pct =
            completed != null && total != null && total > 0
              ? Math.min(100, Math.round((completed / total) * 100))
              : null;
          setState((prev) =>
            prev.pulling === name
              ? {
                  ...prev,
                  progressStatus: status ?? prev.progressStatus,
                  // A phase line without totals goes back to indeterminate:
                  // the new phase's progress is genuinely unknown.
                  progressPct: pct,
                }
              : prev,
          );
        };

        // Event-driven stream read (the reader resolves as chunks ARRIVE —
        // this is not a poll loop).
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            handleLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        }
        if (buffer) handleLine(buffer);

        if (errorLine) {
          setState({ ...IDLE, error: { model: name, message: errorLine } });
        } else if (sawSuccess) {
          setState(IDLE);
          onSuccess?.();
        } else {
          // The stream closed with no terminal line — say so rather than
          // guessing an outcome either way.
          setState({
            ...IDLE,
            error: {
              model: name,
              message:
                "The download ended before it finished. Nothing was changed — try again.",
            },
          });
        }
      } catch {
        setState({
          ...IDLE,
          error: {
            model: name,
            message:
              "Couldn’t reach your Droplet to download the model. Try again in a moment.",
          },
        });
      } finally {
        busyRef.current = false;
      }
    },
    [onSuccess],
  );

  return { ...state, startPull };
}
