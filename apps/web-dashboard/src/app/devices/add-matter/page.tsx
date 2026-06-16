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
      <div className="dp-card flex items-center justify-center min-h-[280px] type-footnote text-label-secondary">
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

  // WARP-851: BLE-commissioning capability. `null` = unknown (probe in
  // flight or failed) — show nothing rather than warn on a guess.
  // `false` = the box can only add devices already on the home network;
  // say so above the scanner instead of letting the customer retry a
  // Bluetooth-only device forever.
  const [bleAvailable, setBleAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const caps = await fetchMatterCapabilities();
        if (!cancelled) setBleAvailable(caps.bleCommissioning);
      } catch {
        // Capability unknown — leave the notice hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      {/* Header w/ back link to /devices */}
      <div className="mb-6">
        <Link
          href="/devices"
          className="inline-flex items-center gap-1 type-footnote text-label-secondary hover:text-label-primary"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to devices
        </Link>
        <h1 className="type-largeTitle font-bold text-label-primary mt-2">
          Add a smart device
        </h1>
        <p className="type-subheadline text-label-secondary mt-1">
          Scan the QR code on the device's packaging or label. Most plugs,
          lights, and switches that say{" "}
          <em>“Works with Matter”</em> on the box will work.
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
          <MatterQrScanner
            onResult={handleCode}
            disabled={state.phase !== "scan"}
          />
        </>
      )}

      {state.phase === "commission" && (
        <CommissioningProgress startedAt={state.startedAt} />
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
 */
function CommissioningProgress({ startedAt }: { startedAt: number }) {
  const [elapsedS, setElapsedS] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsedS(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [startedAt]);

  // Approximate phases, each ~5-10s on typical Wi-Fi devices.
  const phase =
    elapsedS < 5
      ? "Finding the device on your network…"
      : elapsedS < 15
        ? "Setting up secure pairing…"
        : elapsedS < 25
          ? "Sharing Wi-Fi credentials with the device…"
          : "Almost done — installing the device certificate…";

  return (
    <div className="bg-fill-quaternary border border-separator-default rounded-xl p-8 text-center space-y-4">
      <Loader2
        size={32}
        className="mx-auto text-system-blue animate-spin"
        aria-hidden="true"
      />
      <p className="type-callout font-medium text-label-primary">{phase}</p>
      <p className="type-footnote text-label-secondary">
        Don't unplug the device. This usually takes 10–30 seconds.
      </p>
      <p className="type-caption2 text-label-tertiary font-mono">
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
    <div className="bg-fill-quaternary border border-separator-default rounded-xl p-8 text-center space-y-5">
      <CheckCircle2
        size={48}
        className="mx-auto text-system-green"
        aria-hidden="true"
      />
      <div>
        <h2 className="type-title2 font-bold text-label-primary">
          Device added
        </h2>
        <p className="type-subheadline text-label-secondary mt-2">
          Your new Matter device is ready. You can control it from the dashboard
          or by asking the assistant —{" "}
          <em>“turn it off”</em>.
        </p>
        <p className="type-caption2 text-label-tertiary mt-3 font-mono">
          node {nodeId}
        </p>
      </div>
      <div className="flex justify-center gap-3 pt-2">
        <button
          onClick={onAddAnother}
          className="px-4 py-2 bg-fill-tertiary border border-separator-default rounded-lg type-callout text-label-primary hover:bg-fill-secondary"
        >
          <Lightbulb size={14} className="inline -mt-0.5 mr-1" aria-hidden="true" />
          Add another
        </button>
        <button
          onClick={onGoToDevices}
          className="px-4 py-2 bg-system-blue text-white rounded-lg type-callout font-medium hover:bg-system-blue/90"
        >
          Go to devices
        </button>
      </div>
    </div>
  );
}
