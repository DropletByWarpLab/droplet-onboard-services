"use client";

/**
 * WARP-1056 — §3.3 "Who Droplet recognizes": the voice-profiles section
 * of /voice, upgraded from the WARP-1055 empty-state shell to real rows.
 *
 * Row anatomy per the brief: avatar · name · human-sentence meta
 * (`Enrolled May 12 · last recognized today`, plus the §5 "Learning"
 * flag and the §7.6 orange "Sometimes confused with [Name]" note) ·
 * `ShieldCheck` mini-chip "On this box only" · overflow menu (⋯) with
 * "Re-record voice" and "Remove voice" (red, confirm dialog — §10
 * destructive Write: "Remove [Name]'s voice? This deletes their
 * voiceprint from this box immediately.").
 *
 * Entry point gating (§7.2 rule — never launch a wizard that cannot
 * succeed): "Add a voice" disables when the box can't enroll (speaker
 * model absent / mic broken); the parent owns that flag.
 */

import { useEffect, useRef, useState } from "react";
import {
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SafetyChip } from "@/components/email/SafetyChip";
import { useToast } from "@/components/Toast";
import { removeVoiceProfile } from "@/lib/api";
import type { VoiceProfileInfo } from "@/lib/types";
import { formatCalDate } from "./state";
import "./voice.css";

/* §9 copy — ships verbatim. */
const COPY = {
  header: "Who Droplet recognizes",
  addVoice: "Add a voice",
  empty:
    "No voices enrolled. Droplet answers everyone as a guest until it knows who's who.",
  privacy:
    "Voiceprints are stored and matched on this box. They never leave your network and are deleted instantly when removed.",
  guestLine:
    "Unrecognized voices are treated as guests — read-only answers, no personal data.",
  chip: "On this box only",
} as const;

const REMOVED_TOAST = "Voice removed — the voiceprint is gone from this box.";
const REMOVE_FAILED_TOAST = "Couldn't remove the voice — try again.";

/* §7.2 — why an enrollment entry point is disabled, when the caller
   doesn't name a more specific reason. */
const CANT_ENROLL_TITLE =
  "Voice recognition isn't available on this Droplet right now.";

/** "today" / "yesterday" / "3 days ago" — the meta line is a human
 *  sentence (§3.3: mono is NOT wanted here). */
