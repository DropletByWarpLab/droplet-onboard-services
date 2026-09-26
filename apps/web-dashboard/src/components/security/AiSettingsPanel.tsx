"use client";

/**
 * WARP-2979 (ADR-059 P4 §8) — "Droplet's AI", on /security/settings: what
 * Droplet may do with links on its own, and whether it writes incident
 * summaries (on this Droplet only; PR-2 builds the writer).
 *
 * At manage (`useModuleLevel`, which fails closed): three radios for linking
 * and a switch for summaries, saved together with the version they were read
 * at (PUT /api/security/ai-settings). A 409 re-reads and says so in a banner
 * — the other person's choice is what's shown now (the P2b conflict pattern).
 * Below manage: the current choices as text, and who can change them. The
 * controls are never rendered and then refused.
 *
 * A failed read is an error with Retry, never the defaults: "Droplet links
 * cameras on its own" must not be shown when the box couldn't say.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { levelAtLeast, useModuleLevel } from "@/lib/hooks/useModuleGate";
import { useAiSettings } from "@/lib/hooks/useSecurity";
import type { SecurityAiLinking, SecurityAiSummaries } from "@/lib/types";

export const AI_COPY = {
  title: "Droplet's AI",
  sub: "What Droplet may do on its own with what its cameras see.",
  linkingLegend: "Linking cameras to areas",
  linking: {
    link_and_suggest: "Link cameras and locks on its own when it's sure, and suggest the rest",
    suggest_only: "Only suggest links",
    off: "Don't look for links",
  },
  linkingHelp: "A link Droplet makes on its own never sends an alert until someone keeps it.",
  summaries: "Write a short summary of each incident",
  summariesHelp:
    "Summaries are written by the AI model on this Droplet. Security events are never sent to a cloud AI model, even when cloud models are turned on for chat.",
  summariesOn: "Droplet writes a short summary of each incident.",
  summariesOff: "Droplet doesn't write incident summaries.",
  readOnly: "People who manage Security can change this.",
  save: "Save",
  saved: "Saved.",
  conflict: "Someone else changed this just now. What's shown now is their version.",
  loadError: "Droplet couldn't load these settings",
  retry: "Retry",
  loading: "Loading Droplet's AI settings",
} as const;

const LINKING_ORDER: readonly SecurityAiLinking[] = ["link_and_suggest", "suggest_only", "off"];

export function AiSettingsPanel() {
  const uid = useId();
  const level = useModuleLevel("security");
  const canManage = levelAtLeast(level, "manage");
  const api = useAiSettings();
  const { toast } = useToast();
  const settings = api.settings;

  const [linking, setLinking] = useState<SecurityAiLinking | null>(null);
  const [summaries, setSummaries] = useState<SecurityAiSummaries | null>(null);
  const [pending, setPending] = useState(false);
  // Review #2418: the in-flight guard itself — Save stays focusable (aria-disabled), so a second press is refused here.
  const pendingRef = useRef(false);
  const [conflict, setConflict] = useState(false);

  // The form follows every new version the box answers with (a save, a re-read after a conflict).
  useEffect(() => {
    if (!settings) return;
    setLinking(settings.linking);
    setSummaries(settings.summaries);
  }, [settings]);

  const dirty = settings !== null && (linking !== settings.linking || summaries !== settings.summaries);

  const save = async () => {
    if (!settings || !linking || !summaries || pendingRef.current || !dirty) return;
    pendingRef.current = true;
    setPending(true);
    setConflict(false);
    try {
      await api.save({ linking, summaries, expectedVersion: settings.version });
      toast(AI_COPY.saved, "success");
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === "VERSION_CONFLICT") {
        setConflict(true);
        void api.refresh();
      } else {
        toast(translateError(err, "security"), "error");
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  let body;
  if (!settings && api.error) {
    body = (
      <div className="empty" role="alert">
        <span className="eh">{AI_COPY.loadError}</span>
        <span style={{ maxWidth: "48ch" }}>{translateError(api.error, "security")}</span>
        <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => void api.refresh()}>
          <RefreshCw size={16} aria-hidden />
          {AI_COPY.retry}
        </button>
      </div>
    );
  } else if (!settings || !linking || !summaries) {
    body = (
      <div className="empty" aria-busy="true">
        <Loader2 size={20} className="animate-spin" aria-hidden />
        <span className="sr-only">{AI_COPY.loading}</span>
      </div>
    );
  } else if (!canManage) {
    body = (
      <div style={{ display: "grid", gap: 6 }} data-readonly>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{AI_COPY.linking[settings.linking]}</p>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>
          {settings.summaries === "on" ? AI_COPY.summariesOn : AI_COPY.summariesOff}
        </p>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)" }}>{AI_COPY.readOnly}</p>
      </div>
    );
  } else {
    body = (
      <div style={{ display: "grid", gap: 16 }}>
        {conflict && (
          <p role="status" className="badge warn" style={{ whiteSpace: "normal", margin: 0, maxWidth: "100%" }} data-conflict>
            {AI_COPY.conflict}
          </p>
        )}
        <fieldset style={{ margin: 0, padding: 0, border: 0, minWidth: 0, display: "grid", gap: 8 }}>
          <legend style={{ padding: 0, marginBottom: 6, fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
            {AI_COPY.linkingLegend}
          </legend>
          {LINKING_ORDER.map((value) => (
            <label key={value} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13.5, color: "var(--text)" }}>
              <input
                type="radio"
                name={`${uid}-linking`}
                value={value}
                checked={linking === value}
                onChange={() => setLinking(value)}
                style={{ width: 18, height: 18, marginTop: 1, flexShrink: 0, accentColor: "var(--brand)" }}
              />
              <span style={{ overflowWrap: "anywhere" }}>{AI_COPY.linking[value]}</span>
            </label>
          ))}
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)" }}>{AI_COPY.linkingHelp}</p>
        </fieldset>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <span style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <span id={`${uid}-summaries`} style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
              {AI_COPY.summaries}
            </span>
            <span id={`${uid}-summaries-help`} style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
              {AI_COPY.summariesHelp}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            className={`sw${summaries === "on" ? " on" : ""}`}
            aria-checked={summaries === "on"}
            aria-labelledby={`${uid}-summaries`}
            aria-describedby={`${uid}-summaries-help`}
            onClick={() => setSummaries(summaries === "on" ? "off" : "on")}
          >
            <span className="ball" aria-hidden />
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn primary" onClick={() => void save()} aria-disabled={!dirty || pending || undefined}>
            {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
            {AI_COPY.save}
          </button>
        </div>
      </div>
    );
  }

  // The page's section heading names it (`<h2>{AI_COPY.title}</h2>`, the settings page's pattern).
  return (
    <section className="card" aria-label={AI_COPY.title} data-testid="ai-settings">
      <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-muted)" }}>{AI_COPY.sub}</p>
      {body}
    </section>
  );
}
