"use client";

import { HardDrive, RotateCcw } from "lucide-react";
import { useAuth } from "@/lib/auth";

/**
 * Maintenance — Firmware + Factory reset (Droplet Design System · Network ·
 * System).
 *
 * Honest, informational, owner-only. The design depicts a router with its own
 * flashable firmware and an independent network-config reset. The shipping
 * single-box has neither:
 *
 *  - It runs OpenWrt IN A CONTAINER whose filesystem comes from the
 *    singlebox-image (rebuilt via setup.sh + docker compose), NOT an MTD/SD
 *    partition — `sysupgrade` has no target, so there is no separate router
 *    firmware to flash.
 *  - A container UCI factory-reset would wipe the named-volume config the host
 *    `droplet-openwrt-attach` script + hostapd bridge depend on, desyncing the
 *    host AP SSID/PSK from container UCI (it can wedge the AP with no remote
 *    recovery), and it overlaps the appliance-wide factory reset that already
 *    ships under Settings.
 *
 * So these are NOT interactive controls — wiring a real sysupgrade or
 * container UCI-wipe here would either no-op or be dangerous, exactly the
 * fabricated-control anti-pattern. They explain the truth and point the owner
 * at the real, appliance-level flows. Owner-scoped, mirroring RouterRebootCard.
 *
 * WARP-1676 (ADR-033): the edge-router shape DOES have flashable router
 * firmware — an external bare-metal OpenWrt device reflashed from the
 * droplet-edge-router tooling, never from this page. The copy below covers
 * both shapes without claiming the container story universally.
 */
export function MaintenanceCards() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  if (!isOwner) return null;

  return (
    <>
      <div className="card">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-surface-secondary text-label-tertiary">
            <HardDrive size={18} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="type-headline text-label-primary">Firmware</h3>
            <p className="type-caption-1 text-label-tertiary mt-0.5">
              Router firmware isn&apos;t managed from this page. On the
              all-in-one model it ships with appliance updates; a dedicated
              edge router is updated by your installer&apos;s router tooling.
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-surface-secondary text-label-tertiary">
            <RotateCcw size={18} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="type-headline text-label-primary">Factory reset</h3>
            <p className="type-caption-1 text-label-tertiary mt-0.5">
              Resetting network config is done from Settings → factory reset for
              the whole appliance.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
