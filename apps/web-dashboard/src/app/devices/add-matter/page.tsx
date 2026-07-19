"use client";

/**
 * /devices/add-matter — Matter device onboarding flow.
 *
 * Three-state machine:
 *   scan  — show <MatterQrScanner /> (camera viewport + manual entry)
 *   commission — POST /api/matter/commission, show spinner
 *   done  — show name + category of the newly commissioned device,
 *           "Add another" + "Go to devices" buttons
 *
 * The commissioning step can take anywhere from 5s (Wi-Fi-only TP-Link
 * plug) to 30s (BLE-then-Wi-Fi commissioning of a Hue bridge). The
 * spinner explains what's happening at each phase so the customer
 * doesn't think it's stuck.
 *
 * On error we go back to the scan step with the error banner above
 * the viewport, preserving any manually-entered code so the customer
 * can correct a typo without re-typing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Lightbulb, Loader2 } from "lucide-react";
import { commissionMatterDevice, fetchMatterCapabilities } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import { BleUnavailableNotice } from "@/components/smart-home/BleUnavailableNotice";
import { commissioningPhaseCopy } from "./commissioning-copy";
import type { MatterCapabilities } from "@/lib/types";

// WARP-102: lazy-load the QR scanner. `@zxing/browser` + `@zxing/library`
// are ~200 KB minified each and not tree-shakeable (the decoder pulls a
// wasm binary). A static import would bake them into every dashboard
// page's bundle since the import graph reaches them transitively.
// `ssr: false` because the scanner needs `navigator.mediaDevices` which
// is undefined during server prerendering.
const MatterQrScanner = dynamic(
  () =>
    import("@/components/smart-home/MatterQrScanner").then(
      (m) => m.MatterQrScanner,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="card flex items-center justify-center py-8 type-footnote text-[var(--text-muted)]">
        Loading scanner…
      </div>
    ),
  },
);

type FlowState =
  | { phase: "scan"; error: string | null }
  | { phase: "commission"; pairingCode: string; startedAt: number }
  | { phase: "done"; nodeId: string };

export default function AddMatterDevicePage() {
  const router = useRouter();
  const [state, setState] = useState<FlowState>({ phase: "scan", error: null });
  // In-flight guard for `handleCode`. We can't rely on `state.phase`
  // alone: the @zxing decode callback can fire a second time after
  // `stopCamera()` is called (frame already in flight inside the worker),
  // and the manual-entry submit can race the QR resolution. A ref is the
  // canonical pattern for "is there a commissioning request open right
  // now" — `state` is async, the ref isn't. We also pass
  // `disabled={state.phase === "commission"}` into the scanner so the
  // Commission button doesn't fire a duplicate manual submit on top of
  // an in-flight QR commission. See PR #233 review.
  const commissioningRef = useRef(false);

  // WARP-851/WARP-1035: commissioning capabilities. `null` = unknown
  // (probe in flight or failed) — show nothing rather than warn on a
  // guess. `bleCommissioning: false` = the box can only add devices
  // already on the home network; `wifiProvisioning: false` = BLE may
  // work but a BLE-paired device gets no Wi-Fi handed to it. Both get
  // an honest notice above the scanner instead of letting the customer
  // retry a device that can never finish.
  const [caps, setCaps] = useState<MatterCapabilities | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchMatterCapabilities();
        if (!cancelled) setCaps(result);
      } catch {
        // Capability unknown — leave the notices hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const bleAvailable = caps === null ? null : caps.bleCommissioning;
  // Absent field (pre-WARP-1035 orchestrator) reads as false — the copy
  // then simply doesn't promise a Wi-Fi handoff it can't verify.
  const wifiProvisioning = caps?.wifiProvisioning === true;
  // UX review (WARP-1035): the Wi-Fi handoff rides the BLE pairing, so
  // promising it (pre-flight copy, spinner phase) requires BOTH the BLE
  // transport and the plumbed PSK — wifiProvisioning alone would contradict
  // the WARP-851 notice on a box whose BLE adapter is down.
  const bleWifiPairing = bleAvailable === true && wifiProvisioning;

  const handleCode = useCallback(async (pairingCode: string) => {
    if (commissioningRef.current) return;
    commissioningRef.current = true;
    setState({ phase: "commission", pairingCode, startedAt: Date.now() });
    try {
      const result = await commissionMatterDevice(pairingCode);
      setState({ phase: "done", nodeId: result.nodeId });
    } catch (err) {
      const msg = translateError(err, "device");
      // Keep customer's manually-entered code in mind for retry — but
      // the textbox lives inside MatterQrScanner so we can't repopulate
      // without lifting state. For now, restart at scan with the error.
      setState({ phase: "scan", error: msg });
    } finally {
      commissioningRef.current = false;
    }
  }, []);

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      {/* Header w/ back link to /devices. WARP-1411: one line of lead copy,
          not three stacked paragraphs — the network detail moved under the
          card, where it's still findable but no longer costs above-the-fold
          space the pairing field needs. */}
      <div className="mb-5">
        <Link
          href="/devices"
          className="inline-flex items-center gap-1 type-footnote text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to devices
        </Link>
        <h1 className="type-title-2 font-bold text-[var(--text)] mt-2">
          Add a smart device
        </h1>
        <p className="type-subheadline text-[var(--text-muted)] mt-1">
          Anything that says <em>“Works with Matter”</em> — plugs, lights,
          switches.
        </p>
      </div>

      {state.phase === "scan" && (
        <>
          {state.error && (
            <CommissioningErrorBanner
              message={state.error}
              onDismiss={() => setState({ phase: "scan", error: null })}
            />
          )}
          {/* WARP-851: until the box can hear BLE devices (WARP-850),
              be honest about what scanning a code can actually add. */}
          {bleAvailable === false && <BleUnavailableNotice className="mb-4" />}
          {/* WARP-1035: BLE up but no AP PSK plumbed — a BLE-paired
              device would have no network to join. Same honesty rule. */}
          {bleAvailable === true && !wifiProvisioning && (
            <BleUnavailableNotice
              variant="no-wifi-provisioning"
              className="mb-4"
            />
          )}
          <div className="card p-5">
            <MatterQrScanner
              onResult={handleCode}
              disabled={state.phase !== "scan"}
            />
          </div>
          {/* WARP-1035: pre-flight network expectations, demoted below the
              card (WARP-1411). The user's phone/computer network was never
              the constraint — commissioning is box-side — so name the network
              that actually matters, and only promise the Droplet-Wi-Fi
              handoff when the capability says it works. */}
          <p className="type-footnote text-[var(--text-muted)] mt-3">
            {"The Droplet does the pairing — this device just needs to reach the dashboard. " +
              (bleWifiPairing
                ? `New devices pair over Bluetooth and join the Droplet's own Wi-Fi (“${caps?.apSsid ?? "Droplet"}”); devices already on your Wi-Fi are added in place.`
                : "Devices already on your Wi-Fi are added in place.")}
          </p>
        </>
      )}

      {state.phase === "commission" && (
        <CommissioningProgress
          startedAt={state.startedAt}
          bleWifiPairing={bleWifiPairing}
        />
      )}

      {state.phase === "done" && (
        <CommissioningSuccess
          nodeId={state.nodeId}
          onAddAnother={() => setState({ phase: "scan", error: null })}
          onGoToDevices={() => router.push("/devices")}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subviews
// ---------------------------------------------------------------------------

function CommissioningErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      className="mb-4 px-4 py-3 bg-system-red/10 border border-system-red/30 rounded-lg flex items-start gap-3"
      role="alert"
    >
      {/* WARP-856 (item 3): no prefix — the curated messages are complete
          sentences ("Couldn't find the device…"), so a "Couldn't commission:"
          label doubled the copy and "commission" is installer jargon. */}
      <p className="type-footnote text-system-red flex-1">{message}</p>
      <button
        onClick={onDismiss}
        className="type-footnote text-system-red hover:underline"
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * Live progress view during the 5-30s commissioning window. We don't
 * have real progress signals (matter.js emits state events but not a
 * percentage), so we show what's *likely* happening based on elapsed
 * time. Beats a static spinner that makes the customer think it's hung.
 * WARP-1035: the "Sharing Wi-Fi credentials…" claim is gated on the
 * wifiProvisioning capability — see commissioning-copy.ts.
 */
function CommissioningProgress({
  startedAt,
  bleWifiPairing,
}: {
  startedAt: number;
  /** BLE transport up AND AP PSK plumbed — only then can the box
   *  actually hand Wi-Fi credentials to the device. */
  bleWifiPairing: boolean;
}) {
  const [elapsedS, setElapsedS] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsedS(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [startedAt]);

  // Approximate phases, each ~5-10s on typical Wi-Fi devices.
  const phase = commissioningPhaseCopy(elapsedS, bleWifiPairing);

  return (
    <div className="card p-6 text-center space-y-3">
      <Loader2
        size={32}
        className="mx-auto text-[var(--brand)] animate-spin"
        aria-hidden="true"
      />
      <p className="type-callout font-medium text-[var(--text)]">{phase}</p>
      <p className="type-footnote text-[var(--text-muted)]">
        Don't unplug the device. This usually takes 10–30 seconds.
      </p>
      <p className="type-caption-1 text-[var(--text-muted)] font-mono">
        {elapsedS}s elapsed
      </p>
    </div>
  );
}

function CommissioningSuccess({
  nodeId,
  onAddAnother,
  onGoToDevices,
}: {
  nodeId: string;
  onAddAnother: () => void;
  onGoToDevices: () => void;
}) {
  return (
    <div className="card p-6 text-center space-y-4">
      <CheckCircle2
        size={48}
        className="mx-auto text-system-green"
        aria-hidden="true"
      />
      <div>
        <h2 className="type-title-3 font-bold text-[var(--text)]">
          Device added
        </h2>
        <p className="type-subheadline text-[var(--text-muted)] mt-2">
          Your new Matter device is ready. You can control it from the dashboard
          or by asking the assistant —{" "}
          <em>“turn it off”</em>.
        </p>
        <p className="type-caption-1 text-[var(--text-muted)] mt-3 font-mono">
          node {nodeId}
        </p>
      </div>
      <div className="flex justify-center gap-3 pt-2">
        <button
          onClick={onAddAnother}
          className="btn"
        >
          <Lightbulb size={14} className="inline -mt-0.5 mr-1" aria-hidden="true" />
          Add another
        </button>
        <button
          onClick={onGoToDevices}
          className="btn primary"
        >
          Go to devices
        </button>
      </div>
    </div>
  );
}
