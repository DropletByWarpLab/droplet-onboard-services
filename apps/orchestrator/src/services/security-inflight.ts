/**
 * WARP-2978 PR-D (ADR-059 P3 spec §6.12, D35, R1) — the in-flight map: the
 * people Frigate is tracking right now, as far as Droplet heard.
 *
 * Why it exists: a Frigate detection is stored on `end`, and a person who
 * stands still may not end for many minutes — without this, an intruder
 * rummaging for ten minutes alerts after ten minutes. camera.service.ts feeds
 * every RAW `new`/`update`/`end` message here (the same raw path as the
 * ingest, before camera-event-gate, which drops a second person while one is
 * tracked). Each incident tick asks `due()` BEFORE triage and writes one
 * `detection_ongoing` row per person tracked for 30 s (security-incidents.service.ts),
 * so the after-hours alert goes out at about 30 s, not at `end`.
 *
 * The rules:
 *   · persons only (`SECURITY_ONGOING_LABEL`): a parked car is tracked for
 *     hours and would fill the map with vehicles;
 *   · at most INFLIGHT_MAX_ENTRIES, the oldest evicted; an entry whose
 *     tracking started more than INFLIGHT_MAX_AGE_MS ago is dropped;
 *   · `end` deletes the entry. A camera that stops reporting (or is disabled)
 *     is tracking nobody, so its entries go; Frigate itself going offline
 *     (source_offline) clears the map — its objects never end;
 *   · due = tracked ≥ SECURITY_ONGOING_AFTER_MS, best score ≥
 *     SECURITY_MIN_SCORE, not Frigate's false positive, no ongoing row yet;
 *   · in memory only: a restart forgets it, and then only the `end` row
 *     alerts (accepted, spec §6.12). A person still tracked after the
 *     restart is re-learned from Frigate's next `update`; their ongoing row
 *     is found by its key rather than written twice.
 *
 * `inView` is the other half. A person still in view keeps their incident
 * from sealing (security-incidents.service.ts step 5): the ongoing row only
 * proves presence up to when it was written, and without the hold an
 * incident sealed after 6½ quiet minutes would shut out the `end` row of the
 * very person it is about — a second alert for one visit. An ended object
 * still counts for INFLIGHT_END_GRACE_MS, so the `end` row (written from the
 * same message) is triaged before the incident can seal.
 */
import {
  parseFrigateInflight,
  SECURITY_MIN_SCORE,
  SECURITY_ONGOING_AFTER_MS,
  SECURITY_ONGOING_LABEL,
  type OngoingObject,
} from "./security-event-ingest.js";

/** The map never holds more people than this; the oldest is evicted. */
export const INFLIGHT_MAX_ENTRIES = 256;
/** Tracking that started longer ago than this is dropped (a stuck object, or an `end` Droplet never heard). */
export const INFLIGHT_MAX_AGE_MS = 6 * 3_600_000;
/** How long an ENDED person with an ongoing row still holds their incident open: the incident engine's settle (SETTLE_MS). */
export const INFLIGHT_END_GRACE_MS = 90_000;

interface Entry {
  id: string;
  camera: string;
  label: string;
  startedAt: Date;
  topScore: number | null;
  falsePositive: boolean;
  enteredZones: string[];
  /** The last message about it. */
  seenAt: Date;
  /** Its `detection_ongoing` row exists (written, or found already stored). */
  written: boolean;
}

export interface InflightTracker {
  /** Feed one raw `frigate/events` message (parsed JSON), before the gate. */
  observe(message: unknown, now: Date): void;
  /** A camera stopped reporting or was disabled: forget its people. `null` = Frigate itself (source_offline): forget everyone. */
  forgetCamera(camera: string | null): void;
  /** The people due an ongoing row now, oldest first. Drops entries past INFLIGHT_MAX_AGE_MS. */
  due(now: Date): OngoingObject[];
  /** This person's ongoing row exists: never due again. */
  markWritten(id: string): void;
  /** Whether this person is still in view as far as Droplet knows: tracked, or ended less than INFLIGHT_END_GRACE_MS ago with an ongoing row. */
  inView(id: string, now: Date): boolean;
  /** Entries held (tests and logs). */
  size(): number;
}

