"use client";

/**
 * WARP-2977 P2b (ADR-059 §3.6, spec §8) — /security/settings, "Opening hours".
 *
 * When the site is normally open: the usual week, special days, the site's
 * timezone, and the server's own 7-day preview of what it will do with them.
 * Droplet reads this to tell ordinary activity from after-hours activity; it
 * is NOT read from the calendar, and nothing here locks a door or sends an
 * alert — the page says so under its title.
 *
 * Every reader sees the page (GET /api/security/hours is view-level). Editing
 * is manage-level (`useModuleLevel`, which fails closed): below it the page is
 * text only. The server's feature gate is the boundary either way.
 *
 * Every write goes through the useSecurityHours hook, which also refreshes the
 * mode (an hours change can move it). Errors are toasts through
 * `translateError(err, "security")` — never the server's message.
 *
 * Lives under /security (never /settings, which is always on and would escape
 * the Security module's route guard).
 */
import { useMemo } from "react";
import { Clock, Loader2, RefreshCw } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import {
  BusinessProfileHint,
  COPY,
  HoursEditor,
  HoursPreview,
  type HoursSaveOutcome,
} from "@/components/security/HoursEditor";
import {
  COPY as SPECIAL_COPY,
  ExceptionsEditor,
  type SpecialDayInput,
} from "@/components/security/ExceptionsEditor";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { levelAtLeast, useModuleLevel } from "@/lib/hooks/useModuleGate";
import { useSecurityHours } from "@/lib/hooks/useSecurity";
import { deviceTimeZone, siteDateOf } from "@/lib/security-time";
import type { SecurityHoursBody } from "@/lib/types";

function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;
}

export default function SecuritySettingsPage() {
  const { toast } = useToast();
  const level = useModuleLevel("security");
  const canManage = levelAtLeast(level, "manage");
  const hoursApi = useSecurityHours();
  const hours = hoursApi.hours;
  const deviceZone = deviceTimeZone();
  // translateError logs the raw cause; do it once per error, not per render.
  const loadError = useMemo(
    () => (hoursApi.error ? translateError(hoursApi.error, "security") : null),
    [hoursApi.error],
  );

  const saveHours = async (body: SecurityHoursBody): Promise<HoursSaveOutcome> => {
    try {
      const r = await hoursApi.save(body);
      // null views = saved, but not read back (the hook re-reads): still a save, never "try again".
      toast(r.hours === null ? COPY.savedUnreadToast : body.state === "set" ? COPY.savedToast : COPY.clearedToast, "success");
      return "saved";
    } catch (err) {
      if (errorCode(err) !== "VERSION_CONFLICT") {
        toast(translateError(err, "security"), "error");
        return "failed";
      }
      // No toast: the editor's own banner explains it and offers "Show their
      // changes" — a "refresh the page" toast beside it would throw the draft
      // away. Re-read in the background: when only a special day moved the
      // version, the week is unchanged and the draft's next Save lands.
      void hoursApi.mutate();
      return "conflict";
    }
  };

  /** A lost race re-reads the hours (the list then shows the latest) and says so — never "refresh the page". */
  const specialDayFailed = (err: unknown) => {
    if (errorCode(err) === "VERSION_CONFLICT") {
      toast(SPECIAL_COPY.conflictToast, "error");
      void hoursApi.mutate();
      return;
    }
    toast(translateError(err, "security"), "error");
  };

  // Special days are single writes started from the LATEST read, so they send
  // the cached version; a conflict re-reads the hours so the next try can land.
  const saveSpecialDay = async (date: string, input: SpecialDayInput): Promise<boolean> => {
    if (!hours) return false;
    try {
      const r = await hoursApi.saveException(date, { ...input, expectedVersion: hours.version });
      toast(r.hours === null ? SPECIAL_COPY.savedUnreadToast : SPECIAL_COPY.savedToast, "success");
      return true;
    } catch (err) {
      specialDayFailed(err);
      return false;
    }
  };

  const removeSpecialDay = async (date: string): Promise<boolean> => {
    if (!hours) return false;
    try {
      await hoursApi.deleteException(date, hours.version);
      toast(SPECIAL_COPY.removedToast, "success");
      return true;
    } catch (err) {
      specialDayFailed(err);
      return false;
    }
  };

  const siteZone = hours?.state === "set" ? hours.timezone : null;
  const today = siteZone ? siteDateOf(new Date(), siteZone) : null;

  return (
    <ShellPage icon={<Clock size={15} />} label="Security" title={COPY.pageTitle} sub={COPY.pageSub} rhythm>
      {hours === null && loadError ? (
        <section className="card" role="alert" data-testid="hours-error">
          <div className="empty">
            <span className="eh">{COPY.loadFailed}</span>
            <span style={{ maxWidth: "48ch" }}>{loadError}</span>
            <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => void hoursApi.mutate()}>
              <RefreshCw size={16} aria-hidden />
              {COPY.retry}
            </button>
          </div>
        </section>
      ) : hours === null ? (
        <section className="card" aria-busy="true" data-testid="hours-loading">
          <div className="empty">
            <Loader2 size={20} className="animate-spin" aria-hidden />
            <span className="sr-only">{COPY.loading}</span>
          </div>
        </section>
      ) : (
        <>
          <HoursEditor
            hours={hours}
            canManage={canManage}
            deviceZone={deviceZone}
            onSave={saveHours}
            onReload={() => hoursApi.mutate()}
          />
          <ExceptionsEditor
            exceptions={hours.exceptions}
            hoursSet={hours.state === "set"}
            today={today}
            canManage={canManage}
            onSave={saveSpecialDay}
            onDelete={removeSpecialDay}
          />
          {siteZone && <HoursPreview preview={hours.preview} timezone={siteZone} />}
          {/* For whoever edits the hours. The server blanks typicalDay below owner/admin (the business profile's §15 ladder). */}
          {canManage && <BusinessProfileHint typicalDay={hours.hint.typicalDay} />}
        </>
      )}
    </ShellPage>
  );
}
