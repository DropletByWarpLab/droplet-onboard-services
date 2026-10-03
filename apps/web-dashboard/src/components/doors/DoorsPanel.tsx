"use client";

/**
 * ADR-055 P4b — the doors list on /doors.
 *
 * One card per door: its name, whether it is in use, what its newest position
 * report says AND WHEN ("Closed since 6:02 PM"), and what that position comes
 * from. A position never appears without its time (`shownPosition`): the box
 * does not age a report into "unknown" on its own, so an old "Closed" is the
 * last thing the door said, and the card shows how old. A door with no
 * position source says plainly that Droplet can't tell whether it is forced or
 * left open (§9.7) — it does not show a position it cannot know.
 *
 * Who: the server lets owners and admins READ; only the OWNER may add, change
 * or retire (§11.4). The controls are not rendered for anyone else — never
 * shown and then refused, because every refusal is an access-denied row on the
 * audit trail. A 403 that arrives anyway (a role that changed under the page)
 * is shown as the friendly toast, closes the form, and takes the controls
 * away for the rest of the visit.
 *
 * Failures are `translateError(err, "doors")` toasts, never the server's
 * message. Retiring keeps the door's events and cannot be undone from here, and
 * the confirmation says exactly that — with Cancel as plain as Retire.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DoorClosed, DoorOpen, Loader2, Pencil, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";
import { deviceTimeZone } from "@/lib/security-time";
import type { useDoors } from "@/lib/hooks/useDoors";
import type { DoorCreateBody, DoorPatchBody, DoorPosition, DoorView } from "@/lib/types";
import { DoorDialog } from "./DoorDialog";
import { COPY, POSITION_LABEL, fill, shownPosition, whenText } from "./door-copy";

type Editor = { mode: "create" } | { mode: "edit"; id: string } | null;

export type DoorsQuery = Pick<ReturnType<typeof useDoors>, "doors" | "error" | "mutate" | "create" | "patch" | "retire">;

/** A position badge's tone: the uncertain ones stand out, and the words carry the meaning either way. */
const BADGE: Record<DoorPosition, string> = {
  open: "badge info",
  closed: "badge muted",
  unknown: "badge warn",
  not_monitored: "badge muted",
};

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

/** True when the box refused a READ because Doors is off for this person or this box (404 module_disabled) or above their role (403). */
export function isRefusal(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404;
}

function Position({ door, now, timeZone }: { door: DoorView; now: Date; timeZone: string }) {
  const position = shownPosition(door);
  if (position === "not_monitored") {
    return <p style={{ margin: 0, fontSize: 13.5, color: "var(--text)" }}>{COPY.notTracked}</p>;
  }
  const since = door.positionSince;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <span className={BADGE[position]} data-position={position}>
        {POSITION_LABEL[position]}
      </span>
      {since ? (
        <time
          dateTime={since}
          title={new Date(since).toLocaleString()}
          style={{ fontSize: 13.5, color: "var(--text)" }}
          data-position-since
        >
          {fill(COPY.since, { when: whenText(since, now, timeZone) })}
        </time>
      ) : (
        <span style={{ fontSize: 13.5, color: "var(--text-muted)" }}>{COPY.noReportYet}</span>
      )}
      {position === "unknown" && since && (
        <span style={{ fontSize: 12.5, color: "var(--text-muted)", flexBasis: "100%" }}>{COPY.stoppedReporting}</span>
      )}
    </div>
  );
}

