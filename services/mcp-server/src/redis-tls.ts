import { readFileSync } from "node:fs";

/**
 * WARP-234 — TLS options for the rerank-cache Redis connection.
 *
 * The compose `cache` service serves TLS-only (:6380) with a leaf of the
 * WARP-236 compose-internal CA, which no public root signs — a rediss://
 * URL therefore needs the CA pinned explicitly. The CA comes from the
 * per-service bundle mounted at /data/service-tls (or DROPLET_TLS_CA,
 * the same env contract as internal-tls.ts). Plaintext redis:// URLs
 * (dev compose) get no TLS options.
 */
export function redisCaPath(): string {
  return process.env.DROPLET_TLS_CA ?? "/data/service-tls/ca.pem";
}

export function redisConnectionOptions(
  url: string,
  readCa: (path: string) => Buffer = (p) => readFileSync(p),
): { tls?: { ca: Buffer } } {
  if (!url.startsWith("rediss://")) return {};
  return { tls: { ca: readCa(redisCaPath()) } };
}
