"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Lock,
  Wifi,
} from "lucide-react";
import {
  confirmNetworkCommand,
  fetchCurrentWifi,
  fetchNetworkOperation,
  RouterStatusError,
  routerUnreachableNotice,
  setWifiPassword,
  setWifiSsid,
} from "@/lib/api";
import type { CurrentWifi } from "@/lib/types";

/** Under the /api/network prefix, so the tab's Refresh sweep covers it.
 *  Exported (WARP-1723) so WifiTab keys its source-split read on the SAME SWR
 *  entry — shared cache, no second fetch. */
export const CURRENT_WIFI_KEY = "/api/network/wifi/current";

/**
 * Issue #12 — editable Wi-Fi provisioning for the Network → WiFi tab.
 *
 * A user who skipped the optional Home Wi-Fi step during onboarding had no UI
 * path to set the SSID/password later — the WiFi tab was a scanner + a "use the
 * API or AI chat" placeholder. This form gives the Network page the same write
 * path the setup wizard's InternetStep already drives:
 *
 *   setWifiSsid (Tier 1, applies immediately)
 *   → setWifiPassword (Tier 2 — the radio restart drops every device, so the
 *     orchestrator may answer 202 `confirmation_required`)
 *   → confirmNetworkCommand (the Save click IS the consent — auto-confirmed)
 *   → poll the operation until it leaves `pending` (applied / rolled_back).
 *
 * Validation mirrors services/routing/schemas.py (SSID 1–32, PSK 8–63), same as
 * InternetStep, so the box never sees a payload hostapd would reject. Error
 * classification is the wizard's calm ladder: an unreachable router → soft amber
 * "try again" notice; a 4xx validation refusal carrying an actionable message →
 * that message in red; a UCI safe-apply revert (plain Error w/ op.reason) → the
 * reason in red; anything else → a calm generic failure line.
 */

/** Mirrors services/routing/schemas.py SetSsidRequest / SetPasswordRequest. */
const SSID_MAX = 32;
const PSK_MIN = 8;
const PSK_MAX = 63;

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "applied" }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string };