export function DoorsPanel({ q, now: nowProp, timeZone: zoneProp }: { q: DoorsQuery; now?: Date; timeZone?: string }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const now = nowProp ?? new Date();
  const timeZone = zoneProp ?? deviceTimeZone() ?? "UTC";

  // Owner only (§11.4). Also withdrawn for the visit once the box has said 403.
  const [refused, setRefused] = useState(false);
  const canWrite = user?.role === "owner" && !refused;

  const [editor, setEditor] = useState<Editor>(null);
  const [retiring, setRetiring] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [focusList, setFocusList] = useState(false);

  const all = useMemo(() => q.doors ?? [], [q.doors]);
  const active = useMemo(() => all.filter((d) => d.status === "active"), [all]);
  const retired = useMemo(() => all.filter((d) => d.status === "retired"), [all]);
  const byId = (id: string | null) => (id ? (all.find((d) => d.id === id) ?? null) : null);

  // A retired door's card is gone, and so is the button that opened its
  // confirmation: put focus on the list's heading rather than dropping it to <body>.
  useEffect(() => {
    if (!focusList || retiring !== null) return;
    headingRef.current?.focus();
    setFocusList(false);
  }, [focusList, retiring]);

  const report = (err: unknown) => {
    toast(translateError(err, "doors"), "error");
    if (statusOf(err) === 403) {
      setRefused(true);
      setEditor(null);
      setRetiring(null);
    }
    void q.mutate();
  };

  // The dialog-backed writes rethrow after reporting, so the dialog stays open to retry.
  const onCreate = async (body: DoorCreateBody) => {
    try {
      const r = await q.create(body);
      toast(fill(COPY.added, { name: r.door.name }), "success");
    } catch (err) {
      report(err);
      throw err;
    }
  };
  const onUpdate = async (id: string, body: DoorPatchBody) => {
    try {
      const r = await q.patch(id, body);
      toast(fill(COPY.changed, { name: r.door.name }), "success");
    } catch (err) {
      report(err);
      throw err;
    }
  };
  const retiringDoor = byId(retiring);
  const onRetire = async () => {
    if (!retiringDoor) return;
    try {
      await q.retire(retiringDoor.id);
      toast(fill(COPY.retired, { name: retiringDoor.name }), "success");
      setFocusList(true);
    } catch (err) {
      report(err);
      throw err;
    }
  };

  const editingDoor = editor?.mode === "edit" ? byId(editor.id) : null;

  let body: ReactNode;
  if (q.error && !q.doors) {
    body = (
      <div className="card" role="alert">
        <div className="empty">
          <span className="ei">
            <TriangleAlert size={24} aria-hidden />
          </span>
          <span className="eh">{COPY.loadFailedTitle}</span>
          <span style={{ maxWidth: "44ch" }}>{COPY.loadFailedBody}</span>
          <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => void q.mutate()}>
            <RefreshCw size={16} aria-hidden />
            {COPY.retryLabel}
          </button>
        </div>
      </div>
    );
  } else if (!q.doors) {
    body = (
      <div className="card">
        <div className="empty" aria-busy="true">
          <Loader2 size={20} className="animate-spin" aria-hidden />
          <span className="sr-only">Loading</span>
        </div>
      </div>
    );
  } else if (active.length === 0) {
    body = (
      <div className="card">
        <div className="empty" data-empty={canWrite ? "owner" : "others"}>
          <span className="ei">
            <DoorClosed size={24} aria-hidden />
          </span>
          <span className="eh">{COPY.emptyTitle}</span>
          <span style={{ maxWidth: "44ch" }}>{canWrite ? COPY.emptyOwner : COPY.emptyOthers}</span>
        </div>
      </div>
    );
  } else {
    body = (
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
        {active.map((door) => {
          const titleId = `door-${door.id}-title`;
          return (
            <li key={door.id} className="card" data-door-id={door.id} aria-labelledby={titleId}>
              <div className="card-h" style={{ flexWrap: "wrap" }}>
                <span className="ci">
                  <DoorOpen size={16} aria-hidden />
                </span>
                <h3 className="ct" id={titleId} style={{ margin: 0, overflowWrap: "anywhere", whiteSpace: "normal" }}>
                  {door.name}
                </h3>
                <span className="badge ok" data-status={door.status}>
                  {COPY.statusActive}
                </span>
              </div>
              <Position door={door} now={now} timeZone={timeZone} />
              {door.doorPositionSource !== "none" && (
                <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--text-muted)" }} data-source={door.doorPositionSource}>
                  {door.doorPositionSource === "lock" ? COPY.sourceLock : COPY.sourceSensor}
                </p>
              )}
              {canWrite && (
                // Every card repeats these words; the door's name describes each
                // button, so a screen reader's button list says which door.
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                  <button
                    type="button"
                    className="btn sm"
                    aria-describedby={titleId}
                    onClick={() => setEditor({ mode: "edit", id: door.id })}
                  >
                    <Pencil size={14} aria-hidden />
                    {COPY.edit}
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    aria-describedby={titleId}
                    onClick={() => setRetiring(door.id)}
                  >
                    {COPY.retire}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section aria-labelledby="doors-list-title" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="sect" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <h2 id="doors-list-title" ref={headingRef} tabIndex={-1}>
          {COPY.listTitle}
        </h2>
        {canWrite && (
          <button type="button" className="btn primary" onClick={() => setEditor({ mode: "create" })}>
            <Plus size={16} aria-hidden />
            {COPY.add}
          </button>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", maxWidth: "72ch" }}>{COPY.positionNote}</p>

      {body}

      {retired.length > 0 && (
        <details className="card" data-retired-doors>
          <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
            {COPY.retiredTitle} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>({retired.length})</span>
          </summary>
          <ul className="rows" style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
            {retired.map((door) => (
              <li className="lrow" key={door.id} data-door-id={door.id}>
                <span className="rt">
                  <span className="nm" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                    {door.name}
                  </span>
                  {door.retiredAt && (
                    <span className="sub" style={{ whiteSpace: "normal" }}>
                      {fill(COPY.retiredOn, { when: whenText(door.retiredAt, now, timeZone) })}
                    </span>
                  )}
                </span>
                <span className="badge muted" data-status={door.status}>
                  {COPY.statusRetired}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {canWrite && (
        <>
          <DoorDialog
            open={editor !== null && (editor.mode === "create" || editingDoor !== null)}
            door={editingDoor}
            onClose={() => setEditor(null)}
            onCreate={onCreate}
            onUpdate={onUpdate}
          />
          <ConfirmDialog
            open={retiringDoor !== null}
            title={fill(COPY.retireTitle, { name: retiringDoor?.name ?? "" })}
            description={COPY.retireBody}
            confirmLabel={COPY.retireConfirm}
            variant="destructive"
            onConfirm={onRetire}
            onCancel={() => setRetiring(null)}
          />
        </>
      )}
    </section>
  );
}
