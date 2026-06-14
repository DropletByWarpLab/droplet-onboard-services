/**
 * HTTP client for the file-indexer service.
 *
 * The file-indexer is otherwise MQTT/watcher-driven; its only HTTP
 * surface is the WARP-287 admin re-index endpoint and the WARP-598
 * /health liveness probe. This client is the orchestrator-side health
 * probe used by the health-monitor (file-indexer is a SOFT dependency:
 * search/indexing degrades gracefully, the appliance stays usable).
 *
 * FILE_INDEXER_URL matches the default used by file-reindex.service.ts.
 */

const FILE_INDEXER_URL =
  process.env.FILE_INDEXER_URL ?? "http://file-indexer:8090";

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${FILE_INDEXER_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