export function WifiSettingsForm() {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // WARP-1714: seed the form from the Wi-Fi actually being broadcast. Both
  // fields used to start empty and never hydrate, so the card couldn't tell you
  // your own network name and the password you set visibly "went away" on every
  // reload.
  //
  // The orchestrator resolves WHERE that Wi-Fi lives, because it differs by
  // deployment shape: on the edge-router shape this Droplet's own radio hosts
  // nothing (`interfaces: []`, uci carries only a disabled placeholder) and the
  // household SSID exists only on the approved access point.
  //
  // A background poll must never overwrite what the user is halfway through
  // typing. `dirty` latches on the first edit and holds the fields until the
  // next successful save; `lastSynced` keeps the adopt idempotent so an
  // unchanged poll doesn't re-set state (or fight the reveal toggle).
  const { data: live, mutate: refreshLive } = useSWR<CurrentWifi>(
    CURRENT_WIFI_KEY,
    fetchCurrentWifi,
    { refreshInterval: 30_000 },
  );
  const dirty = useRef(false);
  const lastSynced = useRef<string | null>(null);

  useEffect(() => {
    if (!live?.ssid || dirty.current) return;
    const fingerprint = `${live.source} ${live.ssid} ${live.key ?? ""}`;
    if (lastSynced.current === fingerprint) return;
    lastSynced.current = fingerprint;
    setSsid(live.ssid);
    setPassword(live.key ?? "");
  }, [live?.source, live?.ssid, live?.key]);

  function editSsid(next: string) {
    dirty.current = true;
    setSsid(next);
  }

  function editPassword(next: string) {
    dirty.current = true;
    setPassword(next);
  }

  function validate(): string | null {
    const name = ssid.trim();
    if (!name) return "Enter a network name (SSID).";
    if (name.length > SSID_MAX)
      return `Network name (SSID) must be ${SSID_MAX} characters or fewer.`;
    if (password.length < PSK_MIN)
      return `Wi-Fi password must be at least ${PSK_MIN} characters.`;
    if (password.length > PSK_MAX)
      return `Wi-Fi password must be ${PSK_MAX} characters or fewer.`;
    return null;
  }

  /** Poll the operation record until terminal. ~70s cap (safe-apply 60s + slack),
   *  matching InternetStep.pollOperation / the page's WARP-40 loop. */
  async function pollOperation(operationId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (op.state === "rejected") {
        // Neutral no-change terminal (routing 4xx): the router refused the
        // request before any change was made. Terminate with the reason — never
        // mark it applied, and don't loop into a misleading timeout.
        throw new Error(
          op.reason ??
            "The router didn't accept that Wi-Fi change, so nothing was changed.",
        );
      }
      if (op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(
          op.reason ??
            "The Wi-Fi change didn't take. Re-check the network and try again.",
        );
      }
      if (Date.now() - startedAt > 70_000) {
        throw new Error(
          "Timed out waiting for the router to apply the Wi-Fi change.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async function applyWifi(name: string) {
    await setWifiSsid(name);
    const pwResult = await setWifiPassword(password);
    if (
      pwResult.status === "confirmation_required" &&
      pwResult.confirmationToken &&
      pwResult.operation
    ) {
      const { operationId } = await confirmNetworkCommand(
        pwResult.confirmationToken,
        pwResult.operation,
      );
      if (operationId) {
        await pollOperation(operationId);
      }
    }
  }

  async function handleSave() {
    const v = validate();
    if (v) {
      setStatus({ kind: "error", message: v });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      await applyWifi(ssid.trim());
      // The save landed, so the router is now the authority again — release the
      // fields back to live values (and let the next poll confirm them) instead
      // of pinning the form to what the user typed.
      dirty.current = false;
      lastSynced.current = null;
      setStatus({ kind: "applied" });
      // Pull the new value back from the box rather than trusting the echo.
      void refreshLive();
    } catch (e) {
      // Same calm ladder as InternetStep, but the "do it later" destination is
      // the page we're already on — so an unreachable router becomes a plain
      // "try again shortly" notice rather than a redirect.
      if (routerUnreachableNotice(e, "Network")) {
        setStatus({
          kind: "notice",
          message:
            "Your router isn't reachable right now — try again in a moment.",
        });
      } else if (
        e instanceof RouterStatusError &&
        (e.status === 400 || e.status === 422) &&
        e.message.trim().length > 0
      ) {
        // Customer-fixable validation refusal from the host AP — show it.
        setStatus({ kind: "error", message: e.message });
      } else if (
        // A UCI safe-apply revert surfaces as a PLAIN Error whose message is the
        // router's revert reason (pollOperation throws new Error(op.reason)).
        !(e instanceof RouterStatusError) &&
        e instanceof Error &&
        e.message.trim().length > 0
      ) {
        setStatus({ kind: "error", message: e.message });
      } else {
        setStatus({
          kind: "notice",
          message:
            "Couldn't set up Wi-Fi right now. Please try again in a moment.",
        });
      }
    }
  }

  const saving = status.kind === "saving";

  return (
    <div className="card">
      <h3 className="type-headline text-[color:var(--text)] mb-1">WiFi Settings</h3>
      <p className="type-subheadline text-[color:var(--text-muted)] mb-4">
        Name the Wi-Fi network your Droplet broadcasts and set its password.
        Saving restarts the radio, which briefly disconnects every device —
        including this one. Rejoin with the new name and password.
      </p>

      {/* WARP-1714: when we can't read the current Wi-Fi, SAY SO. Empty fields
          that mean "we couldn't ask" are indistinguishable from ones that mean
          "no Wi-Fi is set" — and on the edge-router shape, with no AP
          credential provisioned, the honest answer is the actionable one. */}
      {live && !live.ssid && (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 type-footnote text-[color:var(--text)] bg-[var(--card-inner)] rounded-sm px-3 py-2"
        >
          <Info
            size={14}
            className="mt-0.5 flex-shrink-0 text-[color:var(--text-muted)]"
            aria-hidden="true"
          />
          <span>{live.detail}</span>
        </div>
      )}

      <div className="space-y-4 max-w-md">
        <div>
          <label
            htmlFor="wifi-ssid"
            className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
          >
            Network name (SSID)
          </label>
          <div className="relative">
            <Wifi
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]"
              aria-hidden="true"
            />
            <input
              id="wifi-ssid"
              type="text"
              value={ssid}
              onChange={(e) => editSsid(e.target.value)}
              placeholder="Studio Fotonia"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors pl-10"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              maxLength={SSID_MAX}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="wifi-password"
            className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
          >
            Wi-Fi password
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]"
              aria-hidden="true"
            />
            <input
              id="wifi-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => editPassword(e.target.value)}
              placeholder="Wi-Fi password"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors pl-10 pr-10"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              maxLength={PSK_MAX}
              autoComplete="off"
              disabled={saving}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide Wi-Fi password" : "Show Wi-Fi password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)] transition-colors duration-200 hover:text-[color:var(--text)]"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="btn primary"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          {saving ? "Saving…" : "Save Wi-Fi settings"}
        </button>
      </div>

      {status.kind === "applied" && (
        <div
          role="status"
          className="mt-4 flex items-start gap-2 type-footnote text-[color:var(--text)] bg-system-green/10 rounded-sm px-3 py-2"
        >
          <CheckCircle2
            size={14}
            className="mt-0.5 flex-shrink-0 text-system-green"
            aria-hidden="true"
          />
          <span>Wi-Fi updated. Rejoin with the new name and password.</span>
        </div>
      )}

      {status.kind === "notice" && (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex items-start gap-2 type-footnote text-[color:var(--text)] bg-system-orange/10 rounded-sm px-3 py-2"
        >
          <AlertCircle
            size={14}
            className="mt-0.5 flex-shrink-0 text-system-orange"
            aria-hidden="true"
          />
          <span>{status.message}</span>
        </div>
      )}

      {status.kind === "error" && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{status.message}</span>
        </div>
      )}
    </div>
  );
}
