/**
 * WARP-540 — /settings/updates: the operator surface over the OTA update
 * agent. Everything renders from GET /api/updates/status + /history:
 *
 *   · current-release card — the newest committed OTA release's commit
 *     SHA (linked to GitHub) or an honest "factory image" line, plus the
 *     "Check now" action (one forced poll tick, outcome shown verbatim);
 *   · pending banner — the release on deck, its scheduled window
 *     ("Scheduled for 03:00" from the persisted cron), "Apply now"
 *     (disabled with an honest note on boxes without the apply helper)
 *     and "Skip this release" (two-step inline confirm);
 *   · degraded red banner — the WARP-539 rollback-also-failed verdict;
 *   · history table — every tracked release and its verdict;
 *   · settings card — apply window + auto-apply (WARP-538 knobs).
 *
 * Copy honesty (recurring "fallback copy masks outages" defect class):
 * if the status fetch fails this page says SO in red and renders no
 * cards — an unreachable orchestrator must never read as "no updates,
 * all healthy". Empty-but-loaded states get their own distinct copy.
 *
 * While a row is verifying/applying the status poll tightens to 5s so
 * the operator watches the state machine advance live (apply may end by
 * restarting the orchestrator itself — the fetch failing mid-apply is
 * expected and surfaces through the same explicit error state).
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock,
  DownloadCloud,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Sect, type BadgeKind } from "@/components/shell/primitives";
import {
  applyUpdateNow,
  checkForUpdatesNow,
  getUpdatesHistory,
  getUpdatesStatus,
  saveUpdateSettings,
  skipPendingUpdate,
  type CheckNowResult,
  type UpdateRelease,
  type UpdatesStatus,
} from "@/lib/api";

/** Same canonical repo the trust page links; releases are built from it. */
const COMMIT_URL_BASE =
  "https://github.com/DropletByWarpLab/droplet-onboard-services/commit/";

const STATUS_BADGE: Record<UpdateRelease["status"], { kind: BadgeKind; label: string }> = {
  pending: { kind: "info", label: "Pending" },
  verifying: { kind: "info", label: "Verifying" },
  applying: { kind: "info", label: "Applying" },
  committed: { kind: "ok", label: "Committed" },
  superseded: { kind: "muted", label: "Superseded" },
  rolled_back: { kind: "warn", label: "Rolled back" },
  failed: { kind: "danger", label: "Failed" },
  rejected: { kind: "danger", label: "Rejected" },
};

