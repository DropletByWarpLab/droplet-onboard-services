"use client";

/**
 * WARP-2980 (ADR-059 P5 PR-C, brief §4.4, spec §6.11, §8) — "Was this
 * expected?" on the incident page, built on route 18's `verdict` and
 * `viewer.canGiveVerdict` and route 35 (POST …/verdict).
 *
 * What an answer is, as the box has it: the owner or an admin says whether a
 * flag was worth raising. "Not expected" means it was right, and "How often
 * Droplet was right" on Patterns counts it. An answer never acknowledges,
 * resolves or changes who is told, and it never stops a flag by itself:
 * expected activity does that, and adding it is manage (Patterns). So after
 * Expected the page says what would stop the flag, and after Not expected it
 * says when expected activity still keeps part of this quiet.
 *
 * Rules:
 *   · DS-005 — the box sends `verdict: null` to anyone who doesn't see every
 *     camera and may read threats; then nothing renders. With no answer yet
 *     and nobody here who can give one, nothing renders either.
 *   · Expected / Not expected render only at act — the module level (fails
 *     closed) AND the box's own `viewer.level` — AND when the box says this
 *     viewer may answer (`viewer.canGiveVerdict`, exactly when route 35
 *     would accept). Never rendered and then refused. Independent of
 *     `actionable`: a trial-only incident has nothing to acknowledge and can
 *     still be judged.
 *   · The way to expected activity is offered at manage (module level AND
 *     `viewer.level`); below it, the words say who can.
 *   · Expected activity never quietens a rule (someone inside while closed,
 *     a camera that stopped, a network or sign-in warning): after Expected on
 *     someone inside while closed, the page says what changes that instead.
 *   · In flight, both buttons are aria-disabled — never `disabled`, so the
 *     pressed one keeps focus — and a press is refused here as well as by the
 *     page's own guard. The page moves focus to the answer line if the box's
 *     answer takes the buttons away.
 */
import type { Ref } from "react";
import { useId } from "react";
import Link from "next/link";
import { levelAtLeast, type ModuleLevel } from "@/lib/hooks/useModuleGate";
import { formatSiteWhen } from "@/lib/security-time";
import type { IncidentDetail, IncidentPatternFlagView, IncidentVerdict, IncidentVerdictView, SecurityMode, SecurityReasonCode } from "@/lib/types";
import { EXPECTED_ACTIVITY_HREF } from "./PatternFlagList";
import { fillCopy } from "./patterns-copy";

export const VERDICT_COPY = {
  title: "Was this expected?",
  hint: "Your answer shows how often Droplet's flags are right. It doesn't acknowledge or resolve this, or change who is told.",
  expected: "Expected",
  notExpected: "Not expected",
  saidExpected: "{name} said this was expected",
  saidNotExpected: "{name} said this was not expected",
  someone: "Someone",
  savedExpected: "Marked as expected",
  savedNotExpected: "Marked as not expected",
  addExpected: "To stop Droplet flagging this as unusual at this place and time, add it as expected activity.",
  addExpectedLink: "Add expected activity",
  askManager: "To stop Droplet flagging this as unusual at this place and time, someone who manages Security can add it as expected activity.",
  ruleCodesClosed:
    "Droplet will still flag this, because the opening hours say the site is closed then. If people are often here at this time, change the opening hours or use Open up.",
  ruleCodesAway: "Droplet will still flag someone inside while the site is set to away.",
  stillQuiet: "Expected activity still keeps part of this quiet. Remove it if it shouldn't.",
  reviewExpectedLink: "Review expected activity",
  stillQuietAsk: "Expected activity still keeps part of this quiet. Someone who manages Security can remove it.",
} as const;

export interface VerdictBarProps {
  verdict: IncidentVerdictView | null;
  viewer: IncidentDetail["viewer"];
  /** The flags the page shows this viewer (a trial flag only to owner/admin). */
  flags: readonly IncidentPatternFlagView[];
  reasonCodes: readonly SecurityReasonCode[];
  openedInMode: SecurityMode;
  /** `useModuleLevel("security")` — fails closed. */
  moduleLevel: ModuleLevel;
  /** A write on this incident is in flight (this one or Acknowledge / Resolve). */
  busy: boolean;
  onVerdict: (verdict: IncidentVerdict) => void;
  timezone: string;
  now: Date;
  /** The buttons' group, so the page can tell whether they're still there after a write. */
  groupRef?: Ref<HTMLDivElement>;
  /** The answer line, where the page puts focus when the buttons go away. */
  answerRef?: Ref<HTMLParagraphElement>;
}

