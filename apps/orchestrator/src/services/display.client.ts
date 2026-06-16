/**
 * HTTP client for the OLED Display Service.
 */

// Match the schema default in config.ts. The display service runs with
// `network_mode: host` on the inference host, so `localhost` from inside
// the orchestrator container would never resolve to it — the host gateway
// alias must be used. Compose sets DISPLAY_SERVICE_URL explicitly; this
// fallback only trips in local/unit-test contexts where the env isn't set.
const DISPLAY_URL = process.env.DISPLAY_SERVICE_URL || "http://host.docker.internal:8082";
// WARP-165: dedicated service-to-service bearer (previously reused
// DEVICE_SECRET_KEY — the FIPS-sealed AES-256 master encryption key —
// which put the master key on the wire on every display call). The
// `secrets.sh` _migrate_ensure_key call backfills this on the next
// `./scripts/setup.sh` run for installs that predate the rename, so
// operators don't need to do anything manual besides re-running setup.
const SERVICE_SECRET = process.env.SERVICE_TOKEN_DISPLAY || "";

async function displayFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(SERVICE_SECRET ? { Authorization: `Bearer ${SERVICE_SECRET}` } : {}),
    ...(options.headers as Record<string, string> || {}),
  };
  return fetch(`${DISPLAY_URL}${path}`, { ...options, headers });
}

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await displayFetch("/health");
    return res.ok;
  } catch {
    return false;
  }
}

