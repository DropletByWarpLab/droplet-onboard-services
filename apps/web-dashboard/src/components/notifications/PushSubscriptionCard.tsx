"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Bell, BellOff, Check, Loader2, Send } from "lucide-react";
import {
  fetchVapidPublicKey,
  registerPushSubscription,
  sendTestPush,
  unregisterPushSubscription,
} from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";

// WARP-294: track inline status messages with an explicit tone instead
// of inferring "is this red?" from a substring search of err.message.
// Untyped substring sniffing leaked the raw orchestrator string onto
// the screen whenever the error didn't include "fail" or "denied".
type MsgState = { text: string; tone: "success" | "error" } | null;

type Status = "checking" | "unsupported" | "denied" | "subscribed" | "ready" | "configured-off";

/**
 * VAPID public keys arrive base64url-encoded; pushManager.subscribe
 * needs a Uint8Array. The conversion is the standard MDN snippet.
 */
function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Web Push subscribe/unsubscribe/test card. Renders inside the
 * /cameras/notifications page above the per-camera prefs grid so the
 * operator hits the "give the browser push permission" affordance
 * before tuning what triggers it.
 *
 * State machine:
 *   - checking   → on mount, while we probe permission + service worker
 *   - unsupported → no Notification API or no PushManager (older
 *     browsers, secure-context-required-but-not-met edge cases)
 *   - denied      → permission was denied; can't recover without
 *     OS-level permission reset
 *   - configured-off → orchestrator returns 503 from /vapid-public-key
 *     because VAPID keys aren't set
 *   - ready       → permission granted but no active subscription
 *   - subscribed  → permission granted + active subscription on file
 */
