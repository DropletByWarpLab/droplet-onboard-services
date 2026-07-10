/**
 * WARP-236 — container healthcheck client. Exits 0 on 2xx from
 * /api/orchestrator/health, 1 otherwise. Presents the service's own client
 * cert when internal mTLS is enabled (the listener requires it).
 *
 * NOTE (WARP-1062 doc-truth): docker-compose.yml does NOT wire this file —
 * the orchestrator healthcheck there is an inline plain-HTTP `node -e fetch`
 * one-liner. Switching compose to ["CMD", "node", "dist/healthcheck.js"] is
 * part of the separate mesh-mTLS enablement work (a plain-HTTP healthcheck
 * dies the moment DROPLET_INTERNAL_TLS=1 turns the listener into HTTPS).
 */
import { internalTlsEnabled, internalFetch } from "./lib/internal-tls.js";

const scheme = internalTlsEnabled() ? "https" : "http";
const url = `${scheme}://localhost:${process.env.PORT ?? "3000"}/api/orchestrator/health`;

internalFetch(url)
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
