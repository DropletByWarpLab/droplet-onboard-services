/**
 * WARP-236 — internal mTLS material + client plumbing for the orchestrator.
 *
 * Env contract (docs/security/internal-mtls.md): DROPLET_INTERNAL_TLS=1 turns
 * on both the inbound HTTPS listener (index.ts) and outbound client certs;
 * cert paths default to the per-service bundle at /data/service-tls/.
 * Reads process.env directly (not config.ts) so healthcheck.ts can import it
 * without dragging in the full zod config.
 */
import { readFileSync } from "node:fs";
import type https from "node:https";
// Import fetch from undici alongside Agent so the client cert dispatcher is
// always version-matched to the fetch it feeds. The appliance runs Node 20
// (undici 6 is the bundled fetch engine there), but pairing undici's own fetch
// with its own Agent keeps this correct on any host Node (e.g. a newer Node
// whose bundled undici would reject a v6 dispatcher passed to the GLOBAL fetch).
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

export interface InternalTlsMaterial {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
}

let material: InternalTlsMaterial | null = null;
let dispatcher: Dispatcher | null = null;

export function internalTlsEnabled(): boolean {
  return process.env.DROPLET_INTERNAL_TLS === "1";
}

export function loadInternalTls(): InternalTlsMaterial {
  if (!material) {
    material = {
      cert: readFileSync(process.env.DROPLET_TLS_CERT ?? "/data/service-tls/cert.pem"),
      key: readFileSync(process.env.DROPLET_TLS_KEY ?? "/data/service-tls/key.pem"),
      ca: readFileSync(process.env.DROPLET_TLS_CA ?? "/data/service-tls/ca.pem"),
    };
  }
  return material;
}

/** Options for the inbound listener: serve our cert, REQUIRE a CA-signed peer cert. */
export function httpsServerOptions(): https.ServerOptions {
  const m = loadInternalTls();
  return { cert: m.cert, key: m.key, ca: m.ca, requestCert: true, rejectUnauthorized: true };
}

/** undici Agent presenting our client cert and pinning trust to the internal CA. */
export function internalDispatcher(): Dispatcher | undefined {
  if (!internalTlsEnabled()) return undefined;
  if (!dispatcher) {
    const m = loadInternalTls();
    dispatcher = new Agent({ connect: { cert: m.cert, key: m.key, ca: m.ca } });
  }
  return dispatcher;
}

/** fetch() for INTERNAL peers only — external calls keep the default trust store. */
export function internalFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const d = internalDispatcher();
  if (!d) return fetch(url, init);
  // undici's own fetch consumes the undici Agent directly (dispatcher option),
  // avoiding any coupling to the host Node's bundled undici version. Cast at the
  // boundary — undici's Response is structurally the WHATWG Response.
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
