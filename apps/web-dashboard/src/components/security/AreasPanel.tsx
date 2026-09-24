"use client";

/**
 * WARP-2977 P2b (ADR-059 §3.4) — the body of /security/zones, "Areas".
 *
 * One card per area: its name, its type, and "Covered by: …" naming each
 * camera (or the part of a camera's view) it is linked to. A link whose
 * camera or part has since been deleted or renamed is flagged, never edited
 * behind the owner's back — the server reports each link's status at read
 * time (GET /api/security/sources), and this page shows it.
 *
 * Levels: everyone who can read Security sees the cards (the server has
 * already dropped areas and links the viewer's camera grants hide). Adding,
 * changing what covers an area, removing and restoring are manage-level, and
 * those controls are NOT RENDERED below manage — never shown and then refused,
 * because every refused click writes an access-denied row that the feed's
 * network warnings then surface. `useModuleLevel` fails closed for that
 * reason.
 *
 * Writes go through the `useSecurityZones` hook, which refreshes the area
 * lists and the link statuses itself. A failure is a
 * `translateError(err, "security")` toast (never the server's message), then a
 * refresh through the hooks' own `mutate`, so a version conflict shows the
 * other person's change before the next try.
 *
 * Keyboard: Restore is aria-disabled, never `disabled`, while a restore is in
 * flight — the pressed button keeps focus (a ref refuses the second press, as
 * in ModeCard). A restored area leaves the Removed list, so its button goes
 * with it; focus then moves to the area's first action on its card, where the
 * area now is, instead of dropping to <body>.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, MapPin, Plus, RefreshCw } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { archivedZoneIdOf, translateError } from "@/lib/friendly-errors";
import { levelAtLeast, useModuleLevel } from "@/lib/hooks/useModuleGate";
import { useSecuritySources, useSecurityZones } from "@/lib/hooks/useSecurity";
import type {
  SecurityLinkStatus,
  SecuritySourcesView,
  SecurityZonePatchBody,
  SecurityZoneCreateBody,
  SecurityZoneLinksBody,
  SecurityZoneLinkView,
  SecurityZoneView,
} from "@/lib/types";
import { AreaDialog, KIND_LABEL } from "./AreaDialog";
import { AreaLinksDialog, cameraOf, fillCopy, linkPhrase, partOf } from "./AreaLinksDialog";

export const COPY = {
  title: "Areas",
  sub: "Name the places you care about and say which cameras cover each. The feed then says where things happened.",
  add: "Add an area",
  coveredBy: "Covered by: {links}",
  notCovered: "No cameras cover this area yet.",
  whatCovers: "What covers it?",
  edit: "Change",
  remove: "Remove area",
  removeTitle: "Remove {name}?",
  removeBody: "Events stay in the feed. They just won't be labelled {name} any more. You can restore it later.",
  removeConfirm: "Remove",
  missingCamera: "{camera} isn't set up any more",
  missingPart: "The '{part}' part of {camera} was removed in its camera settings",
  unknown: "Couldn't check the camera system",
  reuseHint: "If a camera comes back under the same name, it covers this area again.",
  emptyTitle: "No areas yet.",
  emptyManage: "Try Front door, Stock room or Car park.",
  emptyOthers: "Someone who manages Security can set these up.",
  removedTitle: "Removed areas",
  restore: "Restore",
  added: "Added {name}. Use What covers it? to choose its cameras.",
  removed: "Removed {name}.",
  restored: "Restored {name}.",
  restoreNamed: "Restore {name}",
  retry: "Retry",
  // A lost race on an area: the panel has already re-read it, so the form or card shows their version.
  conflict: "Someone else changed this area while you were editing. What's shown now is their version, so make your change again.",
  // WARP-2977 P2b-2 — door locks (only people with Devices view see lock links).
  missingLock: "{lock} isn't paired any more",
  unknownLocks: "Couldn't check the door locks",
  lockReuseHint: "A door lock that's paired again shows up as a new lock, so it needs linking to this area again.",
} as const;

type Editor = { mode: "create" } | { mode: "edit"; id: string } | null;

/**
 * The shell's `.badge` is a no-shrink, one-line pill. These carry a sentence
 * ("The 'till' part of Back camera was removed…"), which at 375 px is wider
 * than the card — so they may shrink and wrap instead of widening the page.
 */
const WRAPPING_BADGE = { whiteSpace: "normal", flexShrink: 1, minWidth: 0, maxWidth: "100%" } as const;