const LINE = { margin: "12px 0 0", fontSize: 13, color: "var(--text-muted)", maxWidth: "70ch" } as const;

export function VerdictBar({
  verdict,
  viewer,
  flags,
  reasonCodes,
  openedInMode,
  moduleLevel,
  busy,
  onVerdict,
  timezone,
  now,
  groupRef,
  answerRef,
}: VerdictBarProps) {
  const id = useId();
  if (!verdict) return null;
  const canGive = levelAtLeast(moduleLevel, "act") && levelAtLeast(viewer.level, "act") && viewer.canGiveVerdict === true;
  if (verdict.state === "unreviewed" && !canGive) return null;
  const canManage = levelAtLeast(moduleLevel, "manage") && levelAtLeast(viewer.level, "manage");

  const answer =
    verdict.state === "unreviewed"
      ? null
      : [
          fillCopy(verdict.state === "expected" ? VERDICT_COPY.saidExpected : VERDICT_COPY.saidNotExpected, {
            name: verdict.byName || VERDICT_COPY.someone,
          }),
          verdict.at ? formatSiteWhen(verdict.at, timezone, now) : null,
        ]
          .filter((p): p is string => Boolean(p))
          .join(" · ");

  // Expected activity can quieten a flag still being raised (trial here); a rule, never.
  const offerExpected = verdict.state === "expected" && flags.some((f) => f.effect === "trial");
  const ruleLine =
    verdict.state === "expected" && reasonCodes.includes("after_hours_presence")
      ? openedInMode === "closed"
        ? VERDICT_COPY.ruleCodesClosed
        : openedInMode === "away"
          ? VERDICT_COPY.ruleCodesAway
          : null
      : null;
  const stillQuiet = verdict.state === "not_expected" && flags.some((f) => f.effect === "suppressed" && f.suppression?.state === "active");

  const press = (v: IncidentVerdict) => {
    if (busy) return;
    onVerdict(v);
  };

  return (
    <>
      <div className="sect">
        <h2 id={id}>{VERDICT_COPY.title}</h2>
      </div>
      <section className="card" aria-labelledby={id} data-testid="verdict-bar">
        {answer === null ? (
          <p style={{ ...LINE, margin: 0 }}>{VERDICT_COPY.hint}</p>
        ) : (
          <p
            ref={answerRef}
            tabIndex={-1}
            data-testid="verdict-answer"
            style={{ margin: 0, fontSize: 13.5, color: "var(--text)", overflowWrap: "anywhere", outlineOffset: 4 }}
          >
            {answer}
          </p>
        )}
        {canGive && (
          <div ref={groupRef} role="group" aria-labelledby={id} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            {(
              [
                ["expected", VERDICT_COPY.expected],
                ["not_expected", VERDICT_COPY.notExpected],
              ] as const
            ).map(([value, text]) => {
              const pressed = verdict.state === value;
              return (
                <button
                  key={value}
                  type="button"
                  className={pressed ? "btn primary" : "btn"}
                  aria-pressed={pressed}
                  aria-disabled={busy || undefined}
                  onClick={() => press(value)}
                >
                  {text}
                </button>
              );
            })}
          </div>
        )}
        {ruleLine && <p style={LINE}>{ruleLine}</p>}
        {offerExpected &&
          (canManage ? (
            <p style={LINE}>
              <span>{VERDICT_COPY.addExpected}</span>{" "}
              <Link href={EXPECTED_ACTIVITY_HREF} style={{ color: "var(--brand)" }}>
                {VERDICT_COPY.addExpectedLink}
              </Link>
            </p>
          ) : (
            <p style={LINE}>{VERDICT_COPY.askManager}</p>
          ))}
        {stillQuiet &&
          (canManage ? (
            <p style={LINE}>
              <span>{VERDICT_COPY.stillQuiet}</span>{" "}
              <Link href={EXPECTED_ACTIVITY_HREF} style={{ color: "var(--brand)" }}>
                {VERDICT_COPY.reviewExpectedLink}
              </Link>
            </p>
          ) : (
            <p style={LINE}>{VERDICT_COPY.stillQuietAsk}</p>
          ))}
      </section>
    </>
  );
}