/** "0 3 * * *" → "03:00"; null for anything not a simple daily spec. */
function cronToDailyTime(cron: string): string | null {
  const m = cron.trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (!m) return null;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "03:00" → "0 3 * * *". */
function dailyTimeToCron(time: string): string | null {
  const m = time.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Honest one-liner per check-now outcome — failures stay failures. */
function checkOutcomeCopy(result: CheckNowResult): { ok: boolean; text: string } {
  switch (result.outcome) {
    case "no_release":
      return { ok: true, text: "No release has been published yet." };
    case "already_known":
      return { ok: true, text: "Already tracking the latest release — nothing new." };
    case "pending_created":
      return { ok: true, text: "New release found — it is now pending below." };
    case "channel_mismatch":
      return {
        ok: false,
        text: "The latest release is for a different channel than this box follows.",
      };
    case "source_unauthenticated":
      // WARP-2133: a token-less box gets a 404 it cannot interpret —
      // "no release" and "no access" look identical. This must read as a
      // provisioning gap, never as "no updates, all good".
      return {
        ok: false,
        text: "Update source not provisioned — this box has no credentials for the release feed, so it can't tell whether updates exist.",
      };
    case "verify_failed":
      return {
        ok: false,
        text: "Check failed: the release did not pass signature verification. It was not tracked.",
      };
    case "fetch_failed":
    default:
      return {
        ok: false,
        text: "Check failed: the release feed could not be reached. Try again in a minute.",
      };
  }
}

export default function UpdatesSettingsPage() {
  const [status, setStatus] = useState<UpdatesStatus | null>(null);
  const [history, setHistory] = useState<UpdateRelease[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyStarted, setApplyStarted] = useState(false);

  const [confirmSkip, setConfirmSkip] = useState(false);
  const [skipping, setSkipping] = useState(false);

  // Settings form — seeded once from the first successful status load
  // (and re-seeded after a save), never clobbered by the background poll.
  const settingsSeeded = useRef(false);
  const [applyTime, setApplyTime] = useState("03:00");
  const [rawCron, setRawCron] = useState<string | null>(null); // non-daily spec fallback
  const [autoApply, setAutoApply] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSavedAt, setSettingsSavedAt] = useState<number | null>(null);

  const seedSettingsForm = useCallback((settings: UpdatesStatus["settings"]) => {
    const time = cronToDailyTime(settings.applyWindowCron);
    if (time) {
      setApplyTime(time);
      setRawCron(null);
    } else {
      setRawCron(settings.applyWindowCron);
    }
    setAutoApply(settings.autoApply);
    settingsSeeded.current = true;
  }, []);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([getUpdatesStatus(), getUpdatesHistory()]);
      setStatus(s);
      setHistory(h);
      setLoadError(null);
      if (!settingsSeeded.current) seedSettingsForm(s.settings);
    } catch {
      // Explicit failure state — never an empty-but-healthy render.
      setLoadError(
        "Couldn't reach the update service on this box. The state shown here may be stale or missing — this is a connection problem, not a clean bill of health.",
      );
    } finally {
      setLoading(false);
    }
  }, [seedSettingsForm]);

  useEffect(() => {
    load();
  }, [load]);

  // Tight poll while an apply is in motion so the operator sees the
  // state machine advance (and the eventual verdict) without reloading.
  const inFlight =
    status?.pending?.status === "verifying" || status?.pending?.status === "applying";
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [inFlight, load]);

  const handleCheckNow = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await checkForUpdatesNow();
      setCheckResult(checkOutcomeCopy(result));
      await load();
    } catch {
      setCheckResult({
        ok: false,
        text: "The check could not be started — the update service did not respond.",
      });
    } finally {
      setChecking(false);
    }
  };

  const handleApplyNow = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      await applyUpdateNow();
      setApplyStarted(true);
      await load();
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      setApplyError(
        code === "apply_in_progress"
          ? "An apply is already running."
          : code === "apply_unavailable"
            ? "Applying updates isn't available on this box."
            : "The update could not be started — the update service did not respond.",
      );
    } finally {
      setApplying(false);
    }
  };

  const handleSkip = async () => {
    setSkipping(true);
    try {
      await skipPendingUpdate();
      setConfirmSkip(false);
      await load();
    } catch {
      setApplyError("The release could not be skipped — the update service did not respond.");
    } finally {
      setSkipping(false);
    }
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    setSettingsError(null);
    setSettingsSavedAt(null);
    try {
      const cron = rawCron !== null ? rawCron : dailyTimeToCron(applyTime);
      if (!cron) {
        setSettingsError("Pick a valid time of day for the update window.");
        return;
      }
      const saved = await saveUpdateSettings({ applyWindowCron: cron, autoApply });
      seedSettingsForm(saved);
      setSettingsSavedAt(Date.now());
      await load();
    } catch {
      setSettingsError("Couldn't save the update settings. Check the values and try again.");
    } finally {
      setSavingSettings(false);
    }
  };

  const windowLabel = status ? (cronToDailyTime(status.settings.applyWindowCron) ?? null) : null;

  return (
    <ShellPage
      icon={<DownloadCloud size={15} />}
      label="Updates"
      title="Software updates"
      sub="What this box is running, what's on deck, and when updates are applied."
    >
      <div style={{ maxWidth: 880 }}>
        {/* ── Explicit load-failure state: no cards, no fake health ── */}
        {loadError && (
          <div
            role="alert"
            className="card border border-system-red/40 bg-system-red/5"
            style={{ padding: 16, marginBottom: 16 }}
          >
            <p
              className="text-system-red flex items-center gap-2"
              style={{ fontSize: 15, lineHeight: "20px" }}
            >
              <AlertTriangle size={16} /> Update status unavailable
            </p>
            <p
              className="mt-1"
              style={{ fontSize: 13, lineHeight: "18px", color: "var(--text-muted)" }}
            >
              {loadError}
            </p>
            <button onClick={load} className="btn ghost sm" style={{ marginTop: 10 }} type="button">
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        )}

        {loading && !status && !loadError && (
          <p className="px-1" style={{ fontSize: 13, color: "var(--text-muted)" }}>
            Loading update status…
          </p>
        )}

        {status && !loadError && (
          <>
            {/* ── degraded_health red banner (WARP-539 worst case) ── */}
            {status.degraded && (
              <div
                role="alert"
                className="card border border-system-red/40 bg-system-red/5"
                style={{ padding: 16, marginBottom: 16 }}
              >
                <p
                  className="text-system-red flex items-center gap-2"
                  style={{ fontSize: 15, lineHeight: "20px" }}
                >
                  <AlertTriangle size={16} /> Appliance health is degraded
                </p>
                <p
                  className="mt-1"
                  style={{ fontSize: 13, lineHeight: "18px", color: "var(--text-muted)" }}
                >
                  The last update failed and rolling back did not restore full health
                  {status.lastVerdict?.releaseTag
                    ? ` (release ${status.lastVerdict.releaseTag})`
                    : ""}
                  . Some services may be down. Check the Health page and consider
                  contacting support — this state does not clear itself.
                </p>
              </div>
            )}

            {/* ── Unprovisioned update source (WARP-2133) ──
                Standing, not check-scoped: without a credential for the
                releases feed every poll comes back empty, so the cards below
                would otherwise read as "up to date" on a box that has never
                been able to see a release. ── */}
            {status.updateSourceAuthenticated === false && (
              <div
                role="alert"
                className="card border border-system-red/40 bg-system-red/5"
                style={{ padding: 16, marginBottom: 16 }}
              >
                <p
                  className="text-system-red flex items-center gap-2"
                  style={{ fontSize: 15, lineHeight: "20px" }}
                >
                  <AlertTriangle size={16} /> Update source not provisioned
                </p>
                <p
                  className="mt-1"
                  style={{ fontSize: 13, lineHeight: "18px", color: "var(--text-muted)" }}
                >
                  This box has no credential for the release feed, so it cannot
                  discover releases at all. Nothing below means this box is up to
                  date — it means this box cannot see whether it is. Contact
                  support to provision the update source.
                </p>
              </div>
            )}

            {/* ── Current release ── */}
            <Sect title="Current release" />
            <div className="card" style={{ padding: 16, marginBottom: 16 }}>
              {status.current ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span
                    className="font-mono"
                    style={{ fontSize: 17, fontWeight: 600, color: "var(--text)" }}
                  >
                    {shortSha(status.current.gitSha)}
                  </span>
                  {status.current.releaseTag && (
                    <Badge kind="ok">{status.current.releaseTag}</Badge>
                  )}
                  <a
                    href={`${COMMIT_URL_BASE}${status.current.gitSha}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent inline-flex items-center gap-1"
                    style={{ fontSize: 13 }}
                  >
                    View commit on GitHub <ExternalLink size={12} />
                  </a>
                  <span className="w-full" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Built {fmtDate(status.current.builtAt)} · applied{" "}
                    {fmtDate(status.current.updatedAt)} · {status.current.channel} channel
                  </span>
                </div>
              ) : (
                <p style={{ fontSize: 13, lineHeight: "18px", color: "var(--text-muted)" }}>
                  No over-the-air update has been applied yet — this box is running the
                  software it shipped with.
                </p>
              )}

              <div className="flex items-center gap-3 mt-4">
                <button
                  onClick={handleCheckNow}
                  disabled={checking}
                  className="btn primary sm"
                  type="button"
                >
                  <RefreshCw size={13} className={checking ? "animate-spin" : undefined} />
                  {checking ? "Checking…" : "Check now"}
                </button>
                {checkResult && (
                  <span
                    className={checkResult.ok ? undefined : "text-system-red"}
                    style={{
                      fontSize: 13,
                      color: checkResult.ok ? "var(--text-muted)" : undefined,
                    }}
                  >
                    {checkResult.text}
                  </span>
                )}
              </div>
            </div>

            {/* ── Pending release banner ── */}
            {status.pending && (
              <>
                <Sect title="Pending release" />
                <div className="card" style={{ padding: 16, marginBottom: 16 }}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span
                      className="font-mono"
                      style={{ fontSize: 17, fontWeight: 600, color: "var(--text)" }}
                    >
                      {shortSha(status.pending.gitSha)}
                    </span>
                    {status.pending.releaseTag && (
                      <Badge kind="info">{status.pending.releaseTag}</Badge>
                    )}
                    <Badge kind={STATUS_BADGE[status.pending.status].kind}>
                      {STATUS_BADGE[status.pending.status].label}
                    </Badge>
                  </div>

                  {status.pending.status === "pending" ? (
                    <>
                      <p
                        className="mt-2 flex items-center gap-1.5"
                        style={{ fontSize: 13, lineHeight: "18px", color: "var(--text-muted)" }}
                      >
                        <Clock size={13} />
                        {status.settings.autoApply
                          ? windowLabel
                            ? `Scheduled for ${windowLabel}`
                            : `Scheduled by the update window (${status.settings.applyWindowCron})`
                          : "Automatic apply is off — this release waits until you apply it."}
                      </p>
                      {applyStarted && !inFlight && (
                        <p
                          className="mt-2"
                          style={{ fontSize: 13, lineHeight: "18px", color: "var(--text-muted)" }}
                        >
                          Apply started. Services will restart; this page keeps refreshing.
                        </p>
                      )}
                      {applyError && (
                        <p className="text-system-red mt-2" style={{ fontSize: 13 }}>
                          {applyError}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-2 mt-3">
                        <button
                          onClick={handleApplyNow}
                          disabled={!status.applyAvailable || applying}
                          className="btn primary sm"
                          type="button"
                        >
                          {applying ? "Starting…" : "Apply now"}
                        </button>
                        {!confirmSkip ? (
                          <button
                            onClick={() => setConfirmSkip(true)}
                            className="btn ghost sm"
                            type="button"
                          >
                            Skip this release
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={handleSkip}
                              disabled={skipping}
                              className="btn ghost sm text-system-red"
                              type="button"
                            >
                              {skipping ? "Skipping…" : "Confirm skip"}
                            </button>
                            <button
                              onClick={() => setConfirmSkip(false)}
                              className="btn ghost sm"
                              type="button"
                            >
                              Cancel
                            </button>
                          </>
                        )}
                        {!status.applyAvailable && (
                          <span
                            style={{ fontSize: 12, lineHeight: "16px", color: "var(--text-muted)" }}
                          >
                            Applying isn&rsquo;t available on this box — the host update
                            helper isn&rsquo;t provisioned, so releases are tracked but
                            never installed from here.
                          </span>
                        )}
                      </div>
                      {confirmSkip && (
                        <p
                          className="mt-2"
                          style={{ fontSize: 12, lineHeight: "16px", color: "var(--text-muted)" }}
                        >
                          A skipped release won&rsquo;t be offered again until a newer
                          one is published.
                        </p>
                      )}
                    </>
                  ) : (
                    <p
                      className="mt-2"
                      style={{ fontSize: 13, lineHeight: "18px", color: "var(--text-muted)" }}
                    >
                      Update in progress — services may restart and this page may briefly
                      lose its connection. It refreshes automatically every few seconds.
                    </p>
                  )}
                </div>
              </>
            )}

            {/* ── Update window / settings ── */}
            <Sect title="Update window" />
            <div className="card" style={{ padding: 16, marginBottom: 16 }}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {rawCron === null ? (
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="apply-window-time"
                      className="px-0.5"
                      style={{ fontSize: 12, color: "var(--text-muted)" }}
                    >
                      Apply updates daily at
                    </label>
                    <input
                      id="apply-window-time"
                      type="time"
                      value={applyTime}
                      onChange={(e) => setApplyTime(e.target.value)}
                      className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-input)",
                        color: "var(--text)",
                      }}
                    />
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="apply-window-cron"
                      className="px-0.5"
                      style={{ fontSize: 12, color: "var(--text-muted)" }}
                    >
                      Apply window (cron)
                    </label>
                    <input
                      id="apply-window-cron"
                      value={rawCron}
                      onChange={(e) => setRawCron(e.target.value)}
                      className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors font-mono"
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-input)",
                        color: "var(--text)",
                      }}
                    />
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <span className="px-0.5" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Channel
                  </span>
                  <span
                    className="w-full px-3 py-2.5 flex items-center"
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-input)",
                      color: "var(--text-muted)",
                    }}
                  >
                    {status.settings.channel}
                  </span>
                </div>
              </div>

              <label
                htmlFor="auto-apply"
                className="flex items-start gap-2.5 mt-3 cursor-pointer"
              >
                <input
                  id="auto-apply"
                  type="checkbox"
                  checked={autoApply}
                  onChange={(e) => setAutoApply(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded-sm accent-accent"
                />
                <span
                  className="leading-snug"
                  style={{ fontSize: 13, color: "var(--text-muted)" }}
                >
                  Apply pending updates automatically during the window
                  <span
                    className="block mt-0.5"
                    style={{ fontSize: 12, lineHeight: "16px", color: "var(--text-muted)" }}
                  >
                    Off = updates are only tracked; you apply each one yourself from this
                    page.
                  </span>
                </span>
              </label>

              {settingsError && (
                <p className="text-system-red mt-3" style={{ fontSize: 13 }}>
                  {settingsError}
                </p>
              )}
              {settingsSavedAt && !settingsError && (
                <p
                  className="text-system-green mt-3 flex items-center gap-1"
                  style={{ fontSize: 13 }}
                >
                  <Check size={14} /> Saved
                </p>
              )}

              <div className="flex items-center gap-3 mt-4">
                <button
                  onClick={handleSaveSettings}
                  disabled={savingSettings}
                  className="btn primary sm"
                  type="button"
                >
                  {savingSettings ? "Saving…" : "Save"}
                </button>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  A changed window takes effect after the box&rsquo;s next restart.
                </span>
              </div>
            </div>

            {/* ── History ── */}
            <Sect title="History" />
            <div className="card" style={{ padding: 16 }}>
              {history && history.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full" style={{ fontSize: 12, lineHeight: "16px" }}>
                    <thead>
                      <tr className="text-left" style={{ color: "var(--text-muted)" }}>
                        <th className="font-medium pb-2 pr-4">Release</th>
                        <th className="font-medium pb-2 pr-4">Commit</th>
                        <th className="font-medium pb-2 pr-4">Status</th>
                        <th className="font-medium pb-2 pr-4">Detail</th>
                        <th className="font-medium pb-2">Tracked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((row) => (
                        <tr key={row.id} style={{ borderTop: "1px solid var(--card-bd)" }}>
                          <td className="py-2 pr-4" style={{ color: "var(--text)" }}>
                            {row.releaseTag ?? "—"}
                          </td>
                          <td className="py-2 pr-4">
                            <a
                              href={`${COMMIT_URL_BASE}${row.gitSha}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-accent"
                            >
                              {shortSha(row.gitSha)}
                            </a>
                          </td>
                          <td className="py-2 pr-4">
                            <Badge kind={STATUS_BADGE[row.status].kind}>
                              {STATUS_BADGE[row.status].label}
                            </Badge>
                          </td>
                          <td
                            className="py-2 pr-4 font-mono"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {row.failureReason ?? "—"}
                          </td>
                          <td className="py-2" style={{ color: "var(--text-muted)" }}>
                            {fmtDate(row.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p style={{ fontSize: 13, lineHeight: "18px", color: "var(--text-muted)" }}>
                  No releases have been tracked on this box yet. History fills in once
                  the update agent sees its first published release.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </ShellPage>
  );
}