/** "Covered by: Front camera (whole view), Back camera (the 'till' part of the view)". */
export function coveredByLine(zone: Pick<SecurityZoneView, "links">): string {
  if (zone.links.length === 0) return COPY.notCovered;
  return fillCopy(COPY.coveredBy, { links: zone.links.map(linkPhrase).join(", ") });
}

/**
 * What to flag on one area's card, from GET /api/security/sources:
 * one warn line per distinct `missing` source (a gone camera reads once, however
 * many of its parts covered the area), and at most one "couldn't check" line
 * per kind. `sources === "failed"` (the request itself failed) means every
 * link is unknown; `null` (still loading) flags nothing yet.
 *
 * WARP-2977 P2b-2 — door locks are their own half: a lock that isn't paired
 * any more is `missingLocks` (a re-paired lock comes back as a NEW lock, so
 * the camera's "comes back under the same name" hint would be wrong), and a
 * smart-home service that couldn't answer is `unknownLocks`.
 */
export function linkProblems(
  zone: Pick<SecurityZoneView, "links">,
  sources: SecuritySourcesView | "failed" | null,
): { missing: string[]; unknown: boolean; missingLocks: string[]; unknownLocks: boolean } {
  const none = { missing: [], unknown: false, missingLocks: [], unknownLocks: false };
  if (sources === null || zone.links.length === 0) return none;
  const isLock = (l: Pick<SecurityZoneLinkView, "sourceKind">) => l.sourceKind === "lock";
  if (sources === "failed") {
    return { ...none, unknown: zone.links.some((l) => !isLock(l)), unknownLocks: zone.links.some(isLock) };
  }
  const status = new Map<string, SecurityLinkStatus>(sources.linkStatus.map((s) => [s.linkId, s.status]));
  const cameras = new Set(sources.cameras.map((c) => c.name));
  const missing = new Set<string>();
  const missingLocks = new Set<string>();
  let unknown = false;
  let unknownLocks = false;
  for (const link of zone.links) {
    const s = status.get(link.id);
    if (isLock(link)) {
      if (s === "unknown") unknownLocks = true;
      if (s === "missing") missingLocks.add(fillCopy(COPY.missingLock, { lock: link.label }));
      continue;
    }
    if (s === "unknown") unknown = true;
    if (s !== "missing") continue;
    // A part whose whole camera is gone reads as the camera being gone.
    if (link.sourceKind === "camera_zone" && cameras.has(cameraOf(link.sourceRef))) {
      missing.add(fillCopy(COPY.missingPart, { part: partOf(link.sourceRef), camera: link.label }));
    } else {
      missing.add(fillCopy(COPY.missingCamera, { camera: link.label }));
    }
  }
  return { missing: [...missing], unknown, missingLocks: [...missingLocks], unknownLocks };
}

