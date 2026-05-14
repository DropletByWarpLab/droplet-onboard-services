/**
 * HTTP client for the OLED Display Service.
 */

// Match the schema default in config.ts. The display service runs with
// `network_mode: host` on the Jetson, so `localhost` from inside the
// orchestrator container would never resolve to it — the host gateway
// alias must be used. Compose sets DISPLAY_SERVICE_URL explicitly; this
// fallback only trips in local/unit-test contexts where the env isn't set.
const DISPLAY_URL = process.env.DISPLAY_SERVICE_URL || "http://host.docker.internal:8082";
const SERVICE_SECRET = process.env.DEVICE_SECRET_KEY || "";

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
 * Push a PNG buffer to the PyPortal screen via the display service's
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
    const res = await fetch(`${DISPLAY_URL}/display/custom`, {
      method: "POST",
      body: form,
      headers,
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
