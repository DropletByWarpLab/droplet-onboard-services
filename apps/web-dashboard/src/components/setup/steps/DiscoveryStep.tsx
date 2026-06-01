"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Lightbulb,
  Radar,
  ThermometerSun,
  ToggleRight,
  Wifi,
} from "lucide-react";
import { fetchMatterDevices } from "@/lib/api";
import type { MatterDevice, MatterGrouped } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";

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
      {/* Discovered devices grid */}
      <div className="space-y-2 mb-8 max-h-[320px] overflow-y-auto">
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
      </div>

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

      {/* WARP-102 — Add-by-QR affordance. For devices that aren't yet
          on the LAN (still in packaging) or that the customer wants to
          scan from a label. /devices/add-matter is the canonical
          scanner; linking here so first-run customers find it without
          hunting through the dashboard. Returns to the wizard via
          browser back. */}
      <div className="border-t border-separator-default pt-4 mt-2 mb-4">
        <a
          href="/devices/add-matter"
          className="block w-full text-left p-3 bg-fill-tertiary hover:bg-fill-secondary border border-separator-default rounded-lg transition-colors"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="type-subheadline font-medium text-label-primary">
                Have a device&apos;s QR code handy?
              </p>
              <p className="type-footnote text-label-tertiary mt-0.5">
                Scan it now — most Matter devices ship with one on the
                packaging or label.
              </p>
            </div>
            <ArrowRight
              size={16}
              className="text-label-tertiary flex-shrink-0"
              aria-hidden="true"
            />
          </div>
        </a>
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