export function AreasPanel() {
  const level = useModuleLevel("security");
  const canManage = levelAtLeast(level, "manage");
  const zonesQ = useSecurityZones({ includeArchived: canManage });
  // Fetched at every level: it is view-gated and filtered, and it is what
  // tells a viewer that a link points at a camera that is gone.
  const sourcesQ = useSecuritySources();
  const { toast } = useToast();

  const [editor, setEditor] = useState<Editor>(null);
  const [linksFor, setLinksFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // One Restore at a time: a second click would carry the same (now stale)
  // version and come back as a conflict toast right after the success one.
  const [restoring, setRestoring] = useState<string | null>(null);
  // The in-flight guard itself: Restore stays focusable (aria-disabled), so a
  // second press between renders must be refused here, not by `disabled`.
  const restoringRef = useRef(false);
  // The area whose card should take focus once it is back in the active list.
  const [focusAreaId, setFocusAreaId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const all = useMemo(() => zonesQ.zones ?? [], [zonesQ.zones]);
  const active = useMemo(() => all.filter((z) => z.state === "active"), [all]);

  // Runs after each render that could have brought the restored card in: the
  // refresh lands after the unarchive resolves, so wait until the card exists.
  useEffect(() => {
    if (!focusAreaId) return;
    const card = Array.from(listRef.current?.children ?? []).find(
      (el) => (el as HTMLElement).dataset.zoneId === focusAreaId,
    );
    const target = card?.querySelector<HTMLButtonElement>("button");
    if (target) {
      target.focus();
      setFocusAreaId(null);
    }
  }, [focusAreaId, active]);
  // Below manage the server ignores include=archived; this is the page's own
  // guard that a removed area (and its Restore) never surfaces there anyway.
  const archived = canManage ? all.filter((z) => z.state === "archived") : [];
  const byId = (id: string | null) => (id ? (all.find((z) => z.id === id) ?? null) : null);

  const sourcesForCards: SecuritySourcesView | "failed" | null =
    sourcesQ.sources ?? (sourcesQ.error ? "failed" : null);

  const { mutate: refreshZones } = zonesQ;
  const { mutate: refreshSources } = sourcesQ;
  /**
   * Show a failed write in the Security domain's words, then re-read both
   * lists. A lost race is the panel's own copy: the re-read puts the other
   * person's version in the open form or on the card, so "refresh to see their
   * changes" would be wrong — they are already on screen.
   */
  const report = useCallback(
    (err: unknown) => {
      const code = (err as { code?: unknown } | null)?.code;
      toast(code === "VERSION_CONFLICT" ? COPY.conflict : translateError(err, "security"), "error");
      void refreshZones();
      void refreshSources();
    },
    [toast, refreshZones, refreshSources],
  );

  // The dialog-backed writes rethrow after reporting, so the dialog stays open to retry.
  const onCreate = async (body: SecurityZoneCreateBody) => {
    try {
      const r = await zonesQ.create(body);
      toast(fillCopy(COPY.added, { name: r.zone.name }), "success");
    } catch (err) {
      // The name belongs to a REMOVED area: the toast says so (translateError)
      // and, when that area is in the Removed list, offers to restore it right
      // there — the add dialog closes once it is back.
      const holderId = archivedZoneIdOf(err);
      const holder = holderId ? all.find((z) => z.id === holderId && z.state === "archived") : undefined;
      if (holder) {
        toast(translateError(err, "security"), "error", {
          label: fillCopy(COPY.restoreNamed, { name: holder.name }),
          onClick: () => {
            void onRestore(holder).then((ok) => {
              if (ok) setEditor(null);
            });
          },
        });
        void refreshZones();
        void refreshSources();
      } else {
        report(err);
      }
      throw err;
    }
  };
  const onUpdate = async (id: string, body: SecurityZonePatchBody) => {
    try {
      await zonesQ.patch(id, body);
    } catch (err) {
      report(err);
      throw err;
    }
  };
  const onSaveLinks = async (id: string, body: SecurityZoneLinksBody) => {
    try {
      await zonesQ.putLinks(id, body);
    } catch (err) {
      report(err);
      throw err;
    }
  };
  const onRemove = async () => {
    // The live row, so a retry after a refresh sends the current version.
    const zone = byId(removing);
    if (!zone) return;
    try {
      await zonesQ.archive(zone.id, zone.version);
      toast(fillCopy(COPY.removed, { name: zone.name }), "success");
    } catch (err) {
      report(err);
      throw err;
    }
  };
  /** True when the area is back. */
  const onRestore = async (zone: SecurityZoneView): Promise<boolean> => {
    if (restoringRef.current) return false;
    restoringRef.current = true;
    setRestoring(zone.id);
    try {
      await zonesQ.unarchive(zone.id, zone.version);
      toast(fillCopy(COPY.restored, { name: zone.name }), "success");
      return true;
    } catch (err) {
      report(err);
      return false;
    } finally {
      restoringRef.current = false;
      setRestoring(null);
    }
  };

  const zonesErrorCopy = useMemo(
    () => (zonesQ.error ? translateError(zonesQ.error, "security") : null),
    [zonesQ.error],
  );
  const removingZone = byId(removing);
  const editingZone = editor?.mode === "edit" ? byId(editor.id) : null;

  let body: ReactNode;
  if (zonesErrorCopy && !zonesQ.zones) {
    body = (
      <div className="card">
        <div className="empty" role="alert">
          <span className="ei">
            <MapPin size={24} />
          </span>
          <span style={{ maxWidth: "44ch" }}>{zonesErrorCopy}</span>
          <button type="button" className="btn" onClick={() => void refreshZones()} style={{ marginTop: 8 }}>
            <RefreshCw size={16} aria-hidden />
            {COPY.retry}
          </button>
        </div>
      </div>
    );
  } else if (!zonesQ.zones) {
    body = (
      <div className="card">
        <div className="empty" aria-busy="true">
          <Loader2 size={20} className="animate-spin" aria-hidden />
        </div>
      </div>
    );
  } else if (active.length === 0) {
    body = (
      <div className="card">
        <div className="empty" data-empty={canManage ? "manage" : "view"}>
          <span className="ei">
            <MapPin size={24} />
          </span>
          <span className="eh">{COPY.emptyTitle}</span>
          <span style={{ maxWidth: "44ch" }}>{canManage ? COPY.emptyManage : COPY.emptyOthers}</span>
        </div>
      </div>
    );
  } else {
    body = (
      <ul ref={listRef} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
        {active.map((zone) => {
          const titleId = `area-${zone.id}-title`;
          const problems = linkProblems(zone, sourcesForCards);
          return (
            <li key={zone.id} className="card" data-zone-id={zone.id} aria-labelledby={titleId}>
              <div className="card-h" style={{ flexWrap: "wrap" }}>
                <span className="ci">
                  <MapPin size={16} />
                </span>
                <h2 className="ct" id={titleId} style={{ margin: 0, overflowWrap: "anywhere", whiteSpace: "normal" }}>
                  {zone.name}
                </h2>
                <span className="badge muted" data-kind={zone.kind}>
                  {KIND_LABEL[zone.kind]}
                </span>
              </div>
              <p
                data-covered-by
                style={{ margin: 0, fontSize: 13.5, color: "var(--text)", overflowWrap: "anywhere" }}
              >
                {coveredByLine(zone)}
              </p>
              {(problems.missing.length > 0 ||
                problems.unknown ||
                problems.missingLocks.length > 0 ||
                problems.unknownLocks) && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                  {[...problems.missing, ...problems.missingLocks].map((m) => (
                    <span key={m} className="badge warn" data-link-status="missing" style={WRAPPING_BADGE}>
                      {m}
                    </span>
                  ))}
                  {problems.unknown && (
                    <span className="badge muted" data-link-status="unknown" style={WRAPPING_BADGE}>
                      {COPY.unknown}
                    </span>
                  )}
                  {problems.unknownLocks && (
                    <span className="badge muted" data-link-status="unknown" style={WRAPPING_BADGE}>
                      {COPY.unknownLocks}
                    </span>
                  )}
                </div>
              )}
              {problems.missing.length > 0 && (
                <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{COPY.reuseHint}</p>
              )}
              {problems.missingLocks.length > 0 && (
                <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{COPY.lockReuseHint}</p>
              )}
              {canManage && (
                // Every card repeats these words; the area's name describes each
                // button, so a screen reader's button list says which area.
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                  <button
                    type="button"
                    className="btn sm"
                    aria-describedby={titleId}
                    onClick={() => setLinksFor(zone.id)}
                  >
                    {COPY.whatCovers}
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    aria-describedby={titleId}
                    onClick={() => setEditor({ mode: "edit", id: zone.id })}
                  >
                    {COPY.edit}
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    aria-describedby={titleId}
                    onClick={() => setRemoving(zone.id)}
                  >
                    {COPY.remove}
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
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {canManage && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn primary" onClick={() => setEditor({ mode: "create" })}>
            <Plus size={16} aria-hidden />
            {COPY.add}
          </button>
        </div>
      )}

      {body}

      {archived.length > 0 && (
        <details className="card" data-removed-areas>
          <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
            {COPY.removedTitle} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>({archived.length})</span>
          </summary>
          <ul className="rows" style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
            {archived.map((zone) => (
              <li className="lrow" key={zone.id} data-zone-id={zone.id}>
                <span className="rt">
                  <span className="nm">{zone.name}</span>
                  <span className="sub">{KIND_LABEL[zone.kind]}</span>
                </span>
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`${COPY.restore} ${zone.name}`}
                  aria-disabled={restoring !== null || undefined}
                  onClick={() => {
                    void onRestore(zone).then((ok) => {
                      if (ok) setFocusAreaId(zone.id);
                    });
                  }}
                >
                  {COPY.restore}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {canManage && (
        <>
          <AreaDialog
            open={editor !== null && (editor.mode === "create" || editingZone !== null)}
            zone={editingZone}
            onClose={() => setEditor(null)}
            onCreate={onCreate}
            onUpdate={onUpdate}
          />
          <AreaLinksDialog
            open={linksFor !== null && byId(linksFor) !== null}
            zone={byId(linksFor)}
            sources={sourcesQ.sources}
            sourcesError={sourcesQ.error}
            onRetrySources={() => void refreshSources()}
            onClose={() => setLinksFor(null)}
            onSave={onSaveLinks}
          />
          <ConfirmDialog
            open={removingZone !== null}
            title={fillCopy(COPY.removeTitle, { name: removingZone?.name ?? "" })}
            description={fillCopy(COPY.removeBody, { name: removingZone?.name ?? "" })}
            confirmLabel={COPY.removeConfirm}
            variant="destructive"
            onConfirm={onRemove}
            onCancel={() => setRemoving(null)}
          />
        </>
      )}
    </div>
  );
}
