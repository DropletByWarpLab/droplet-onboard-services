/**
 * WARP-236 — duplicated from apps/orchestrator/src/lib/internal-tls.ts;
 * mcp-server is a separate workspace — keep the two in sync.
 *
 * DROPLET_INTERNAL_TLS=1 makes every outbound call to a first-party peer
 * present this service's client cert and pin trust to the internal CA; cert
 * paths default to the per-service bundle at /data/service-tls/.
 */
import { readFileSync } from "node:fs";
// undici's own fetch consumes the undici Agent directly, avoiding coupling to
// the host Node's bundled undici version (see the orchestrator helper).
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

interface InternalTlsMaterial {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
}

let material: InternalTlsMaterial | null = null;
let dispatcher: Dispatcher | null = null;

export function internalTlsEnabled(): boolean {
  return process.env.DROPLET_INTERNAL_TLS === "1";
}

function loadInternalTls(): InternalTlsMaterial {
  if (!material) {
    material = {
      cert: readFileSync(process.env.DROPLET_TLS_CERT ?? "/data/service-tls/cert.pem"),
      key: readFileSync(process.env.DROPLET_TLS_KEY ?? "/data/service-tls/key.pem"),
      ca: readFileSync(process.env.DROPLET_TLS_CA ?? "/data/service-tls/ca.pem"),
    };
  }
  return material;
}

export function internalDispatcher(): Dispatcher | undefined {
  if (!internalTlsEnabled()) return undefined;
  if (!dispatcher) {
    const m = loadInternalTls();
    dispatcher = new Agent({ connect: { cert: m.cert, key: m.key, ca: m.ca } });
  }
  return dispatcher;
}

export function internalFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const d = internalDispatcher();
  if (!d) return fetch(url, init);
  return undiciFetch(url, { ...init, dispatcher: d } as never) as unknown as Promise<Response>;
}

export function internalBaseUrl(url: string): string {
  if (internalTlsEnabled() && url.startsWith("http://")) {
    return "https://" + url.slice("http://".length);
  }
  return url;
}

export function resetInternalTlsForTests(): void {
  material = null;
  dispatcher = null;
}
