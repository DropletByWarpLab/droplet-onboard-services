"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  KeyRound,
  Lightbulb,
  Radar,
  ThermometerSun,
  ToggleRight,
  Wifi,
} from "lucide-react";
import {
  commissionMatterDevice,
  fetchMatterCapabilities,
  fetchMatterDevices,
} from "@/lib/api";
import type { MatterDevice, MatterGrouped } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { ScrollRegion } from "@/components/setup/ScrollRegion";
import { BleUnavailableNotice } from "@/components/smart-home/BleUnavailableNotice";

const CATEGORY_ICONS: Record<string, typeof Lightbulb> = {
  light: Lightbulb,
  switch: ToggleRight,
  climate: ThermometerSun,
  sensor: Radar,
};

// Polling bound constants. Pulled out so tests can reference them by
// value and future tweaks live in one place. (Carried over verbatim
// from the pre-refactor inline implementation.)
const DOWNSHIFT_AFTER_IDLE_SEC = 60;
const STOP_AFTER_TOTAL_SEC = 300;

/**
 * Matter smart-home device discovery.
 *
 * Owns the polling state machine that landed in WARP-298 / WARP-302:
 *
 *   - Mount → start at 3s "active" cadence.
 *   - After 60s with no new device → drop to 10s, surface the
 *     "make sure it's in pairing mode" hint (data-testid
 *     `discovery-downshift-hint`).
 *   - After 5min total → stop polling entirely (data-testid
 *     `discovery-stopped`) and offer a "Scan again" button that re-arms
 *     `startDiscovery` (must carry the `dp-btn-secondary` token — tests
 *     assert on that class for tap-target consistency).
 *   - Unmount cleans both intervals.
 *
 * Behaviour identical to the pre-refactor inline implementation in
 * `app/setup/page.tsx`. The page tests in
 * `__tests__/setup.discovery-bounds.test.tsx` exercise every transition
 * with fake timers; they must continue to pass without modification.
 *
 * `onContinue` is invoked when the customer taps either the primary
 * "Continue" button or the "Skip for now" link — the page-level wizard
 * is responsible for advancing to whichever step comes next (currently
 * Cameras in the extended flow; Done in the base flow).
 */
