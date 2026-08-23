/**
 * WARP-541 — the CANONICAL `event: "update.*"` vocabulary for the OTA
 * update agent. Every structured pino event the lifecycle emits is listed
 * here, in lifecycle order, with the module that emits it. No in-repo
 * design doc carried this list before WARP-541; this module IS the design
 * list now — `events.test.ts` scans the emitting sources and fails the
 * build when an event is emitted but not documented here (or documented
 * but emitted nowhere), so the list cannot drift.
 *
 * Payload rule (WARP-541): event payloads are CONTENT-FREE — versions,
 * digests/SHAs, service names, durations, counts, failure reasons and
 * error strings only. Never tokens, config bytes, or customer data.
 *
 * Log-level convention: debug = every-tick noise (15-min poll chatter),
 * info = something actually moved, warn = refused/degraded-but-handled,
 * error = the appliance needs a human.
 */

/** Canonical event name → what it means + who emits it. */
export const UPDATE_EVENTS = {
  // ── discovery (poller.ts — the 15-minute check tick) ──
  /** debug — a poll tick began. */
  "update.check_started": "poller",
  /** debug — no OTA release published yet (fresh repo; normal). */
  "update.no_release": "poller",
  /**
   * warn — WARP-2133: a releases endpoint 404'd with NO
   * DROPLET_OTA_GITHUB_TOKEN configured. Unauthenticated, a private
   * repo's releases endpoints 404 whether or not releases exist, so
   * this box cannot see its update source at all — a provisioning gap,
   * never to be read as "no release / up to date".
   */
  "update.source_unauthenticated": "poller",
  /** warn — the releases endpoint/asset fetch failed (transient). */
  "update.check_failed": "poller",
  /** warn — cosign REFUSED the manifest signature. No row written. */
  "update.signature_failed": "poller",
  /** warn — the manifest failed schema/parse gates. No row written. */
  "update.verify_failed": "poller",
  /** debug — the WARP-537 trust chain passed for the served release. */
  "update.manifest_verified": "poller",
  /** warn — release is for a different channel than this device. */
  "update.channel_mismatch": "poller",
  /** debug — the served release is already tracked (append-only: one row per release). */
  "update.already_known": "poller",
  /** info — new release verified; `pending` DeviceUpdate row created. */
  "update.pending_created": "poller",
  /** info — WARP-538 window stub (unwired since WARP-539 replaced it). */
  "update.apply_window": "poller",

  // ── audit choke point (transitions.ts — EVERY status write) ──
  /** debug — a DeviceUpdate status advanced (from → to, one per write). */
  "update.status_transition": "transitions",

  // ── apply (apply.ts — pending → verifying → applying → verdict) ──
  /** info — apply deferred: onboarding wizard in progress. */
  "update.apply_deferred": "apply",
  /** info — window reached with autoApply off; waiting for explicit apply. */
  "update.apply_window_waiting": "apply",
  /** warn — the update was REFUSED (schema gate, configs/image signature). */
  "update.rejected": "apply",
  /** warn — transient failure; row stays `verifying` for the next window. */
  "update.apply_retry": "apply",
  /** info — step 1 done: previous digests + configs + schema snapshotted. */
  "update.snapshot_taken": "apply",
  /** info — step 2 done: every release image pulled by digest. */
  "update.images_pulled": "apply",
  /** info — step 3 done: sha256-gated release configs staged. */
  "update.configs_staged": "apply",
  /** info — step 4 done: `prisma migrate deploy` for this build ran. */
  "update.migrations_applied": "apply",
  /** info — verifying → applying committed; container swaps begin. */
  "update.apply_started": "apply",
  /** info — a recreate batch landed (services + release/previous target). */
  "update.services_recreated": "apply",
  /** info — a health gate passed (phase: sidecars | post_swap | rollback). */
  "update.health_gate_passed": "apply",
  /** warn — a health gate FAILED; names the first unhealthy service. */
  "update.health_gate_failed": "apply",
  /** warn — rollback started: restoring configs + previous digests. */
  "update.rollback": "apply",
  /** warn — rollback verdict: previous digests restored and healthy. */
  "update.rolled_back": "apply",
  /** error — terminal failure (rollback also unhealthy, or unparseable row). */
  "update.failed": "apply",
  /** info — sidecars healthy; detached helper is recreating the orchestrator. */
  "update.self_swap_started": "apply",
  /** info — boot resume found a pre-swap `verifying` row; re-running apply. */
  "update.apply_resumed": "apply",
  /** info — boot resume found an in-flight `applying` row (post-swap). */
  "update.resume_applying": "apply",
  /** info — the update is COMMITTED: all services healthy on release digests. */
  "update.committed": "apply",

  // ── boot resume wrapper (index.ts) ──
  /** info — the onStart resume hook settled an interrupted apply. */
  "update.resume": "index",
  /** error — the onStart resume hook itself threw. */
  "update.resume_failed": "index",

  // ── operator settings (settings.ts) ──
  /** info — channel / applyWindowCron / autoApply changed (old → new). */
  "update.settings_changed": "settings",

  // ── host helper boundary (host-compose-runner.ts) ──
  /** error — scripts/lib/apply-update.sh exited non-zero. */
  "update.host_script_failed": "host-compose-runner",

  // ── retention GC (purge-update-backups.ts / purge-self-swap-helpers.ts) ──
  /** info — stale terminal-update rollback backups removed. */
  "update.backup_purged": "purge-update-backups",
  /** warn — one backup dir could not be removed; sweep continued. */
  "update.backup_purge_failed": "purge-update-backups",
  /** info — exited self-swap helper containers reaped (logs captured first). */
  "update.self_swap_helper_purged": "purge-self-swap-helpers",
  /** warn — one helper could not be captured/reaped; sweep continued. */
  "update.self_swap_helper_purge_failed": "purge-self-swap-helpers",
  /** warn — the helper listing itself failed; sweep skipped. */
  "update.self_swap_helper_list_failed": "purge-self-swap-helpers",
} as const;

export type UpdateEventName = keyof typeof UPDATE_EVENTS;

export const UPDATE_EVENT_NAMES = Object.keys(UPDATE_EVENTS) as UpdateEventName[];
