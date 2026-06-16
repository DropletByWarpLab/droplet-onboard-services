/**
 * HTTP client for the file-indexer service.
 *
 * The file-indexer is otherwise MQTT/watcher-driven; its only HTTP
 * surface is the WARP-287 admin re-index endpoint and the WARP-598
 * /health liveness probe. This client is the orchestrator-side health
 * probe used by the health-monitor (file-indexer is a SOFT dependency:
 * search/indexing degrades gracefully, the appliance stays usable).
 */
import { config } from "../config.js";

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${config.FILE_INDEXER_URL}/health`, {
      signal: AbortSignal.timeout(4_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