export function DiscoveryStep({
  onContinue,
}: {
  onContinue: (discoveredCount: number) => void;
}) {
  const [discoveredDevices, setDiscoveredDevices] = useState<MatterDevice[]>(
    [],
  );
  const [isScanning, setIsScanning] = useState(false);
  const [scanSeconds, setScanSeconds] = useState(0);
  // WARP-298: polling lifecycle. Starts "active" at 3s intervals; if 60s
  // pass with no new devices we downshift to 10s + show a hint. At 5min
  // total elapsed we stop entirely so the dashboard isn't pegging the
  // Matter controller forever while the user wanders off.
  const [scanPhase, setScanPhase] = useState<
    "active" | "downshifted" | "stopped"
  >("active");
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const seenIdsRef = useRef<Set<string>>(new Set());
  const lastFoundAtSecRef = useRef<number>(0);

  // WARP-102 follow-up: inline manual Matter pairing-code entry. The standalone
  // QR scanner lives at /devices/add-matter, but navigating there mid-wizard
  // bounces the customer back (AuthGate guards every non-setup route while the
  // appliance is unclaimed) — which read as "the QR option breaks setup and
  // loops". The pairing code printed on the device / its packaging / under the
  // QR is the same value the QR encodes, so a text field covers both the "QR
  // handy" and "written code" cases without ever leaving setup.
  const [manualCode, setManualCode] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualOk, setManualOk] = useState<string | null>(null);

  // WARP-851: BLE-commissioning capability. `null` = unknown (probe
  // failed or still in flight) — show nothing rather than warn on a
  // guess. `false` = the box can only add devices already on the home
  // network, so say so near the pairing-code input instead of letting
  // the customer retry a Bluetooth-only device forever.
  const [bleAvailable, setBleAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const caps = await fetchMatterCapabilities();
        if (!cancelled) setBleAvailable(caps.bleCommissioning);
      } catch {
        // Capability unknown (controller booting / transient failure) —
        // leave the notice hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Read latest scanSeconds inside pollOnce via a ref so the callback's
  // identity stays stable across re-renders (we don't want startDiscovery
  // re-firing every second).
  const scanSecondsRef = useRef(0);
  useEffect(() => {
    scanSecondsRef.current = scanSeconds;
  }, [scanSeconds]);

  // Single poll tick — shared by both the 3s "active" and 10s "downshifted"
  // intervals. Captures *new* devices, advances lastFoundAtSec when one
  // arrives.
  const pollOnce = useCallback(async () => {
    try {
      const grouped = await fetchMatterDevices();
      const allDevices = flattenGrouped(grouped);
      const newDevices: MatterDevice[] = [];
      for (const d of allDevices) {
        if (!seenIdsRef.current.has(d.nodeId)) {
          seenIdsRef.current.add(d.nodeId);
          newDevices.push(d);
        }
      }
      if (newDevices.length > 0) {
        setDiscoveredDevices((prev) => [...prev, ...newDevices]);
        // Reset the idle clock — fresh devices means there's reason to
        // believe more are coming.
        lastFoundAtSecRef.current = scanSecondsRef.current;
      }
    } catch {
      // Matter controller may still be booting — keep polling.
    }
  }, []);

  const startDiscovery = useCallback(() => {
    // WARP-302: defensively clear any pre-existing intervals before
    // re-arming. Without this, clicking "Scan again" overwrites the refs
    // with new setInterval handles while the old intervals keep firing —
    // scanSeconds advances at 2 Hz, the 5-min auto-stop fires at ~2:30,
    // and every subsequent click compounds the leak. pollRef is already
    // cleared at the stop transition, but timerRef was not; clear both
    // here for symmetry and safety.
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);

    setIsScanning(true);
    setScanSeconds(0);
    setScanPhase("active");
    seenIdsRef.current.clear();
    setDiscoveredDevices([]);
    lastFoundAtSecRef.current = 0;

    // Poll for devices every 3 seconds (active phase).
    pollRef.current = setInterval(pollOnce, 3000);

    // Count seconds for UX.
    timerRef.current = setInterval(() => {
      setScanSeconds((s) => s + 1);
    }, 1000);
  }, [pollOnce]);

  // WARP-298: transition between scan phases based on elapsed time +
  // last-found-at. Lives in its own effect so we never end up with two
  // overlapping intervals on a stale closure.
  useEffect(() => {
    if (!isScanning) return;

    // Total-elapsed stopper: cap the polling window. The user can still
    // continue manually; we just stop pegging the controller.
    if (scanSeconds >= STOP_AFTER_TOTAL_SEC && scanPhase !== "stopped") {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = undefined;
      }
      // WARP-302: also stop the 1-Hz scanSeconds ticker at the stop
      // transition. Without this the timer kept running between "stopped"
      // and a subsequent "Scan again" click, which then leaked the old
      // interval when startDiscovery re-armed timerRef. startDiscovery
      // now also defensively clears both refs on entry, but stopping
      // the ticker here is the right semantic — there's nothing to
      // count once polling has ceased.
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = undefined;
      }
      setScanPhase("stopped");
      return;
    }

    // Idle downshift: if nothing's been found for DOWNSHIFT_AFTER_IDLE_SEC,
    // drop to a 10s interval and surface a "make sure it's in pairing
    // mode" hint to the user.
    const idleFor = scanSeconds - lastFoundAtSecRef.current;
    if (
      scanPhase === "active" &&
      idleFor >= DOWNSHIFT_AFTER_IDLE_SEC &&
      scanSeconds < STOP_AFTER_TOTAL_SEC
    ) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(pollOnce, 10000);
      setScanPhase("downshifted");
    }
  }, [scanSeconds, scanPhase, isScanning, pollOnce]);

  // Auto-start on mount; clean up both intervals on unmount.
  useEffect(() => {
    startDiscovery();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [startDiscovery]);

  function handleFinish() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    setIsScanning(false);
    onContinue(discoveredDevices.length);
  }

  // Commission a device straight from the typed pairing code. Matter codes are
  // 11 digits (short) or 21 digits (long); strip the spaces/dashes people copy
  // off a label before validating. On success the active poll surfaces the new
  // device (seenIdsRef dedups), so we just nudge one immediate poll.
  async function handleManualAdd() {
    const code = manualCode.replace(/[\s-]/g, "");
    if (!/^(\d{11}|\d{21})$/.test(code)) {
      setManualOk(null);
      setManualError(
        "Enter the 11- or 21-digit pairing code from the device, its box, or under the QR label.",
      );
      return;
    }
    setManualError(null);
    setManualOk(null);
    setManualBusy(true);
    try {
      await commissionMatterDevice(code);
      setManualCode("");
      setManualOk("Device added — it'll show up in the list in a moment.");
      void pollOnce();
    } catch (e) {
      setManualError(
        e instanceof Error
          ? e.message
          : "Couldn't add that device. Double-check the code and try again.",
      );
    } finally {
      setManualBusy(false);
    }
  }

  return (
    <StepShell
      current="discovery"
      icon={
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 rounded-full bg-accent/10 animate-scan-pulse" />
          <div
            className="absolute inset-2 rounded-full bg-accent/20 animate-scan-pulse"
            style={{ animationDelay: "0.3s" }}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <Wifi size={28} className="text-accent" />
          </div>
        </div>
      }
      title="Discovering your devices"
      subtitle={
        discoveredDevices.length === 0
          ? "Scanning your network for smart home devices..."
          : `${discoveredDevices.length} device${
              discoveredDevices.length !== 1 ? "s" : ""
            } found`
      }
      primary={{ label: "Continue", onClick: handleFinish, showArrow: true }}
      skip={{ label: "Skip for now", onClick: handleFinish }}
    >
      {/* Discovered devices grid. WARP-820: the device list is unbounded, so
          it lives in a <ScrollRegion> (the wizard's single scroll surface) —
          the title, "N devices found" subtitle, and the CTA stay pinned in the
          StepShell while only this list scrolls. The bound is viewport-relative
          (was a fixed max-h-[320px]) so it shrinks on a short landscape phone. */}
      <ScrollRegion aria-label="Discovered devices" className="space-y-2 mb-8">
        {discoveredDevices.map((device, index) => {
          const Icon = CATEGORY_ICONS[device.category] || Wifi;
          return (
            <div
              key={device.nodeId}
              className="animate-device-appear flex items-center gap-3 dp-card !py-3"
              style={{ animationDelay: `${index * 80}ms` }}
            >
              <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                <Icon size={18} className="text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="type-subheadline text-label-primary truncate">
                  {device.name}
                </p>
                <p className="type-caption-1 text-label-tertiary capitalize">
                  {device.category.replace("_", " ")}
                </p>
              </div>
              <div className="w-2 h-2 rounded-full bg-system-green flex-shrink-0" />
            </div>
          );
        })}

        {/* Scanning placeholder rows */}
        {discoveredDevices.length === 0 && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex items-center gap-3 dp-card !py-3 opacity-30"
                style={{ animationDelay: `${i * 200}ms` }}
              >
                <div className="w-9 h-9 rounded-lg bg-surface-secondary animate-pulse" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-32 bg-surface-secondary rounded animate-pulse" />
                  <div className="h-2.5 w-20 bg-surface-secondary rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollRegion>

      {/* Scanning timer + lifecycle hints (WARP-298). */}
      {isScanning && scanPhase === "active" && (
        <p className="type-caption-1 text-label-quaternary text-center mb-4">
          Scanning... {scanSeconds}s
        </p>
      )}
      {isScanning && scanPhase === "downshifted" && (
        <div
          className="type-caption-1 text-label-tertiary text-center mb-4"
          data-testid="discovery-downshift-hint"
        >
          <p>Still scanning every 10s. Not seeing your device?</p>
          <p className="text-label-quaternary">
            Make sure it&apos;s in pairing mode.
          </p>
        </div>
      )}
      {scanPhase === "stopped" && (
        <div
          className="type-caption-1 text-label-tertiary text-center mb-4"
          data-testid="discovery-stopped"
        >
          <p>
            Stopped automatic scanning after 5 minutes. You can add devices
            manually from the Devices page later.
          </p>
          {/* WARP-302: give the user a way back to active scanning without
              reloading the setup flow. Re-arms startDiscovery, which resets
              scanPhase to "active" and re-mounts the 3s poll. dp-btn-secondary
              already enforces the 44px tap target and focus-visible ring, so
              no extra classes are needed. */}
          <button
            type="button"
            onClick={startDiscovery}
            className="dp-btn-secondary mt-3"
          >
            Scan again
          </button>
        </div>
      )}

      {/* WARP-102 follow-up — inline manual pairing-code entry. Replaces the
          link to the standalone /devices/add-matter scanner, which bounced the
          customer out of the wizard mid-setup (AuthGate guards non-setup routes
          while the appliance is unclaimed). The QR code on a Matter device
          encodes this same code, so typing it off the QR label / packaging
          works without a camera and without leaving setup. */}
      <div className="border-t border-separator-default pt-4 mt-2 mb-4">
        <label
          htmlFor="matter-manual-code"
          className="flex items-center gap-2 type-subheadline font-medium text-label-primary mb-1"
        >
          <KeyRound size={14} aria-hidden="true" />
          Have a pairing code or QR handy?
        </label>
        <p className="type-footnote text-label-tertiary mb-2">
          Type the 11- or 21-digit code from the device, its box, or under its QR
          label.
        </p>
        {/* WARP-851: until the box can hear BLE devices (WARP-850), be
            honest about what a pairing code can actually add. */}
        {bleAvailable === false && <BleUnavailableNotice className="mb-3" />}
        <div className="flex gap-2">
          <input
            id="matter-manual-code"
            type="text"
            inputMode="numeric"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleManualAdd();
            }}
            placeholder="3497-0112-3320"
            className="dp-input flex-1 font-mono"
            disabled={manualBusy}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={handleManualAdd}
            disabled={manualBusy || !manualCode.trim()}
            className="dp-btn-secondary"
          >
            {manualBusy ? "Adding…" : "Add device"}
          </button>
        </div>
        {manualError && (
          <div className="flex items-start gap-2 type-footnote text-system-red mt-2">
            <AlertCircle
              size={14}
              className="mt-0.5 flex-shrink-0"
              aria-hidden="true"
            />
            <span>{manualError}</span>
          </div>
        )}
        {manualOk && (
          <div className="flex items-start gap-2 type-footnote text-system-green mt-2">
            <Check
              size={14}
              className="mt-0.5 flex-shrink-0"
              aria-hidden="true"
            />
            <span>{manualOk}</span>
          </div>
        )}
      </div>

    </StepShell>
  );
}

function flattenGrouped(grouped: MatterGrouped): MatterDevice[] {
  return [
    ...grouped.lights,
    ...grouped.switches,
    ...grouped.climate,
    ...grouped.sensors,
    ...grouped.media,
    ...grouped.covers,
    ...grouped.locks,
    ...grouped.other,
  ];
}
