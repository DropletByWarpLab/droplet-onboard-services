/**
 * WARP-2980 (ADR-059 P5 §6.5, §12) — `referenceCells`: the baseline cells
 * computed in TypeScript, straight from the spec's definitions, for the pg
 * property test to compare against the one SQL statement
 * (services/security-baseline-build.ts).
 *
 * The area membership is P2b's OWN in-memory matcher, `zonesForEvent` over
 * `buildZoneIndex` — so a disagreement is the SQL's `link` / `ev_key` drifting
 * from P2b's rules (R6: the SQL matcher is the third expression of them).
 *
 * Written for clarity, not speed: a few hundred events and spans.
 */
import { buildZoneIndex, zonesForEvent, type ActiveZoneLink } from "../../services/security-zones.service.js";
import { parseLinkRef } from "../../services/security-zones.service.js";
import { BASELINE } from "../../lib/security-baseline-math.js";
import type { BaselineSlot } from "../../lib/security-baseline-slots.js";

export interface RefEvent {
  id: bigint;
  source: string;
  kind: string;
  camera: string | null;
  labels: string[];
  cameraZones: string[];
  startedAt: Date;
  endedAt: Date | null;
}

export interface RefSpan {
  camera: string;
  startedAt: Date;
  coveredUntil: Date;
}

/** An active link of an active area, with its area's version. */
export type RefLink = Pick<ActiveZoneLink, "zoneId" | "sourceKind" | "sourceRef"> & { zoneVersion: number };

export interface RefCell {
  zoneKey: string;
  keyKind: "area" | "camera";
  zoneId: string | null;
  camera: string | null;
  zoneVersion: number | null;
  cameras: string[];
  label: string;
  dayType: "weekday" | "weekend";
  hour: number;
  daysObserved: number;
  daysWithEvent: number;
  eventCount: number;
  observedMinutes: number;
  dwellSamples: number;
  durationP99Sec: number | null;
}

export interface ReferenceInput {
  slots: readonly BaselineSlot[];
  windowStart: Date;
  windowEnd: Date;
  events: readonly RefEvent[];
  /** Active links of active areas (what `loadActiveLinks` returns), with each area's version. */
  links: readonly RefLink[];
  spans: readonly RefSpan[];
  onlyZoneIds: readonly string[] | null;
  includeCameraKeys: boolean;
}