export function lastRecognizedLabel(epochS: number, nowS: number): string {
  const now = new Date(nowS * 1000);
  const then = new Date(epochS * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.floor(
    (startOfToday.getTime() - then.getTime()) / 86_400_000,
  ) + 1;
  if (then >= startOfToday) return "today";
  if (days <= 1) return "yesterday";
  return `${days} days ago`;
}

export interface VoiceProfilesSectionProps {
  /** null while loading / voice-io unreachable → the §7.1 empty shell. */
  profiles: VoiceProfileInfo[] | null;
  /** §7.2 gate for every enrollment entry point on this section. */
  enrollmentAllowed: boolean;
  /** WARP-1599 — the tooltip a disabled entry point carries, so the
   *  reason travels with the gate (the kill switch and a broken mic
   *  disable the same controls for very different reasons). Defaults to
   *  the §7.2 "not available on this Droplet" sentence. */
  enrollmentBlockedReason?: string;
  nowS: number;
  onAddVoice: () => void;
  /** Re-record = Flow B with the person preselected. */
  onReRecord: (userId: string) => void;
  /** Fires after a successful remove so the parent revalidates. */
  onProfilesChanged: () => void;
}

export function VoiceProfilesSection({
  profiles,
  enrollmentAllowed,
  enrollmentBlockedReason = CANT_ENROLL_TITLE,
  nowS,
  onAddVoice,
  onReRecord,
  onProfilesChanged,
}: VoiceProfilesSectionProps) {
  const { toast } = useToast();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<VoiceProfileInfo | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Outside-click / Escape close for the row overflow menu.
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuFor(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuFor(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

  async function handleRemoveConfirm() {
    if (!removeTarget) return;
    try {
      await removeVoiceProfile(removeTarget.user_id);
    } catch {
      toast(REMOVE_FAILED_TOAST, "error");
      return;
    }
    toast(REMOVED_TOAST, "success");
    onProfilesChanged();
  }

  function rowMeta(p: VoiceProfileInfo): string {
    const parts = [`Enrolled ${formatCalDate(p.enrolled_at)}`];
    if (p.learning) parts.push("Learning");
    if (p.last_recognized_at) {
      parts.push(
        `last recognized ${lastRecognizedLabel(p.last_recognized_at, nowS)}`,
      );
    }
    return parts.join(" · ");
  }

  const rows = profiles ?? [];
  const removeName =
    removeTarget?.display_name ?? removeTarget?.user_id ?? "";
  // One reason, both enrollment entry points — a disabled control that
  // doesn't say why is a dead end (§7.2).
  const blockedTitle = enrollmentAllowed ? undefined : enrollmentBlockedReason;

  return (
    <section aria-labelledby="voice-profiles-h">
      <div className="vsect-h">
        <h2 id="voice-profiles-h">{COPY.header}</h2>
        <button
          type="button"
          className="btn ghost sm vsect-action"
          disabled={!enrollmentAllowed}
          title={blockedTitle}
          onClick={onAddVoice}
        >
          {COPY.addVoice}
        </button>
      </div>
      <div className="vcard">
        {rows.length === 0 ? (
          <div className="vempty">{COPY.empty}</div>
        ) : (
          <ul className="vrows">
            {rows.map((p) => {
              const name = p.display_name ?? p.user_id;
              return (
                <li key={p.user_id} className="vrow vprofile">
                  <span className="vavatar">
                    <UserRound size={16} aria-hidden="true" />
                  </span>
                  <span className="vprofile-main">
                    <span className="vprofile-name">{name}</span>
                    <span className="vprofile-meta">{rowMeta(p)}</span>
                    {/* §7.6 — never silently misattribute: both rows of a
                        hard-to-distinguish pair carry this note. */}
                    {p.confused_with && (
                      <span className="vprofile-confused">
                        Sometimes confused with{" "}
                        {p.confused_with_name ?? "another voice"} —
                        re-recording either voice helps
                      </span>
                    )}
                  </span>
                  <span className="vchip-box" title={COPY.privacy}>
                    <ShieldCheck size={11} aria-hidden="true" />
                    {COPY.chip}
                  </span>
                  <div
                    className="vrow-menu"
                    ref={menuFor === p.user_id ? menuRef : undefined}
                  >
                    <button
                      type="button"
                      className="vmenu-btn"
                      aria-label={`Voice options for ${name}`}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === p.user_id}
                      onClick={() =>
                        setMenuFor((v) => (v === p.user_id ? null : p.user_id))
                      }
                    >
                      <MoreHorizontal size={15} aria-hidden="true" />
                    </button>
                    {menuFor === p.user_id && (
                      <div role="menu" className="vmenu">
                        <button
                          type="button"
                          role="menuitem"
                          disabled={!enrollmentAllowed}
                          title={blockedTitle}
                          onClick={() => {
                            setMenuFor(null);
                            onReRecord(p.user_id);
                          }}
                        >
                          <RefreshCw size={12} aria-hidden="true" /> Re-record
                          voice
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() => {
                            setMenuFor(null);
                            setRemoveTarget(p);
                          }}
                        >
                          <Trash2 size={12} aria-hidden="true" /> Remove voice
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <ul className="vrows">
          <li className="vrow muted-line">
            <UserRound size={15} aria-hidden="true" />
            <span>{COPY.guestLine}</span>
          </li>
        </ul>
      </div>
      <p className="vcaption">{COPY.privacy}</p>

      {/* §10 — Remove is a destructive Write: red confirm, verbatim copy. */}
      <ConfirmDialog
        open={removeTarget != null}
        onConfirm={handleRemoveConfirm}
        onCancel={() => setRemoveTarget(null)}
        title={`Remove ${removeName}'s voice?`}
        description="This deletes their voiceprint from this box immediately."
        confirmLabel="Remove voice"
        variant="destructive"
        accessory={<SafetyChip safety="Write · confirm" />}
      />
    </section>
  );
}
