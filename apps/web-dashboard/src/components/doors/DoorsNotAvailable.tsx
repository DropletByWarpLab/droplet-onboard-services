"use client";

/**
 * ADR-055 P4b — the /doors page's own "not available" state.
 *
 * `ModuleRouteGuard` is the front line: with Doors off for this box or this
 * person it shows its card and this page never renders. This is defence in
 * depth for the case the guard cannot see, because the guard fails OPEN (a
 * blip in GET /api/modules must not blank a shipping page) and the box's own
 * answer is the boundary: a doors read that comes back 404 or 403 means Doors
 * is off, or not part of this person's access. Same words as the guard's card,
 * so there is one wording, and reason-free on purpose: the box answers a
 * per-person denial and a switched-off module identically.
 */
import Link from "next/link";
import { ArrowRight, DoorOpen } from "lucide-react";
import { COPY } from "./door-copy";

export function DoorsNotAvailable() {
  return (
    <div className="card" data-testid="doors-not-available">
      <div className="empty">
        <span className="ei">
          <DoorOpen size={24} aria-hidden />
        </span>
        <h2 className="eh" style={{ margin: 0 }}>
          {COPY.notAvailableTitle}
        </h2>
        <p style={{ margin: 0, maxWidth: "48ch" }}>{COPY.notAvailableBody}</p>
        <Link href="/" className="btn" style={{ marginTop: 8 }}>
          {COPY.backHome}
          <ArrowRight size={14} aria-hidden />
        </Link>
      </div>
    </div>
  );
}