export function PushSubscriptionCard() {
  const [status, setStatus] = useState<Status>("checking");
  const [busy, setBusy] = useState<"subscribe" | "unsubscribe" | "test" | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [msg, setMsg] = useState<MsgState>(null);

  useEffect(() => {
    void probe();
  }, []);

  async function probe() {
    setStatus("checking");
    setMsg(null);
    if (
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      !("Notification" in window) ||
      !("PushManager" in window)
    ) {
      setStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    // Probe the orchestrator — 503 means VAPID isn't configured, which
    // is its own state (not a transient error).
    try {
      await fetchVapidPublicKey();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Treat "not configured" as its own state (a config gap, not an
      // error to retry). Everything else routes through the helper.
      if (message.includes("not configured")) {
        setStatus("configured-off");
        return;
      }
      setMsg({ text: translateError(e, "push"), tone: "error" });
    }
    // Already subscribed?
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        setEndpoint(sub.endpoint);
        setStatus("subscribed");
        return;
      }
    } catch {
      /* best-effort */
    }
    setStatus("ready");
  }

  async function handleSubscribe() {
    setBusy("subscribe");
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setStatus(perm === "denied" ? "denied" : "ready");
        return;
      }
      const reg =
        (await navigator.serviceWorker.getRegistration()) ??
        (await navigator.serviceWorker.register("/sw.js"));
      // Wait until the SW is the active controller — pushManager
      // refuses to subscribe against a registration that hasn't
      // installed yet.
      if (!reg.active) await navigator.serviceWorker.ready;

      const publicKey = await fetchVapidPublicKey();
      // Cast to BufferSource — newer TS lib.dom typings narrowed
      // applicationServerKey to BufferSource which doesn't accept the
      // generic Uint8Array<ArrayBufferLike> our helper returns. The
      // underlying byte sequence is what pushManager.subscribe wants;
      // the cast is correctness-preserving.
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      await registerPushSubscription(sub);
      setEndpoint(sub.endpoint);
      setStatus("subscribed");
      setMsg({ text: "Push notifications enabled.", tone: "success" });
    } catch (e) {
      setMsg({ text: translateError(e, "push"), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleUnsubscribe() {
    setBusy("unsubscribe");
    setMsg(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const ep = sub.endpoint;
        await sub.unsubscribe();
        await unregisterPushSubscription(ep);
      }
      setEndpoint(null);
      setStatus("ready");
      setMsg({ text: "Push notifications disabled.", tone: "success" });
    } catch (e) {
      setMsg({ text: translateError(e, "push"), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    setBusy("test");
    setMsg(null);
    try {
      const r = await sendTestPush();
      if (r.sent === 0) {
        setMsg({
          text: "Test queued — but no active subscription. Re-subscribe?",
          tone: "error",
        });
      } else {
        setMsg({
          text: `Test sent (${r.sent} subscription${r.sent === 1 ? "" : "s"}). Check your OS notification tray.`,
          tone: "success",
        });
      }
    } catch (e) {
      setMsg({ text: translateError(e, "push"), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  // Render
  if (status === "checking") {
    return (
      <div className="card p-4 mb-4 flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
        <Loader2 size={14} className="animate-spin" />
        <span className="type-caption-1">Checking push status…</span>
      </div>
    );
  }
  if (status === "unsupported") {
    return (
      <div className="card p-4 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle size={14} className="text-system-orange" />
          <h3 className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
            Push not supported here
          </h3>
        </div>
        <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          This browser doesn&apos;t support the Web Push API. Open the
          dashboard in a recent Chrome, Firefox, Edge, or Safari (16.4+).
        </p>
      </div>
    );
  }
  if (status === "configured-off") {
    return (
      <div className="card p-4 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle size={14} className="text-system-orange" />
          <h3 className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
            Push not configured
          </h3>
        </div>
        <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          The orchestrator has no VAPID keys. Restart it once and look for the
          generated keys in the orchestrator log, then pin them in{" "}
          <span className="font-mono">.env</span> as{" "}
          <span className="font-mono">VAPID_PUBLIC_KEY</span> +{" "}
          <span className="font-mono">VAPID_PRIVATE_KEY</span>.
        </p>
      </div>
    );
  }
  if (status === "denied") {
    return (
      <div className="card p-4 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <BellOff size={14} className="text-system-red" />
          <h3 className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
            Notifications blocked
          </h3>
        </div>
        <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          You denied notification permission for this site. Re-enable it in
          your browser&apos;s site settings to receive push alerts.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-4 mb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {status === "subscribed" ? (
              <Check size={14} style={{ color: "var(--success)" }} />
            ) : (
              <Bell size={14} style={{ color: "var(--text-muted)" }} />
            )}
            <h3 className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
              {status === "subscribed"
                ? "Push notifications on"
                : "Push notifications off"}
            </h3>
          </div>
          <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
            {status === "subscribed"
              ? "This browser will get push alerts for any camera + label combination toggled below."
              : "Enable to receive OS-level push for the events toggled below — works even when the dashboard isn't focused."}
          </p>
          {msg && (
            <p
              className={`type-caption-1 mt-2 ${msg.tone === "error" ? "text-system-red" : ""}`}
              style={msg.tone === "error" ? undefined : { color: "var(--success)" }}
            >
              {msg.text}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          {status === "subscribed" ? (
            <>
              <button
                onClick={handleTest}
                disabled={!!busy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg type-caption-1 disabled:opacity-50 bg-[var(--brand-subtle)] text-[var(--brand)]"
              >
                {busy === "test" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Send size={12} />
                )}
                Send test
              </button>
              <button
                onClick={handleUnsubscribe}
                disabled={!!busy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg type-caption-1 disabled:opacity-50 bg-[var(--brand-subtle)] text-[var(--brand)]"
              >
                {busy === "unsubscribe" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <BellOff size={12} />
                )}
                Disable
              </button>
            </>
          ) : (
            <button
              onClick={handleSubscribe}
              disabled={!!busy}
              className="btn primary type-subheadline disabled:opacity-50"
            >
              {busy === "subscribe" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Bell size={14} />
              )}
              Enable push
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
