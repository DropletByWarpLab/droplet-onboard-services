/** Shared data contracts for Microsoft auth, sync and workload landing. */
import type { DueCursor } from "./delta-cursor.service.js";
import type { GraphPage } from "./graph-client.js";

/** Internal generation marker: a late Graph refusal can affect only this grant. */
export interface M365GrantGeneration {
  tokenCacheEnc: string | null;
  cursorLinkHash?: string | null;
  connectedAt?: Date | null;
  calendarEnabled?: boolean;
  calendarSourceId?: string | null;
  mailEnabled?: boolean;
  emailAccountId?: string | null;
}

/**
 * Where a page sits in the enumeration it belongs to — the one fact only the
 * engine knows, and the one a handler that LANDS needs to remove what is gone.
 *
 * A run that starts from scratch (a first sync, or a resync after Microsoft
 * dropped the token) returns the CURRENT state and says nothing about what was
 * deleted in between, so a handler must delete what such a run did not return.
 * It can only do that if it is told when a full enumeration starts and when it
 * ends — and "ends" is not "this tick ends": a big source takes many ticks, each
 * resuming from a checkpoint (WARP-3059).
 *
 *   - `fullEnumeration` — the enumeration this page belongs to began from
 *     scratch: the cursor had no delta link when it was claimed. True for a first
 *     sync, a resync, and every tick that RESUMES one; false for an incremental
 *     run (and for resuming one), which must never delete anything the feed did
 *     not say was deleted.
 *   - `isFirstPage` — the first page of the enumeration, read in THIS tick: a
 *     tick that resumes from a checkpoint never sees it, because the first page
 *     was read by an earlier tick.
 *   - `isLastPage` — the page that carries the delta link, wherever in the
 *     enumeration's ticks it falls. It may carry no items at all.
 *
 * Computed from the cursor as it was CLAIMED, never from what the run has done
 * since: a page that fails and is retried is told the same thing it was told
 * the first time, which is what makes a handler's mark and sweep idempotent.
 */
export interface PageContext {
  readonly fullEnumeration: boolean;
  readonly isFirstPage: boolean;
  readonly isLastPage: boolean;
}

/** What a caller does with a page of changes. Injected into the sync engine. */
export type PageHandler = (
  cursor: DueCursor,
  page: GraphPage,
  run: PageContext,
) => Promise<void> | void;
