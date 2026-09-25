"use client";

/**
 * WARP-2980 (ADR-059 P5 PR-B, brief §4.4) — "Expected activity" on
 * /security/patterns: what someone who can change Security settings has said
 * is normal for a place and time, until when, and why.
 *
 * Each row: `Person in Stock room` (plus "Removed area" once the area is
 * archived), `Weekdays, 10 PM–2 AM`, the flags it stops, the reason in
 * quotes, `Until Oct 25 · added by Stefan`, and — for owner/admin only, the
 * server sends null to anyone else — `Kept 3 flags quiet`. Dates and hours are
 * the SITE's.
 *
 * Add and Remove render from route 32's `canManage` — the server's own answer
 * — never from a client-side level guess (which reads `view` for an admin with
 * no per-person set, and a control the server refuses writes a denial row).
 * A read that fails renders the friendly copy and Retry, never the empty
 * state: "nothing is marked as expected" and "Droplet couldn't say" must not
 * look the same.
 *
 * One column on a phone: the Remove button wraps under the text
 * (patterns.css), so 375 px never scrolls sideways. Tokens only.
 */
import { useRef, useState } from "react";
import { CalendarCheck, Loader2, Plus, RefreshCw } from "lucide-react";
import { useToast } from "@/components/Toast";
import { createSecuritySuppression, removeSecuritySuppression } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import { deviceTimeZone } from "@/lib/security-time";
import { useSecuritySuppressions } from "@/lib/hooks/useSecurity";
import type { SecurityPatternsOverview, SecuritySuppressionCreateBody, SecuritySuppressionView } from "@/lib/types";
import { ExpectedActivityDialog } from "./ExpectedActivityDialog";
import { DAYS_NAME, EXPECTED_COPY as C, EXPECTED_DIALOG_COPY, PATTERN_NAME, fillCopy, hoursSpan, labelName, siteDate } from "./patterns-copy";
import "./patterns.css";

/** Row line 1: "Person in Stock room" / "Car on Back camera". */
export function expectedWhat(s: Pick<SecuritySuppressionView, "label" | "target">): string {
  return fillCopy(s.target.kind === "area" ? C.inArea : C.onCamera, { label: labelName(s.label), place: s.target.name });
}

/** Row line 2: "Weekdays, 10 PM–2 AM". */
export function expectedWhen(s: Pick<SecuritySuppressionView, "days" | "hourFrom" | "hourCount">): string {
  return `${DAYS_NAME[s.days]}, ${hoursSpan(s.hourFrom, s.hourCount)}`;
}

export function ExpectedActivityCard({ overview, now }: { overview: SecurityPatternsOverview; now: Date }) {
  const { list, error, mutate } = useSecuritySuppressions();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const tz = overview.timezone ?? deviceTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const canManage = list?.canManage === true;
  const noKeys = overview.keys.length === 0;

  const onCreate = async (body: SecuritySuppressionCreateBody) => {
    const r = await createSecuritySuppression(body);
    toast(fillCopy(C.added, { date: siteDate(r.suppression.expiresAt, tz, now) }), "success");
    await mutate();
  };

  const onRemove = async (s: SecuritySuppressionView) => {
    if (removing) return;
    setRemoving(s.id);
    try {
      await removeSecuritySuppression(s.id);
      toast(C.removed, "success");
    } catch (err) {
      toast(translateError(err, "security"), "error");
    } finally {
      setRemoving(null);
      await mutate();
    }
  };

  let body;
  if (!list && error) {
    body = (
      <div className="empty" role="alert">
        <span style={{ maxWidth: "44ch" }}>{translateError(error, "security")}</span>
        <button type="button" className="btn" onClick={() => void mutate()} style={{ marginTop: 8 }}>
          <RefreshCw size={16} aria-hidden />
          {C.retry}
        </button>
      </div>
    );
  } else if (!list) {
    body = (
      <div className="empty" data-testid="expected-loading" aria-busy="true">
        <Loader2 size={20} className="animate-spin" aria-hidden />
      </div>
    );
  } else if (list.suppressions.length === 0) {
    body = <p className="expected-empty">{canManage ? C.emptyManage : C.empty}</p>;
  } else {
    body = (
      <ul className="expected-list">
        {list.suppressions.map((s) => {
          const what = expectedWhat(s);
          const when = expectedWhen(s);
          return (
            <li key={s.id} className="expected-row" data-suppression-id={s.id}>
              <div className="expected-text">
                <span className="expected-what">
                  {what}
                  {s.target.kind === "area" && s.target.archived && <span className="badge muted expected-badge">{C.removedArea}</span>}
                </span>
                <span className="expected-line">{when}</span>
                <span className="expected-line">{s.codes.map((c) => PATTERN_NAME[c]).join(" · ")}</span>
                <span className="expected-reason">“{s.reason}”</span>
                <span className="expected-line">{fillCopy(C.until, { date: siteDate(s.expiresAt, tz, now), name: s.createdByName })}</span>
                {s.quietedFlags !== null && s.quietedFlags > 0 && (
                  <span className="expected-line">{s.quietedFlags === 1 ? C.quietedOne : fillCopy(C.quietedMany, { n: s.quietedFlags })}</span>
                )}
              </div>
              {canManage && (
                <button
                  type="button"
                  className="btn sm ghost"
                  aria-label={fillCopy(C.removeAria, { what, when })}
                  disabled={removing !== null}
                  onClick={() => void onRemove(s)}
                >
                  {removing === s.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                  {C.remove}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className="card" aria-labelledby="patterns-expected">
      <div className="card-h" style={{ flexWrap: "wrap" }}>
        <span className="ci">
          <CalendarCheck size={16} />
        </span>
        <h2 className="ct" id="patterns-expected" style={{ margin: 0 }}>
          {C.title}
        </h2>
        {canManage && (
          <button
            ref={addRef}
            type="button"
            className="btn sm primary"
            style={{ marginLeft: "auto" }}
            disabled={noKeys}
            aria-describedby={noKeys ? "patterns-expected-nokeys" : undefined}
            onClick={() => setAdding(true)}
          >
            <Plus size={14} aria-hidden />
            {C.add}
          </button>
        )}
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--text-muted)" }}>{C.hint}</p>
      {canManage && noKeys && (
        <p id="patterns-expected-nokeys" className="expected-line" style={{ margin: "0 0 10px" }}>
          {EXPECTED_DIALOG_COPY.noKeys}
        </p>
      )}
      {body}
      {canManage && !noKeys && (
        <ExpectedActivityDialog
          open={adding}
          onClose={() => setAdding(false)}
          keys={overview.keys}
          timezone={overview.timezone}
          now={now}
          onCreate={onCreate}
          triggerRef={addRef}
        />
      )}
    </section>
  );
}
