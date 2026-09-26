"use client";

/**
 * WARP-2979 (ADR-059 P4 §8) — Droplet's suggestions, above the Areas cards.
 *
 * Manage only (the box fills the list only at manage, and this section is not
 * rendered below it); hidden when there are none. Each card: "Back camera may
 * cover Stock room", the evidence in sentences, when it was suggested, Add it
 * (route 24) and Not this (route 25). A refusal is a
 * `translateError(err, "security")` toast — never the server's message — and
 * the lists re-read (the hook does).
 *
 * Review #2418: in flight, Add it and Not this are aria-disabled — never
 * `disabled` — and a ref refuses a second press. A decided suggestion's card
 * goes; `onDecided(zoneId)` tells the panel, which moves focus to that area's
 * card. A refused one keeps its card, and focus stays on the pressed button.
 */
import { useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import type { SecurityLinkProposal } from "@/lib/types";
import { evidenceSentences, provenanceLine, sourcePhrase } from "./link-evidence-copy";
import { fill } from "./TimezoneSelect";

export const SUGGEST_COPY = {
  title: "Droplet's suggestions",
  sub: "Droplet noticed these by comparing when things happen. Nothing changes until you add one.",
  card: "{camera} may cover {area}",
  add: "Add it",
  notThis: "Not this",
  added: "Added. {camera} now covers {area}.",
  turnedDown: "Droplet won't suggest {camera} for {area} again.",
} as const;

const upperFirst = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export interface LinkSuggestionsProps {
  proposals: readonly SecurityLinkProposal[] | null;
  canManage: boolean;
  tz: string;
  now: Date;
  accept: (linkId: string) => Promise<unknown>;
  reject: (linkId: string) => Promise<unknown>;
  /** After a suggestion is decided (its card goes): the area it was for, so focus can land there. */
  onDecided?: (zoneId: string) => void;
}

export function LinkSuggestions({ proposals, canManage, tz, now, accept, reject, onDecided }: LinkSuggestionsProps) {
  const { toast } = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  if (!canManage || !proposals || proposals.length === 0) return null;

  const decide = async (p: SecurityLinkProposal, which: "add" | "reject") => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(p.linkId);
    const camera = sourcePhrase(p);
    try {
      await (which === "add" ? accept(p.linkId) : reject(p.linkId));
      toast(fill(which === "add" ? SUGGEST_COPY.added : SUGGEST_COPY.turnedDown, { camera, area: p.zone.name }), "success");
      onDecided?.(p.zone.id);
    } catch (err) {
      toast(translateError(err, "security"), "error");
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  return (
    <section className="card" aria-labelledby="link-suggestions-title" data-testid="link-suggestions">
      <div className="card-h" style={{ flexWrap: "wrap" }}>
        <span className="ci">
          <Sparkles size={16} />
        </span>
        <h2 className="ct" id="link-suggestions-title" style={{ margin: 0 }}>
          {SUGGEST_COPY.title}
        </h2>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)" }}>{SUGGEST_COPY.sub}</p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
        {proposals.map((p) => {
          const titleId = `suggestion-${p.linkId}`;
          const busy = pending === p.linkId;
          return (
            <li
              key={p.linkId}
              aria-labelledby={titleId}
              data-link-id={p.linkId}
              style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-input)", padding: "12px 14px", display: "grid", gap: 6 }}
            >
              <span id={titleId} style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", overflowWrap: "anywhere" }}>
                {upperFirst(fill(SUGGEST_COPY.card, { camera: sourcePhrase(p), area: p.zone.name }))}
              </span>
              {p.evidence &&
                evidenceSentences(p.evidence, tz, now).map((s) => (
                  <span key={s} style={{ fontSize: 13, color: "var(--text)", overflowWrap: "anywhere" }}>
                    {s}
                  </span>
                ))}
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{provenanceLine("suggested", p.suggestedAt, tz)}</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn sm primary"
                  aria-describedby={titleId}
                  aria-disabled={pending !== null || undefined}
                  onClick={() => void decide(p, "add")}
                >
                  {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                  {SUGGEST_COPY.add}
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  aria-describedby={titleId}
                  aria-disabled={pending !== null || undefined}
                  onClick={() => void decide(p, "reject")}
                >
                  {SUGGEST_COPY.notThis}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
