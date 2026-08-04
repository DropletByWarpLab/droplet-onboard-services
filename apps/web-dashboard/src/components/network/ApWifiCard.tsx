"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  RadioTower,
  Wifi,
} from "lucide-react";
import {
  confirmNetworkCommand,
  fetchApWifi,
  fetchNetworkOperation,
  setApWifi,
  type ApWifiStatus,
} from "@/lib/api";

/**
 * Access-point Wi-Fi (WARP-1712 · Droplet Design System · Network · Wi-Fi).
 *
 * The founder's ask: the access point should be a controllable part of the
 * network, not just another device on it — its network name and password
 * driven from the Network tab and always in agreement with the Coverage
 * Extenders card.
 *
 * This card is that control, and it is deliberately used in BOTH places. It
 * keys its SWR read on `/api/network/wifi/ap`, so mounting it twice shares
 * one cache entry: the two surfaces literally cannot show different names,
 * and a save in one revalidates the other. Nothing is cached client-side
 * beyond that — the orchestrator dials the AP on every read, so the name here
 * is whatever the AP's uci actually says.
 *
 * Honesty fork (the UpnpCard / BandSteeringCard contract): with no approved
 * Droplet AP online it shows a calm read-only "not available" line, never a
 * fake form.
 *
 * Tiering mirrors the router's Wi-Fi form exactly:
 *   * a name-only save is Tier 1 and applies immediately;
 *   * a save that includes a password is Tier 2 — the orchestrator answers
 *     202 + a token and the Save click IS the consent, same auto-confirm the
 *     setup wizard uses — then we poll the routing operation for the
 *     apply-vs-rollback outcome.
 *
 * The passphrase is revealed on request rather than hidden behind ssh: the AP
 * mints a per-unit one at first boot (/etc/droplet/wifi-psk) and an operator
 * has no other way to read it.
 */

/** Mirrors services/routing/main.py `_validate_ap_wireless`. */
const SSID_MAX_BYTES = 32;
const PSK_MIN = 8;
const PSK_MAX = 63;

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "applied"; ssid: string | null; fiveGhzSsid: string | null }
  | { kind: "error"; message: string };

function ssidByteLength(value: string): number {
  // The 802.11 SSID element is 32 OCTETS — a 32-character name with any
  // non-ASCII in it overflows it and the AP's hostapd refuses the config.
  return new TextEncoder().encode(value).length;
}

