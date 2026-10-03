/**
 * Manufacturer-aware RTSP stream-path hints (WARP-3505).
 *
 * The paths mirror `STREAM_PATHS` in services/camera-discovery/rtsp_prober.py —
 * the ones the prober itself has proven against real firmware — so the example a
 * human sees is the one the appliance would have found. Deliberately only
 * vendors with a path there: for anything else the right answer is "see your
 * camera's manual", not a guess that a 400 will contradict.
 */

const VENDOR_PATHS: ReadonlyArray<readonly [RegExp, string]> = [
  // Hanwha Wisenet (formerly Samsung Techwin) answers /stream1 with 400.
  [/hanwha|wisenet|samsung/i, "/profile2/media.smp"],
  [/hikvision/i, "/Streaming/Channels/101"],
  [/dahua|amcrest|lorex/i, "/cam/realmonitor?channel=1&subtype=0"],
  [/reolink/i, "/h264Preview_01_main"],
];

/** The known stream path for a manufacturer, or null when we have no proven one. */
export function streamPathFor(manufacturer: string | null | undefined): string | null {
  const m = manufacturer?.trim();
  if (!m) return null;
  for (const [pattern, path] of VENDOR_PATHS) {
    if (pattern.test(m)) return path;
  }
  return null;
}

/**
 * An example stream address for the hint / placeholder. Credentials are
 * intentionally absent — they have their own fields. An unknown manufacturer
 * gets an address with a neutral path stub rather than a guessed one.
 */
export function exampleStreamUrl(
  manufacturer: string | null | undefined,
  ip: string | null | undefined,
): string {
  const host = ip?.trim() || "192.168.1.50";
  const path = streamPathFor(manufacturer) ?? "/your-camera-stream-path";
  return `rtsp://${host}:554${path}`;
}
