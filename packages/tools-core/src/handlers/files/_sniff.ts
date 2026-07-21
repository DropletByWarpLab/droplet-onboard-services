/**
 * WARP-1372 — undeclared-content text sniffer shared by `read-file.ts` and
 * `summarize-file.ts`. Mirrors the file-indexer's sniffer (watcher.py,
 * WARP-1139).
 */

// Bytes sniffed when the content-type header doesn't declare a texty type.
export const SNIFF_BYTES = 4096;

/**
 * WARP-1372 — is this undeclared content readable text? The download proxy
 * reports application/octet-stream for plainly-readable files (md/csv/txt),
 * so the header alone must never be grounds for refusal. UTF-8-decode a
 * bounded head: a NUL byte or a hard decode error away from the boundary
 * means genuinely binary; a multibyte char split at the very end is fine.
 */
export function sniffIsText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // Tolerate up to 3 trailing bytes of a char truncated by the sniff window.
  for (let trim = 0; trim <= 3 && trim < head.length; trim++) {
    try {
      decoder.decode(head.subarray(0, head.length - trim));
      return true;
    } catch {
      // Only a boundary truncation is forgivable — keep trimming; a decode
      // error that survives all trims is real binary content.
    }
  }
  return false;
}
