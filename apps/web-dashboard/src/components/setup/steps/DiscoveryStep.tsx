"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Hourglass,
  KeyRound,
  Lightbulb,
  Radar,
  SearchX,
  ThermometerSun,
  ToggleRight,
  Wifi,
} from "lucide-react";
import {
  commissionMatterDevice,
  discoverMatterDevices,
  fetchMatterCapabilities,
  fetchMatterDevices,
} from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import type {
  MatterDevice,
  MatterDiscoveredDevice,
  MatterGrouped,
} from "@/lib/types";
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

// WARP-1281: commissionable-device discovery. Each GET /api/matter/discover
// is an ACTIVE mDNS browse taking ~15s server-side, so browses run strictly
// serially — the next one is scheduled only after the previous settles, with
// this pause in between. The chain is bounded by the WARP-298 scan lifecycle
// (it stops at phase "stopped" / on unmount), never by a free-running loop.
const DISCOVER_RETRY_GAP_MS = 3_000;
// Review follow-up on #996 (finding 1): transport bound on a single browse.
// The orchestrator caps the server-side mDNS browse at ~15s, so a fetch that
// hasn't settled by 25s is a stalled transport, not a slow browse. Without
// this bound a never-settling fetch wedges discoverBusyRef forever — the
// chain issues no further browses and "Scan again" re-arms a scan that can
// never browse. Implemented as AbortController + setTimeout (the repo's
// jsdom-safe equivalent of AbortSignal.timeout — see timeoutSignal() in
// lib/auth.tsx) so fake-timer tests can drive it deterministically.
const DISCOVER_FETCH_TIMEOUT_MS = 25_000;
// WARP-1281: how many consecutive discovery/poll failures we tolerate before
// swapping the scanning skeletons for the explicit "smart home isn't
// available" state. A single failure is not a verdict (the controller may be
// mid-boot); a 503 from /matter/discover IS definitive and trips it at once.
const UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES = 3;

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
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const lastFoundAtSecRef = useRef<number>(0);

  // WARP-1281: commissionable (not-yet-paired) devices from the active mDNS
  // browse. These render as "ready to pair" cards — the pairing-code input
  // below stays the actual add path (Matter can't commission without it).
  const [commissionables, setCommissionables] = useState<
    MatterDiscoveredDevice[]
  >([]);
  // WARP-1281: true when the smart-home subsystem is demonstrably down —
  // /matter/discover answered 503 ("Matter controller not started") or the
  // discovery browse / commissioned poll failed 3+ times in a row. While
  // true the step renders an honest service-down state instead of the
  // scanning skeletons, but keeps quietly retrying so it self-heals.
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const discoverBusyRef = useRef(false);
  const discoverEnabledRef = useRef(false);
  // Scan-generation counter: bumped by every startDiscovery so a browse OR
  // commissioned poll that was in flight across a "Scan again" click can't
  // apply stale results or stale failure counts to the new scan (review
  // follow-up on #996: pollOnce needs the same guard as discoverTick — a
  // phantom stale poll failure would trip the unavailable verdict one real
  // failure early, and a phantom success would pre-seed the fresh list).
  const scanGenRef = useRef(0);
  const discoverTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const discoverFailsRef = useRef(0);
  // Sticky "the controller told us it isn't started" flag — only an actual
  // discovery SUCCESS clears it (a succeeding commissioned poll does not:
  // GET /matter/devices returns 200-with-empty-groups even when the
  // controller is down, which is exactly the disguise this fix removes).
  const discover503Ref = useRef(false);
  const pollFailsRef = useRef(0);

  // Recompute the derived availability verdict from the failure trackers.
  // setState with an unchanged boolean is a no-op re-render-wise, so this
  // is safe to call on every poll/browse settle.
  const refreshAvailability = useCallback(() => {
    setServiceUnavailable(
      discover503Ref.current ||
        discoverFailsRef.current >= UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES ||
        pollFailsRef.current >= UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES,
    );
  }, []);

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
    // Review follow-up on #996 (finding 2): pin the settle to the scan
    // generation that issued it, same pattern as discoverTick. A poll in
    // flight across a "Scan again" re-arm must not leak into the new
    // scan's state.
    const gen = scanGenRef.current;
    try {
      const grouped = await fetchMatterDevices();
      if (gen !== scanGenRef.current) return;
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
      // WARP-1281: a transport-level success resets the poll failure
      // streak. Note it deliberately does NOT clear discover503Ref —
      // this route answers 200-with-empty-groups while the controller
      // is down, so success here proves nothing about the subsystem.
      pollFailsRef.current = 0;
      refreshAvailability();
    } catch {
      if (gen !== scanGenRef.current) return;
      // Matter controller may still be booting — keep polling (WARP-298
      // machine untouched), but count the streak so the wizard stops
      // fake-scanning if the subsystem is actually broken (WARP-1281).
      pollFailsRef.current += 1;
      refreshAvailability();
    }
  }, [refreshAvailability]);

  // WARP-1281: one serial commissionable-device browse. Strictly one in
  // flight (discoverBusyRef); on settle it schedules the next browse after
  // DISCOVER_RETRY_GAP_MS — including while unavailable, so the state
  // self-heals once the controller comes up (~15s per the orchestrator's
  // matter client). The chain dies at phase "stopped", on Continue/Skip,
  // and on unmount via discoverEnabledRef + the cleared gap timer.
  const discoverTick = useCallback(async () => {
    if (discoverBusyRef.current || !discoverEnabledRef.current) return;
    discoverBusyRef.current = true;
    const gen = scanGenRef.current;
    // Transport bound (review follow-up on #996): abort the fetch at
    // DISCOVER_FETCH_TIMEOUT_MS AND race the promise against the abort —
    // the race guarantees this tick settles (freeing the serial chain)
    // even if the underlying promise ignores the signal.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(
        new DOMException("Matter browse timed out", "TimeoutError"),
      );
    }, DISCOVER_FETCH_TIMEOUT_MS);
    try {
      const browse = discoverMatterDevices(controller.signal);
      // A timed-out browse becomes an orphan the race no longer observes;
      // swallow its late rejection so it can't surface as unhandled.
      browse.catch(() => {});
      const { devices } = await Promise.race([
        browse,
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true },
          );
        }),
      ]);
      if (gen === scanGenRef.current && discoverEnabledRef.current) {
        discoverFailsRef.current = 0;
        discover503Ref.current = false;
        refreshAvailability();
        // Snapshot semantics: each browse reports the devices currently
        // advertising as commissionable — a device drops out by itself
        // once paired. Keep the previous array reference when nothing
        // changed so healthy empty browses don't re-render every ~18s.
        setCommissionables((prev) =>
          sameCommissionables(prev, devices) ? prev : devices,
        );
      }
    } catch (e) {
      if (gen === scanGenRef.current && discoverEnabledRef.current) {
        discoverFailsRef.current += 1;
        if ((e as { status?: number }).status === 503) {
          // Definitive: the controller told us it isn't started.
          discover503Ref.current = true;
        }
        refreshAvailability();
      }
    } finally {
      clearTimeout(timeoutId);
      discoverBusyRef.current = false;
      if (discoverEnabledRef.current) {
        discoverTimerRef.current = setTimeout(() => {
          void discoverTick();
        }, DISCOVER_RETRY_GAP_MS);
      }
    }
  }, [refreshAvailability]);

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
    // WARP-1281: re-arm the commissionable browse chain alongside the poll.
    // Bumping the generation makes any browse still in flight from the
    // previous scan discard its result; the busy flag keeps the chain
    // strictly serial across the re-arm (the stale browse's settle hands
    // the chain over to this scan's generation). Worst case the new
    // scan's first browse therefore starts after the stale browse's
    // remaining flight time (a browse runs ~15s server-side) plus the
    // 3s gap — the serial guarantee is worth that latency; overlapping
    // active mDNS browses would be worse for the controller.
    if (discoverTimerRef.current) clearTimeout(discoverTimerRef.current);
    scanGenRef.current += 1;
    discoverEnabledRef.current = true;
    discoverFailsRef.current = 0;
    discover503Ref.current = false;
    pollFailsRef.current = 0;

    setIsScanning(true);
    setScanSeconds(0);
    setScanPhase("active");
    seenIdsRef.current.clear();
    setDiscoveredDevices([]);
    setCommissionables([]);
    setServiceUnavailable(false);
    lastFoundAtSecRef.current = 0;

    // Poll for devices every 3 seconds (active phase).
    pollRef.current = setInterval(pollOnce, 3000);

    // Count seconds for UX.
    timerRef.current = setInterval(() => {
      setScanSeconds((s) => s + 1);
    }, 1000);

    // Kick the first browse immediately — each subsequent one chains off
    // the previous settle (serial by construction).
    void discoverTick();
  }, [pollOnce, discoverTick]);

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
      // WARP-1281: the commissionable browse chain shares the scan
      // lifecycle bound — no more browses once polling stops. A browse
      // still in flight settles harmlessly (enabled flag is down, so it
      // neither applies results nor schedules a successor).
      discoverEnabledRef.current = false;
      if (discoverTimerRef.current) {
        clearTimeout(discoverTimerRef.current);
        discoverTimerRef.current = undefined;
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

  // Auto-start on mount; clean up both intervals + the browse chain on
  // unmount (WARP-1281: React cleanup is the other bound on the chain).
  useEffect(() => {
    startDiscovery();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
      discoverEnabledRef.current = false;
      if (discoverTimerRef.current) clearTimeout(discoverTimerRef.current);
    };
  }, [startDiscovery]);

  function handleFinish() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    discoverEnabledRef.current = false;
    if (discoverTimerRef.current) clearTimeout(discoverTimerRef.current);
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
      // WARP-856 (item 2): never render e.message verbatim on a first-run
      // screen — a non-JSON error body yields "Failed to commission device:
      // 502". commissionMatterDevice attaches err.status (WARP-851), so
      // translateError maps the curated 502/503/504 commissioning copy and
      // falls back to a calm generic line for everything else.
      setManualError(translateError(e, "device"));
    } finally {
      setManualBusy(false);
    }
  }

  // WARP-1281: "nothing found" now means neither an already-commissioned
  // device NOR a commissionable (ready-to-pair) one — a surface showing
  // ready-to-pair cards is not empty, so neither the skeletons nor the
  // WARP-937 zero-results state may claim it is.
  const nothingFoundYet =
    discoveredDevices.length === 0 && commissionables.length === 0;

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
        discoveredDevices.length > 0
          ? `${discoveredDevices.length} device${
              discoveredDevices.length !== 1 ? "s" : ""
            } found`
          : commissionables.length > 0
            ? // WARP-1281: commissionable devices were found — say so
              // instead of claiming an empty scan.
              `${commissionables.length} device${
                commissionables.length !== 1 ? "s" : ""
              } ready to pair`
            : serviceUnavailable
              ? // WARP-1281: don't claim we're scanning while the
                // smart-device subsystem is demonstrably down — the body
                // shows the service-unavailable state (same wording).
                "Device discovery isn't available right now"
              : // WARP-937: don't claim we're still "scanning" once polling
                // has stopped with nothing found — the body shows a
                // no-devices empty state, so the subtitle should match
                // instead of contradicting it.
                scanPhase === "stopped"
                ? "No smart devices found yet"
                : "Scanning your network for smart devices..."
      }
      primary={{ label: "Continue", onClick: handleFinish, showArrow: true }}
      skip={{ label: "Skip for now", onClick: handleFinish }}
    >
      {/* Discovered devices grid. WARP-820: the device list is unbounded, so
          it lives in a <ScrollRegion> (the wizard's single scroll surface) —
          the title, "N devices found" subtitle, and the CTA stay pinned in the
          StepShell while only this list scrolls. The bound is viewport-relative
          (was a fixed max-h-[320px]) so it shrinks on a short landscape phone. */}
      {/* WARP-1281 (UX): the region now holds both commissioned devices and
          commissionable "ready to pair" cards, so the label says so. */}
      <ScrollRegion
        aria-label="Discovered and nearby devices"
        className="space-y-2 mb-8"
      >
        {/* Polite live region (TwoFactorStep pattern): card lists aren't
            announced on their own, so tell AT users when nearby devices
            show up. Always mounted so the announcement fires on change. */}
        <span
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {commissionables.length > 0
            ? `${commissionables.length} device${
                commissionables.length !== 1 ? "s" : ""
              } ready to pair`
            : ""}
        </span>
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

        {/* WARP-1281: commissionable devices spotted by the active mDNS
            browse. These are factory-new devices advertising for pairing —
            they can't be added silently (Matter requires the pairing code),
            so each card points the customer at the code input below. Icon +
            accent use the system-blue info tint, mirroring the devices-page
            DiscoveryBanner for the same "found, not yet added" semantics. */}
        {commissionables.length > 0 && (
          <div className="space-y-2" data-testid="discovery-ready-to-pair">
            <p className="type-caption-1 text-label-tertiary">
              Found nearby · ready to pair
            </p>
            {commissionables.map((device, index) => (
              <div
                key={device.deviceIdentifier}
                className="animate-device-appear flex items-center gap-3 dp-card !py-3"
                style={{ animationDelay: `${index * 80}ms` }}
              >
                <div className="w-9 h-9 rounded-lg bg-system-blue/10 flex items-center justify-center flex-shrink-0">
                  <KeyRound
                    size={18}
                    className="text-system-blue"
                    aria-hidden="true"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="type-subheadline text-label-primary truncate">
                    {device.deviceName || "Matter device"}
                  </p>
                  <p className="type-caption-1 text-label-tertiary">
                    Enter the pairing code printed on it below
                  </p>
                </div>
                {/* UX (WARP-1281): label ramp, not system-blue — 12px blue
                    on the card surface lands under AA 4.5:1; the icon tile
                    keeps the info tint. */}
                <span className="type-caption-1 text-label-secondary flex-shrink-0">
                  Ready to pair
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Scanning placeholder rows. WARP-937: gate on the *active* scanning
            phases ("active" / "downshifted") — without this guard the skeletons
            kept pulsing forever after polling stopped with zero results, so the
            customer couldn't tell whether the box was still scanning or had
            simply found nothing. Once polling halts (phase "stopped") the
            zero-results empty state below takes over instead. WARP-1281: also
            gate on the subsystem being reachable — when it's down the explicit
            unavailable state below replaces the fake scan — and on having no
            ready-to-pair cards (real content beats placeholders). */}
        {nothingFoundYet &&
          !serviceUnavailable &&
          (scanPhase === "active" || scanPhase === "downshifted") && (
          <div className="space-y-2" data-testid="discovery-skeletons">
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

      {/* WARP-1281: the smart-home subsystem is demonstrably down (503 from
          the commissionable browse, or 3+ consecutive poll/browse failures).
          Say so plainly instead of pretending to scan — while this shows,
          the browse chain keeps quietly retrying in the background (until
          the 5-minute lifecycle bound), so the state clears by itself when
          the controller finishes starting. "Scan again" re-arms a fresh
          scan; Continue / Skip in the StepShell stay available throughout. */}
      {serviceUnavailable && (
        <div
          // Polite live region (VpnStep convention): the state is
          // non-urgent and self-healing, and Continue/Skip stay
          // available — so role="status", not role="alert".
          role="status"
          aria-live="polite"
          className="text-center mb-4"
          data-testid="discovery-unavailable"
        >
          <div className="flex flex-col items-center">
            <Hourglass
              size={28}
              className="text-label-quaternary mb-3"
              aria-hidden="true"
            />
            <p className="type-headline text-label-primary mb-1">
              Device discovery isn&apos;t available right now
            </p>
            <p className="type-subheadline text-label-secondary max-w-sm">
              The Droplet&apos;s smart-device service may still be starting up.{" "}
              {scanPhase === "stopped"
                ? "Scan again in a moment, or continue and add devices later from the Devices page."
                : "We'll keep checking in the background — you can also continue and add devices later from the Devices page."}
            </p>
          </div>
          <button
            type="button"
            onClick={startDiscovery}
            className="dp-btn-secondary mt-3"
          >
            Scan again
          </button>
        </div>
      )}

      {/* Scanning timer + lifecycle hints (WARP-298). WARP-1281: all three
          are scanning-status claims, so they yield to the explicit
          unavailable state above when the subsystem is down. */}
      {!serviceUnavailable && isScanning && scanPhase === "active" && (
        <p className="type-caption-1 text-label-quaternary text-center mb-4">
          Scanning... {scanSeconds}s
        </p>
      )}
      {!serviceUnavailable && isScanning && scanPhase === "downshifted" && (
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
      {!serviceUnavailable && scanPhase === "stopped" && (
        <div
          className="text-center mb-4"
          data-testid="discovery-stopped"
        >
          {nothingFoundYet ? (
            // WARP-937: scanning completed having found nothing. Before this,
            // the surface just kept the perpetual skeletons pulsing, so the
            // customer couldn't tell "still scanning" from "found nothing".
            // Give them a clear, calm empty state (this is expected when no
            // Matter devices are in pairing mode yet — not an error) plus the
            // same two recovery paths the rest of the step offers: scan again,
            // or type a pairing code below.
            <div
              className="flex flex-col items-center"
              data-testid="discovery-empty"
            >
              <SearchX
                size={28}
                className="text-label-quaternary mb-3"
                aria-hidden="true"
              />
              <p className="type-headline text-label-primary mb-1">
                Device discovery didn&apos;t find any devices
              </p>
              <p className="type-subheadline text-label-secondary max-w-sm">
                Make sure your smart devices are powered on and in pairing
                mode, then scan again. You can also enter a pairing code below,
                or add devices later from the Devices page.
              </p>
            </div>
          ) : (
            <p className="type-caption-1 text-label-tertiary">
              Stopped automatic scanning after 5 minutes. You can add devices
              manually from the Devices page later.
            </p>
          )}
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

// WARP-1281: cheap same-set check so repeated identical browse snapshots
// (the steady state: an empty result every ~18s) keep the previous array
// reference and don't force a re-render. Compares every field the cards
// render (review follow-up on #996: identifier alone dropped a later browse
// that resolved the real deviceName for the same device set, leaving a card
// stuck on the "Matter device" fallback).
function sameCommissionables(
  prev: MatterDiscoveredDevice[],
  next: MatterDiscoveredDevice[],
): boolean {
  return (
    prev.length === next.length &&
    prev.every(
      (d, i) =>
        d.deviceIdentifier === next[i].deviceIdentifier &&
        d.deviceName === next[i].deviceName,
    )
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
