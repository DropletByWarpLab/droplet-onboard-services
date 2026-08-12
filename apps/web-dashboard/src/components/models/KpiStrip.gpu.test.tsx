/**
 * WARP-1861 — the GPU tile says what it measured, in the unit it measured it.
 *
 * Five separate ways this tile could mislead, all pinned here:
 *
 *   1. Utilisation is a COMPUTE figure. Labelling 97% as "used" reads as
 *      "97% of VRAM is consumed" — on the lab box that would mean ~15.4 of
 *      15.9 GiB and no room for a second model, when VRAM is actually at 83%.
 *      It says "busy", and the VRAM pair is shown alongside it.
 *   2. GiB, not GB: the bytes are divided by 1024³, so a card whose sysfs
 *      total is 17_095_983_104 is 15.9 GiB. Printing "GB" beside that number
 *      would be a unit the arithmetic doesn't support.
 *   3. Per-FIELD degradation, not per-tile. A pinned BRIDGE_GPU_CARD can
 *      report a live card with an unreadable VRAM total; the tile drops the
 *      VRAM entry and keeps the card, rather than claiming no accelerator.
 *   4. A FAILED PROBE is not a negative answer. "No accelerator detected" is
 *      a claim about the customer's hardware, and we may only make it when
 *      the bridge answered. An unreachable bridge gets its own copy.
 *   5. A null counter is not a reading. Unreadable utilisation is reported as
 *      unreported, never as "idle" — a card holding 13.2 GiB cannot be idle.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ModelsGpuInfo, ModelsGpuReason } from "@/lib/types";

import { KpiStrip } from "./KpiStrip";

/** The lab box under load: card1, 97% busy, VRAM 13.2 of 15.9 GiB, 62°C. */
function gpu(over: Partial<ModelsGpuInfo> = {}): ModelsGpuInfo {
  return {
    name: "card1",
    vramGiB: 15.9,
    vramUsedGiB: 13.2,
    utilPct: 97,
    tempC: 62,
    ...over,
  };
}

function renderStrip(
  g: ModelsGpuInfo | null,
  gpuReason: ModelsGpuReason = g ? null : "no_card",
) {
  return render(
    <KpiStrip
      gpu={g}
      gpuReason={gpuReason}
      avgLatencyMs={0}
      cloudSpendUsd={0}
      localCount={1}
    />,
  );
}

describe("KpiStrip — GPU tile (WARP-1861)", () => {
  it("labels utilisation as busy and shows VRAM as its own fact", () => {
    renderStrip(gpu());
    expect(screen.getByText("card1")).toBeInTheDocument();
    expect(
      screen.getByText("13.2 / 15.9 GiB · 62°C · 97% busy"),
    ).toBeInTheDocument();
  });

  it("never calls compute utilisation VRAM consumption", () => {
    // The bug in one assertion: "97% used" beside a 15.9 GiB total is read as
    // 15.4 GiB consumed. Both numbers are on screen now, and only one of them
    // is a percentage.
    renderStrip(gpu());
    expect(screen.queryByText(/97% used/)).not.toBeInTheDocument();
  });

  it("prints GiB, matching the binary divisor behind the number", () => {
    renderStrip(gpu());
    expect(screen.queryByText(/15\.9 GB/)).not.toBeInTheDocument();
  });

  it("keeps the card when VRAM is unreadable (BRIDGE_GPU_CARD pinned)", () => {
    // device-bridge returns a pinned node WITHOUT reading mem_info_vram_total,
    // so this is a live card at 97% with no VRAM figure. Dropping the tile
    // here is the false outage this ticket set out to end.
    renderStrip(gpu({ vramGiB: null, vramUsedGiB: null }));
    expect(screen.getByText("card1")).toBeInTheDocument();
    expect(screen.getByText("62°C · 97% busy")).toBeInTheDocument();
    expect(screen.queryByText(/No accelerator detected/)).not.toBeInTheDocument();
  });

  it("shows the total alone when usage is unreadable", () => {
    renderStrip(gpu({ vramUsedGiB: null }));
    expect(screen.getByText("15.9 GiB · 62°C · 97% busy")).toBeInTheDocument();
  });

  it("declines to report utilisation rather than 0% when nothing is readable", () => {
    // amdgpu runtime-suspends an unheld card and the sysfs reads return
    // EBUSY. 0% would be a measurement nobody took — and neither is "idle".
    renderStrip(gpu({ utilPct: null, tempC: null }));
    expect(
      screen.getByText("13.2 / 15.9 GiB · utilisation not reported"),
    ).toBeInTheDocument();
  });

  it("never claims a card holding 13.2 GiB is idle", () => {
    // The provable contradiction. `busy_percent` is null for ANY read
    // failure — device-bridge's `_read_sysfs_int` swallows every exception,
    // and a driver that never publishes `gpu_busy_percent` yields null
    // permanently. The old copy justified "idle" with runtime suspend, but
    // runtime suspend requires ZERO clients: a card holding 13.2 GiB at 62°C
    // cannot be suspended, so the claim was provably false in this state.
    renderStrip(gpu({ utilPct: null }));
    expect(screen.queryByText(/idle/i)).not.toBeInTheDocument();
    expect(
      screen.getByText("13.2 / 15.9 GiB · 62°C · utilisation not reported"),
    ).toBeInTheDocument();
  });

  it("says no accelerator only when the bridge ANSWERED that no card resolves", () => {
    renderStrip(null, "no_card");
    expect(screen.getByText("No accelerator detected")).toBeInTheDocument();
  });

  it("does not claim the hardware is absent when the probe never completed", () => {
    // `fetchGpuTelemetry()` returns null for no token, ECONNREFUSED, timeout,
    // non-2xx and a malformed body. On a box whose droplet-device-bridge
    // didn't restart after a refresh (WARP-1829), or whose
    // SERVICE_TOKEN_DISPLAY a setup.sh re-run dropped (WARP-1865), the owner
    // would read "No accelerator detected" over a working 16 GiB dGPU and
    // file a hardware ticket. The route already keeps the two apart; the tile
    // has to as well.
    renderStrip(null, "unreachable");
    expect(
      screen.getByText("Couldn’t reach the GPU sensor"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No accelerator detected/),
    ).not.toBeInTheDocument();
  });

  it("stays non-committal when an older orchestrator sends no reason at all", () => {
    // Additive field: a box running a pre-WARP-1861 orchestrator sends `gpu`
    // with no `gpuReason`. Defaulting that to "no accelerator" would
    // reintroduce the same unearned claim through the back door.
    renderStrip(null, null);
    expect(
      screen.queryByText(/No accelerator detected/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("GPU reading unavailable")).toBeInTheDocument();
  });
});