const LABEL_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function referenceCells(input: ReferenceInput): RefCell[] {
  const { slots } = input;
  const slotMs = slots.map((s) => s.end.getTime() - s.start.getTime());

  // 1. Observed milliseconds per camera per slot: the UNION of its spans' pieces
  //    in the slot (overlapping spans never count a moment twice), kept at
  //    ≥ 5/6 of the slot (integer arithmetic).
  const pieces = new Map<string, Map<number, Array<[number, number]>>>();
  for (const sp of input.spans) {
    for (let i = 0; i < slots.length; i += 1) {
      const from = Math.max(sp.startedAt.getTime(), slots[i]!.start.getTime());
      const to = Math.min(sp.coveredUntil.getTime(), slots[i]!.end.getTime());
      if (to <= from) continue;
      let perSlot = pieces.get(sp.camera);
      if (!perSlot) pieces.set(sp.camera, (perSlot = new Map()));
      const list = perSlot.get(i) ?? [];
      list.push([from, to]);
      perSlot.set(i, list);
    }
  }
  const camObs = new Map<string, Map<number, number>>();
  for (const [camera, perSlot] of pieces) {
    const kept = new Map<number, number>();
    for (const [i, list] of perSlot) {
      list.sort((a, b) => a[0] - b[0]);
      let ms = 0;
      let [curFrom, curTo] = list[0]!;
      for (const [f, t] of list.slice(1)) {
        if (f <= curTo) curTo = Math.max(curTo, t);
        else {
          ms += curTo - curFrom;
          [curFrom, curTo] = [f, t];
        }
      }
      ms += curTo - curFrom;
      if (ms * 6 >= slotMs[i]! * 5) kept.set(i, ms);
    }
    camObs.set(camera, kept);
  }

  // 2. Areas: the active links of the areas in scope.
  const links = input.links.filter((l) => input.onlyZoneIds === null || input.onlyZoneIds.includes(l.zoneId));
  const areas = new Map<string, { version: number; cams: string[] }>();
  for (const l of links) {
    const parsed = parseLinkRef(l.sourceKind, l.sourceRef);
    if (!parsed) continue;
    const a = areas.get(l.zoneId) ?? { version: l.zoneVersion, cams: [] };
    if (!a.cams.includes(parsed.camera)) a.cams.push(parsed.camera);
    a.version = Math.max(a.version, l.zoneVersion);
    areas.set(l.zoneId, a);
  }
  for (const a of areas.values()) a.cams.sort(byString);

  // 3. Observed slots per key (ms). An area slot needs EVERY linked camera; its time is the least of them.
  const keyObs = new Map<string, Map<number, number>>();
  if (input.includeCameraKeys) {
    for (const [camera, perSlot] of camObs) if (perSlot.size > 0) keyObs.set(`camera:${camera}`, new Map(perSlot));
  }
  for (const [zoneId, a] of areas) {
    const perSlot = new Map<number, number>();
    for (let i = 0; i < slots.length; i += 1) {
      const each = a.cams.map((c) => camObs.get(c)?.get(i));
      if (each.every((ms): ms is number => ms !== undefined)) perSlot.set(i, Math.min(...each));
    }
    if (perSlot.size > 0) keyObs.set(`area:${zoneId}`, perSlot);
  }

  // 4. Detections in the window, their slot, and every key they belong to (zonesForEvent's rules).
  const index = buildZoneIndex(links);
  const starts = slots.map((s) => s.start.getTime());
  const slotOfMs = (t: number): number => {
    let lo = 0;
    let hi = slots.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < starts[mid]!) hi = mid - 1;
      else if (t >= slots[mid]!.end.getTime()) lo = mid + 1;
      else return mid;
    }
    return -1;
  };
  interface Obs {
    key: string;
    label: string;
    slot: number;
    dur: number | null;
  }
  const evObs: Obs[] = [];
  for (const e of input.events) {
    if (e.source !== "frigate" || e.kind !== "detection" || e.camera === null) continue;
    const t = e.startedAt.getTime();
    if (t < input.windowStart.getTime() || t >= input.windowEnd.getTime()) continue;
    const label = e.labels[0];
    if (label === undefined || !LABEL_RE.test(label)) continue;
    const slot = slotOfMs(t);
    if (slot < 0) continue;
    const keys = new Set<string>();
    if (input.includeCameraKeys) keys.add(`camera:${e.camera}`);
    for (const zoneId of zonesForEvent({ source: "frigate", kind: "detection", camera: e.camera, cameraZones: e.cameraZones }, index)) {
      keys.add(`area:${zoneId}`);
    }
    const dur = e.endedAt === null ? null : (e.endedAt.getTime() - e.startedAt.getTime()) / 1000;
    for (const key of keys) if (keyObs.get(key)?.has(slot)) evObs.push({ key, label, slot, dur });
  }

  // 5. Labels per key: the tracked four, then the most frequent others, ≤ 8.
  const out: RefCell[] = [];
  const pairs = new Map<string, { dayType: "weekday" | "weekend"; hour: number }>();
  for (const s of slots) pairs.set(`${s.dayType}:${s.hour}`, { dayType: s.dayType, hour: s.hour });
  for (const [key, observed] of keyObs) {
    const counts = new Map<string, number>();
    for (const o of evObs) if (o.key === key) counts.set(o.label, (counts.get(o.label) ?? 0) + 1);
    const fixed = new Set<string>(BASELINE.labels);
    const ranked = [...new Set([...fixed, ...counts.keys()])].sort(
      (a, b) =>
        Number(fixed.has(b)) - Number(fixed.has(a)) || (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || byString(a, b),
    );
    const labels = ranked.slice(0, BASELINE.maxLabelsPerKey);
    const isArea = key.startsWith("area:");
    const zoneId = isArea ? key.slice(5) : null;
    const camera = isArea ? null : key.slice(7);
    const area = zoneId ? areas.get(zoneId)! : null;

    for (const label of labels) {
      for (const { dayType, hour } of pairs.values()) {
        const inCell = (i: number) => slots[i]!.dayType === dayType && slots[i]!.hour === hour;
        let n = 0;
        let ms = 0;
        for (const [i, v] of observed) {
          if (!inCell(i)) continue;
          n += 1;
          ms += v;
        }
        const here = evObs.filter((o) => o.key === key && o.label === label && inCell(o.slot));
        const d = new Set(here.map((o) => slots[o.slot]!.ymd)).size;
        const around = new Set([(hour + 23) % 24, hour, (hour + 1) % 24]);
        const durs = evObs
          .filter(
            (o) =>
              o.key === key &&
              o.label === label &&
              label === "person" &&
              o.dur !== null &&
              o.dur >= 0 &&
              slots[o.slot]!.dayType === dayType &&
              around.has(slots[o.slot]!.hour),
          )
          .map((o) => o.dur!)
          .sort((a, b) => a - b);
        // percentile_disc(0.99): the first value whose cumulative share reaches 0.99.
        const p99 = durs.length === 0 ? null : durs[Math.max(1, Math.ceil(0.99 * durs.length)) - 1]!;
        out.push({
          zoneKey: key,
          keyKind: isArea ? "area" : "camera",
          zoneId,
          camera,
          zoneVersion: area ? area.version : null,
          cameras: area ? area.cams : [camera!],
          label,
          dayType,
          hour,
          daysObserved: n,
          daysWithEvent: d,
          eventCount: here.length,
          observedMinutes: Math.round(ms / 60_000),
          dwellSamples: durs.length,
          durationP99Sec: p99,
        });
      }
    }
  }
  return out;
}
