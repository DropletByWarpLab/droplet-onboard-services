/**
 * WARP-225 — wire types for /api/me/context-stats/*.
 *
 * Mirrors the Express response shapes in
 * `apps/orchestrator/src/services/context-stats.service.ts`. Types are
 * duplicated rather than imported from the orchestrator workspace
 * because the dashboard's tsconfig isolates these surfaces (no
 * cross-workspace import path) and the surface is small enough that
 * drift-by-edit is tolerable. Adding a field requires updating both
 * the orchestrator response shape and this file.
 */

/** WARP-1394 — which ingestion pipeline a row came from. */
export type ContextSource = "brain" | "nextcloud";

export type MimeCategory =
  | "audio"
  | "video"
  | "pdf"
  | "image"
  | "email"
  | "archive"
  | "text"
  | "other";

export interface RecentlyIndexedItem {
  id: string;
  filename: string;
  mimeType: string | null;
  category: MimeCategory;
  indexedAt: string;
  chunkCount: number;
  source: ContextSource;
}

export interface ContextStatsSummary {
  files: number;
  chunks: number;
  queued: number;
  failed: number;
  /** WARP-2056 — files the indexer produced no text for. `files` counts
   *  every status, so without this the panel reports a total well above
   *  what is actually searchable and gives the user no way to see the
   *  difference. Surfaced as "Not indexed"; a normal outcome for photos
   *  and installers, so it reads as information rather than an error. */
  skipped: number;
  recentlyIndexed: RecentlyIndexedItem[];
}

export interface SourceCategoryRow {
  category: MimeCategory;
  files: number;
  bytes: number;
}

export interface ThroughputDay {
  day: string; // YYYY-MM-DD
  count: number;
}

export interface PipelineHealthRow {
  category: MimeCategory;
  files: number;
  /** null on 'nextcloud' rows — timing isn't tracked for synced files. */
  avgSecondsToReady: number | null;
  failed: number;
  source: ContextSource;
}

export interface ContextStatsFull extends ContextStatsSummary {
  bytesIndexed: number;
  byCategory: SourceCategoryRow[];
  throughput7d: ThroughputDay[];
  pipelineHealth: PipelineHealthRow[];
}

export interface QueuedItem {
  id: string;
  filename: string;
  mimeType: string | null;
  category: MimeCategory;
  uploadedAt: string;
  reason: string;
  source: ContextSource;
}

export interface FailedItem {
  id: string;
  filename: string;
  mimeType: string | null;
  category: MimeCategory;
  failureReason: string | null;
  lastAttemptedAt: string | null;
  recentAttemptCount: number;
  source: ContextSource;
}