export async function getDisplayStatus(): Promise<Record<string, unknown> | null> {
  try {
    const res = await displayFetch("/display/status");
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function showStats(): Promise<boolean> {
  try {
    const res = await displayFetch("/display/stats", { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function showLogo(): Promise<boolean> {
  try {
    const res = await displayFetch("/display/logo", { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function showHome(): Promise<boolean> {
  try {
    const res = await displayFetch("/display/home", { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Navigate the panel to the combined System + Wi-Fi screen (py-v3).
 *
 * Sends a BARE `{"mode":"system"}` nav (no data) via `POST /display/system`, so
 * the firmware leaves whatever screen it is on — in particular the modal claim
 * screen once the box is claimed — and renders the live System screen (stats +
 * the built-in Wi-Fi pairing QR). Distinct from `showStats()`, which streams a
 * stats *data* frame the firmware only re-renders when already on System (it
 * does NOT navigate off the claim screen).
 */
export async function showSystem(): Promise<boolean> {
  try {
    const res = await displayFetch("/display/system", { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function showMessage(title: string, lines: string[]): Promise<boolean> {
  try {
    const res = await displayFetch("/display/message", {
      method: "POST",
      body: JSON.stringify({ title, lines }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Push a PNG buffer to the status display via the display service's
 * `POST /display/custom` multipart endpoint.
 *
 * `png` is the raw bytes (Buffer or Uint8Array) — already a valid PNG.
 * Used by `screen-qr.service.ts` to render QR codes onto the screen
 * without inventing a QR-specific endpoint; the display backend
 * doesn't care that the image happens to encode a QR.
 *
 * Returns true on 2xx, false on any error — surface the failure via
 * the caller's metrics rather than throw, mirroring the pattern of
 * the other helpers in this file.
 */
export async function pushCustomImage(
  png: Buffer | Uint8Array,
  filename = "qr.png",
): Promise<boolean> {
  try {
    // Native fetch (Node 18+) accepts a FormData with a Blob — the
    // display-service multipart parser (FastAPI / python-multipart)
    // accepts that shape.
    const form = new FormData();
    // Copy into a fresh ArrayBuffer so the Blob ctor type-checks
    // cleanly. Node's Buffer is typed `Buffer<ArrayBufferLike>` and
    // TS's lib.dom Blob constructor wants the narrower
    // `ArrayBufferView<ArrayBuffer>`; a copy lets us satisfy both
    // shapes without a cast that hides real type drift later.
    const copy = new Uint8Array(png.byteLength);
    copy.set(png);
    const blob = new Blob([copy.buffer], { type: "image/png" });
    form.append("file", blob, filename);

    // displayFetch sets `Content-Type: application/json` by default
    // — wrong for multipart. Call fetch directly with the auth header
    // we need so the multipart boundary header is set correctly by
    // the runtime.
    const headers: Record<string, string> = {};
    if (SERVICE_SECRET) {
      headers["Authorization"] = `Bearer ${SERVICE_SECRET}`;
    }
    // 5s ceiling so a stalled display service can't pin the orchestrator's
    // event loop on this multipart upload. The status display write path is
    // serial USB-serial; under normal load a push completes in ~200 ms.
    // 5s is a generous upper bound that still lets the screen-qr
    // single-flight guard reset and try again next tick.
    const res = await fetch(`${DISPLAY_URL}/display/custom`, {
      method: "POST",
      body: form,
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Push the CLAIM screen to the status display via the display service's
 * `POST /display/claim` endpoint (WARP-632 / ADR-017).
 *
 * This is the orchestrator → display half of the claim-code render path:
 * `screen-qr.service.ts` calls this with the freshly-minted code + the setup
 * URL while the box is unclaimed; the display service renders a dedicated
 * `claim` mode on the PyPortal (large code + setup URL) rather than going
 * through the preview-only `/display/custom` image path.
 *
 * `code` is the plaintext DRPL-XXXX-XXXX (already grouped for the lid);
 * `setupUrl` is where the customer points their phone (e.g. https://<ip>/setup).
 *
 * WARP-819: the optional `wifi` arg adds the box's Wi-Fi-connect QR matrix +
 * SSID + PSK so the claim screen can also show "join this box's Wi-Fi" creds
 * (scan or type, no camera needed). It is OPTIONAL and BACKWARD-COMPATIBLE:
 * when omitted, the body is exactly the original `{ code, setup_url }` so an
 * older display service / firmware renders the claim-only layout untouched.
 * The PSK is plaintext here, but this is a LAN-only, SERVICE_TOKEN_DISPLAY-
 * gated host call (same posture as the existing claim push), and the same
 * creds are about to be drawn on the physical panel anyway.
 *
 * Returns true on 2xx, false on any non-2xx or thrown error — surface the
 * failure via the caller's signature/metrics rather than throw, mirroring the
 * other helpers in this file. 5s ceiling so a stalled display service can't
 * pin the orchestrator's event loop on this push (same bound as
 * `pushCustomImage`).
 */
export interface ClaimWifi {
  /** Host-encoded QR bit-matrix (0/1 rows) — the firmware never encodes on-device. */
  matrix: number[][];
  ssid: string;
  /** Plaintext WPA2 passphrase to render as readable text under the QR. */
  psk: string;
}

export async function pushClaimCode(
  code: string,
  setupUrl: string,
  wifi?: ClaimWifi,
): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { code, setup_url: setupUrl };
    // Only attach the wifi_* keys when we actually have a matrix — keeps the
    // payload byte-for-byte identical to the pre-WARP-819 shape otherwise, so
    // graceful degradation on the firmware side is "the keys simply aren't there".
    if (wifi && wifi.matrix) {
      body.wifi_qr_matrix = wifi.matrix;
      body.wifi_ssid = wifi.ssid;
      body.wifi_psk = wifi.psk;
    }
    const res = await displayFetch("/display/claim", {
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function setBrightness(value: number): Promise<boolean> {
  try {
    const res = await displayFetch("/display/brightness", {
      method: "POST",
      body: JSON.stringify({ value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resumeCycle(): Promise<boolean> {
  try {
    const res = await displayFetch("/display/cycle/resume", { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function stopCycle(): Promise<boolean> {
  try {
    const res = await displayFetch("/display/cycle/stop", { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function connectWifi(
  ssid: string,
  password: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await displayFetch("/wifi/connect", {
      method: "POST",
      body: JSON.stringify({ ssid, password }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
