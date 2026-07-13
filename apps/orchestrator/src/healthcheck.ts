/**
 * WARP-236 — container healthcheck client. Exits 0 on 2xx from
 * /api/orchestrator/health, 1 otherwise. Presents the service's own client
 * cert when internal mTLS is enabled (the listener requires it).
 *
 * Wired as the compose healthcheck (["CMD", "node", "dist/healthcheck.js"])
 * by WARP-1061 — the old inline plain-HTTP `node -e fetch` one-liner would
 * mark the container permanently unhealthy the moment DROPLET_INTERNAL_TLS=1
 * turns the :3000 listener into HTTPS.
 */
import { internalTlsEnabled, internalFetch } from "./lib/internal-tls.js";

const scheme = internalTlsEnabled() ? "https" : "http";
const url = `${scheme}://localhost:${process.env.PORT ?? "3000"}/api/orchestrator/health`;

internalFetch(url)
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
