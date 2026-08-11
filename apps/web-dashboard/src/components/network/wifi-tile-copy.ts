import type { WirelessRadioSummary } from "@/lib/types";

/**
 * The Network → Overview Wi-Fi tile's copy and status.
 *
 * This used to be three inline expressions over `overview.wireless`, which is
 * the ROUTER's own netifd wireless status and nothing else. On the shipping
 * fabric the router hosts no Wi-Fi — the RB5009 edge router has no radio
 * hardware at all, and the household SSID is broadcast by the Droplet access
 * point — so that map is `{}` and the tile reported "0 radio(s)" over a network
 * live on two radios, in warning orange, while simultaneously calling itself
 * "Active" (the value was `overview?.wireless ? … `, and `{}` is truthy, so
 * "Active" was never derived from anything). The count now comes from
 * `wirelessRadios`, the whole-fabric rollup, and "Active" is derived from
 * radios actually ON THE AIR.
 *
 * Its own module for two reasons: a `page.tsx` route file may export only the
 * default component plus Next.js's reserved fields — any other named export
 * fails `next build` at page-data collection, and that failure is invisible to
 * both tsc and vitest — and the arithmetic wants unit tests, an untested
 * inline expression being exactly how the old version stayed wrong.
 *
 * Three honesty rules, in the order they're checked:
 *   * no rollup at all (still loading, or an orchestrator that predates it) is
 *     UNKNOWN, never "Inactive" — asserting an unread state is the original bug;
 *   * online APs that didn't answer are UNKNOWN too, because a silent AP and an
 *     AP with no radios are different facts and only one of them is an outage;
 *   * radios that exist but are all down read "Inactive" — configured is not
 *     the same as broadcasting.
 */
export interface WifiTileCopy {
  value: string;
  subtitle: string;
  status: "ok" | "warning" | "error";
}

function pluralRadios(n: number): string {
  return n === 1 ? "1 radio" : `${n} radios`;
}

export function describeWifi(radios: WirelessRadioSummary | undefined): WifiTileCopy {
  if (!radios) {
    // Deliberately not "warning": an orange chip for a read that simply hasn't
    // landed yet is the same kind of unearned assertion, just pointing the
    // other way.
    return { value: "—", subtitle: "Checking radios…", status: "ok" };
  }

  const { router, ap, total, active, apsNotReporting } = radios;

  if (total === 0) {
    if (apsNotReporting > 0) {
      return {
        value: "Unknown",
        subtitle:
          apsNotReporting === 1
            ? "Your access point isn't reporting its radios"
            : `${apsNotReporting} access points aren't reporting their radios`,
        status: "warning",
      };
    }
    return { value: "Inactive", subtitle: "No radios found", status: "warning" };
  }

  const where =
    router > 0 && ap > 0
      ? "router + access point"
      : ap > 0
        ? "access point"
        : "router";
  const count =
    active === total
      ? pluralRadios(total)
      : `${active} of ${pluralRadios(total)} on the air`;
  // A silent AP makes the count a FLOOR, not a census — say so rather than
  // letting the number read as the whole household.
  const unreported =
    apsNotReporting > 0 ? ` · ${apsNotReporting} not reporting` : "";

  return {
    value: active > 0 ? "Active" : "Inactive",
    subtitle: `${count} · ${where}${unreported}`,
    status: active > 0 ? "ok" : "warning",
  };
}
