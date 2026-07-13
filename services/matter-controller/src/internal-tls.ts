/**
 * WARP-1061 — server-side internal-mTLS for the matter-controller :8083
 * listener. Trimmed from apps/orchestrator/src/lib/internal-tls.ts (this
 * sidecar is a SERVER only on the mesh — its outbound surface is BLE/mDNS,
 * not first-party HTTP — so the undici client half is deliberately absent;
 * mcp-server carries the client-half twin). Keep the env contract in sync.
 *
 * DROPLET_INTERNAL_TLS=1 makes index.ts serve HTTPS from the per-service
 * bundle at /data/service-tls and REQUIRE a CA-signed client cert (the
 * orchestrator's matter.service.ts presents one); unset/0 keeps the plain
 * node:http server. Reads process.env directly (not config.ts) to match the
 * shared helper family.
 */
import { readFileSync } from "node:fs";
import type https from "node:https";

export interface InternalTlsMaterial {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
}

let material: InternalTlsMaterial | null = null;

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

export function resetInternalTlsForTests(): void {
  material = null;
}