/** What the incident engine reads (index.ts hands it camera.service's tracker). */
export type OngoingSource = Pick<InflightTracker, "due" | "markWritten" | "inView">;

export function createInflightTracker(
  opts: { maxEntries?: number; maxAgeMs?: number; endGraceMs?: number } = {},
): InflightTracker {
  const maxEntries = opts.maxEntries ?? INFLIGHT_MAX_ENTRIES;
  const maxAgeMs = opts.maxAgeMs ?? INFLIGHT_MAX_AGE_MS;
  const endGraceMs = opts.endGraceMs ?? INFLIGHT_END_GRACE_MS;
  /** Insertion order = the order Droplet first heard of each person: the first key is the oldest. */
  const inflight = new Map<string, Entry>();
  /** Ended people whose ongoing row exists → when they ended. */
  const ended = new Map<string, number>();

  const tooOld = (e: Pick<Entry, "startedAt">, now: Date) => now.getTime() - e.startedAt.getTime() > maxAgeMs;

  function prune(now: Date): void {
    for (const [id, e] of inflight) if (tooOld(e, now)) inflight.delete(id);
    for (const [id, at] of ended) if (now.getTime() - at >= endGraceMs) ended.delete(id);
  }

  return {
    observe(message, now) {
      const r = parseFrigateInflight(message);
      if (!r) return;
      if (r.type === "end") {
        const e = inflight.get(r.id);
        inflight.delete(r.id);
        if (e?.written) {
          ended.delete(r.id);
          ended.set(r.id, now.getTime());
          while (ended.size > maxEntries) ended.delete(ended.keys().next().value!);
        }
        return;
      }
      const prior = inflight.get(r.id);
      // Not a person (or no longer one — Frigate relabelled it), or tracked too long: not ours to hold.
      if (r.label !== SECURITY_ONGOING_LABEL || tooOld(r, now)) {
        inflight.delete(r.id);
        return;
      }
      if (prior) {
        prior.camera = r.camera;
        prior.topScore =
          r.topScore === null ? prior.topScore : prior.topScore === null ? r.topScore : Math.max(prior.topScore, r.topScore);
        prior.falsePositive = r.falsePositive;
        prior.enteredZones = [...new Set([...prior.enteredZones, ...r.enteredZones])].slice(0, 16);
        prior.seenAt = now;
        return;
      }
      prune(now);
      while (inflight.size >= maxEntries) inflight.delete(inflight.keys().next().value!);
      inflight.set(r.id, {
        id: r.id,
        camera: r.camera,
        label: r.label,
        startedAt: r.startedAt,
        topScore: r.topScore,
        falsePositive: r.falsePositive,
        enteredZones: r.enteredZones,
        seenAt: now,
        written: false,
      });
    },

    forgetCamera(camera) {
      if (camera === null) {
        inflight.clear();
        return;
      }
      for (const [id, e] of inflight) if (e.camera === camera) inflight.delete(id);
    },

    due(now) {
      prune(now);
      const out: OngoingObject[] = [];
      for (const e of inflight.values()) {
        if (e.written || e.falsePositive) continue;
        if (e.topScore === null || e.topScore < SECURITY_MIN_SCORE) continue;
        if (now.getTime() - e.startedAt.getTime() < SECURITY_ONGOING_AFTER_MS) continue;
        out.push({
          id: e.id,
          camera: e.camera,
          label: e.label,
          startedAt: e.startedAt,
          topScore: e.topScore,
          enteredZones: [...e.enteredZones],
        });
      }
      return out;
    },

    markWritten(id) {
      const e = inflight.get(id);
      if (e) e.written = true;
    },

    inView(id, now) {
      const e = inflight.get(id);
      if (e) return !tooOld(e, now);
      const at = ended.get(id);
      return at !== undefined && now.getTime() - at < endGraceMs;
    },

    size: () => inflight.size,
  };
}
