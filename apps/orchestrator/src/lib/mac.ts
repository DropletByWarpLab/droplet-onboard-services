/**
 * WARP-80: MAC-address canonicalization.
 *
 * `NetworkDevice.mac` is the primary key of the device-intelligence table,
 * so every ingress path (reconciler, API handlers, CLI) must go through
 * `normalizeMac` before reading or writing. Canonical form is uppercase
 * hex byte pairs separated by colons — `AA:BB:CC:DD:EE:FF`.
 *
 * Accepted inputs:
 *   - colon-separated (`aa:bb:cc:dd:ee:ff`)
 *   - dash-separated  (`aa-bb-cc-dd-ee-ff`)
 *   - dot-separated   (`aabb.ccdd.eeff`, Cisco style)
 *   - no separators   (`aabbccddeeff`)
 *
 * Any combination of `:`, `-`, `.` separators (or none) is tolerated; input
 * may mix them freely (e.g. `aa:bb-cc.ddeeff`). This is intentional —
 * OpenWrt UCI / ARP dumps occasionally emit mixed forms and the reconciler
 * benefits from the permissive parse. The 12 hex characters themselves
 * remain the only hard requirement.
 *
 * Any other shape — wrong length, non-hex chars, empty string,
 * non-string input — throws `DeviceRegistryError.invalidMac`.
 */

import { DeviceRegistryError } from "../types/device-registry-error.js";

const HEX_12 = /^[0-9A-F]{12}$/;

export function normalizeMac(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw DeviceRegistryError.invalidMac(String(raw));
  }
  const compact = raw.replace(/[:\-.]/g, "").toUpperCase();
  if (!HEX_12.test(compact)) {
    throw DeviceRegistryError.invalidMac(raw);
  }
  return compact.match(/.{2}/g)!.join(":");
}
