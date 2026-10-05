"use client";

import { useRef, type JSX, type KeyboardEvent } from "react";
import { Skel } from "@/components/projects/bits";
import { QUEUE_LABELS } from "./support-config";
import { SUPPORT_QUEUES, type Desk, type QueueCounts, type SupportQueue } from "./types";

/** The queues, with live counts, and a desk switcher once there is more than one
 *  desk. Every queue is a real button (`aria-current` on the active one); the
 *  arrow keys move between them. Counts are skeletons until they load — a `0`
 *  must mean "loaded and empty", never "still loading". */
export function QueueRail({
  counts,
  queue,
  onQueue,
  desks,
  deskId,
  onDesk,
}: {
  counts: QueueCounts | undefined;
  queue: SupportQueue;
  onQueue: (q: SupportQueue) => void;
  desks: Desk[];
  deskId: string | null;
  onDesk: (id: string | null) => void;
}): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    refs.current[(i + step + SUPPORT_QUEUES.length) % SUPPORT_QUEUES.length]?.focus();
  };

  return (
    <nav className="sp-rail" aria-label="Ticket queues">
      {desks.length > 1 && (
        <select
          className="pm-input"
          aria-label="Service desk"
          value={deskId ?? ""}
          onChange={(e) => onDesk(e.target.value || null)}
          style={{ marginBottom: 8 }}
        >
          <option value="">All desks</option>
          {desks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}
      <div className="sp-rail-h">Queues</div>
      {SUPPORT_QUEUES.map((q, i) => (
        <button
          key={q}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          className={"sp-q" + (q === queue ? " on" : "")}
          aria-current={q === queue ? "true" : undefined}
          onClick={() => onQueue(q)}
          onKeyDown={(e) => onKey(e, i)}
        >
          <span>{QUEUE_LABELS[q]}</span>
          {counts ? <span className="n">{counts[q]}</span> : <Skel w={18} h={11} />}
        </button>
      ))}
    </nav>
  );
}