export function ApWifiCard() {
  const { data, isLoading, mutate } = useSWR<ApWifiStatus>(
    "/api/network/wifi/ap",
    fetchApWifi,
    { refreshInterval: 30000 },
  );

  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const supported = data?.supported ?? false;
  const liveSsid = data?.ssid ?? "";
  const liveKey = data?.key ?? "";

  // Seed the inputs from the AP once, and re-seed whenever the AP's own
  // values change while the operator isn't mid-edit. Never clobber typing.
  useEffect(() => {
    if (dirty) return;
    setSsid(liveSsid);
    setPassword(liveKey);
  }, [liveSsid, liveKey, dirty]);

  function validate(): string | null {
    const name = ssid.trim();
    if (!name) return "Enter a network name (SSID).";
    const bytes = ssidByteLength(name);
    if (bytes > SSID_MAX_BYTES) {
      return `Network name (SSID) must be ${SSID_MAX_BYTES} characters or fewer.`;
    }
    if (password.length < PSK_MIN)
      return `Wi-Fi password must be at least ${PSK_MIN} characters.`;
    if (password.length > PSK_MAX)
      return `Wi-Fi password must be ${PSK_MAX} characters or fewer.`;
    return null;
  }

  /** Poll the routing operation until terminal. ~70s cap (safe_apply 60s + slack). */
  async function pollOperation(operationId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (op.state === "rejected") {
        throw new Error(
          op.reason ??
            "The access point didn't accept that change, so nothing was changed.",
        );
      }
      if (op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(
          op.reason ?? "The change didn't take, so the access point reverted it.",
        );
      }
      if (Date.now() - startedAt > 70_000) {
        throw new Error("Timed out waiting for the access point.");
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  async function handleSave() {
    const invalid = validate();
    if (invalid) {
      setStatus({ kind: "error", message: invalid });
      return;
    }
    const name = ssid.trim();
    // Only send what actually changed. A name-only save stays Tier 1 (no
    // confirm round-trip) instead of being dragged to Tier 2 by re-sending
    // the passphrase we just read back off the AP.
    const body: { ssid?: string; key?: string } = {};
    if (name !== liveSsid) body.ssid = name;
    if (password !== liveKey) body.key = password;
    if (body.ssid === undefined && body.key === undefined) {
      setStatus({ kind: "applied", ssid: liveSsid, fiveGhzSsid: data?.fiveGhzSsid ?? null });
      setDirty(false);
      return;
    }

    setStatus({ kind: "saving" });
    try {
      const result = await setApWifi(body);
      let operationId = result.operationId ?? null;
      if (
        result.status === "confirmation_required" &&
        result.confirmationToken &&
        result.operation
      ) {
        const confirmed = await confirmNetworkCommand(
          result.confirmationToken,
          result.operation,
        );
        operationId = confirmed.operationId ?? null;
      }
      if (operationId) await pollOperation(operationId);
      const fresh = await mutate();
      setDirty(false);
      setStatus({
        kind: "applied",
        ssid: result.ssid ?? fresh?.ssid ?? name,
        fiveGhzSsid: result.fiveGhzSsid ?? fresh?.fiveGhzSsid ?? null,
      });
    } catch (e) {
      setStatus({
        kind: "error",
        message:
          e instanceof Error && e.message.trim().length > 0
            ? e.message
            : "Couldn't update the access point's Wi-Fi. Please try again.",
      });
      await mutate();
    }
  }

  const saving = status.kind === "saving";

  return (
    <div className="card">
      <div className="flex items-start gap-3 mb-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "var(--card-inner)", color: "var(--text-muted)" }}
        >
          <RadioTower size={18} aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="type-headline" style={{ color: "var(--text)" }}>
            Access point Wi-Fi
          </h3>
          <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
            {supported
              ? "The network name and password your coverage extender broadcasts. Saving restarts its radios, so devices on it reconnect."
              : "Not available — this needs an approved Droplet access point that's online."}
          </p>
        </div>
      </div>

      {!supported ? null : (
        <>
          {data?.inSync === false && (
            <div
              role="alert"
              className="mb-3 flex items-start gap-2 type-caption-1 text-[color:var(--text)] bg-system-orange/10 rounded-sm px-3 py-2"
            >
              <AlertTriangle
                size={14}
                className="mt-0.5 flex-shrink-0 text-system-orange"
                aria-hidden="true"
              />
              <span>
                Your access points aren&apos;t all broadcasting the same network
                name right now. Saving here will set them all to the same one.
              </span>
            </div>
          )}

          <div className="space-y-4 max-w-md">
            <div>
              <label
                htmlFor="ap-wifi-ssid"
                className="type-subheadline block mb-1.5"
                style={{ color: "var(--text-muted)" }}
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
                  id="ap-wifi-ssid"
                  type="text"
                  value={ssid}
                  onChange={(e) => {
                    setDirty(true);
                    setSsid(e.target.value);
                  }}
                  placeholder="Droplet"
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors pl-10"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                  maxLength={SSID_MAX_BYTES}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={saving || isLoading}
                />
              </div>
              {data?.fiveGhzSsid && data.fiveGhzSsid !== data.ssid ? (
                <p
                  className="type-caption-1 mt-1.5"
                  style={{ color: "var(--text-muted)" }}
                >
                  Band steering is off, so the 5 GHz network is named{" "}
                  <span style={{ color: "var(--text)" }}>{data.fiveGhzSsid}</span>.
                </p>
              ) : null}
            </div>

            <div>
              <label
                htmlFor="ap-wifi-password"
                className="type-subheadline block mb-1.5"
                style={{ color: "var(--text-muted)" }}
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
                  id="ap-wifi-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setDirty(true);
                    setPassword(e.target.value);
                  }}
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
                  disabled={saving || isLoading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={
                    showPassword ? "Hide Wi-Fi password" : "Show Wi-Fi password"
                  }
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)] transition-colors duration-200 hover:text-[color:var(--text)]"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={saving || isLoading}
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
              <span>
                Access point updated. Rejoin{" "}
                <span className="font-medium">{status.ssid}</span>
                {status.fiveGhzSsid && status.fiveGhzSsid !== status.ssid ? (
                  <>
                    {" "}
                    (or <span className="font-medium">{status.fiveGhzSsid}</span>{" "}
                    on 5 GHz)
                  </>
                ) : null}
                {" "}with the new password.
              </span>
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
        </>
      )}
    </div>
  );
}
