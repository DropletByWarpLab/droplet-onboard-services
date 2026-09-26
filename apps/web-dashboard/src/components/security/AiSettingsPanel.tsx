"use client";

/**
 * WARP-2979 (ADR-059 P4 §8) — "Droplet's AI", on /security/settings: what
 * Droplet may do with links on its own.
 *
 * The summaries switch is not shown here yet (review #2418, spec §11: no
 * half-built feature): nothing reads that setting until P4 PR-2 builds the
 * writer, which brings the switch back. Every save sends the stored value
 * back untouched — the route's body names both.
 *
 * At manage (`useModuleLevel`, which fails closed): three radios for linking,
 * saved with the version they were read at (PUT /api/security/ai-settings). A 409 re-reads and says so in a banner
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
import type { SecurityAiLinking } from "@/lib/types";

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
  const [pending, setPending] = useState(false);
  // Review #2418: the in-flight guard itself — Save stays focusable (aria-disabled), so a second press is refused here.
  const pendingRef = useRef(false);
  const [conflict, setConflict] = useState(false);

  // The form follows every new version the box answers with (a save, a re-read after a conflict).
  useEffect(() => {
    if (!settings) return;
    setLinking(settings.linking);
  }, [settings]);

  const dirty = settings !== null && linking !== settings.linking;

  const save = async () => {
    if (!settings || !linking || pendingRef.current || !dirty) return;
    pendingRef.current = true;
    setPending(true);
    setConflict(false);
    try {
      await api.save({ linking, summaries: settings.summaries, expectedVersion: settings.version });
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
  } else if (!settings || !linking) {
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
