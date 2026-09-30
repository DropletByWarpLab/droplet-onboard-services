"use client";

/**
 * WARP-2977 P2b (ADR-059 §3.4) — "What covers it?": which cameras, or which
 * parts of a camera's view, an area is watched through.
 *
 * A checklist per camera: its "Whole view", and nested under it the parts of
 * the picture marked in its camera settings (Frigate zones — never called
 * that here). One Save sends the whole desired set with the `expectedVersion`
 * the checklist was filled from (PUT /api/security/zones/:id/links); the
 * server works out what was added, removed or re-added and audits it once.
 *
 * Every linked source stays in the set until someone unticks it, and where it
 * shows depends on the link's status from GET /api/security/sources — never
 * on its absence from the camera list alone:
 *   - `missing` (a camera deleted or renamed, a part removed in its settings)
 *     → ticked under "Not set up any more"; left ticked, it covers the area
 *     again if a camera comes back under that name.
 *   - a part the list doesn't show but that isn't `missing` — the camera
 *     system was down, so /sources listed the camera with NO parts — stays
 *     under its camera, ticked, like any other part.
 *   - anything else unlisted and not `missing` → "Couldn't check these".
 * The server only verifies NEW links, so keeping one is always allowed.
 *
 * WARP-2979 — a pending Droplet suggestion for this area is an unticked row
 * tagged "Suggested by Droplet"; ticking it and saving sends it in the set,
 * and the server accepts it (a person's link from then on).
 *
 * Presentational: the Areas panel does the write and shows failures; this
 * stays open on a rejection. A right-edge side panel (a sheet on a phone), so
 * it owns a labelled Close control (WARP-1787).
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type {
  SecurityLinkStatus,
  SecurityZoneLinkView,
  SecurityZoneLinksBody,
  SecurityZoneSourceKind,
  SecuritySourcesView,
  SecurityZoneView,
} from "@/lib/types";

/** The server's cap on one area's active links. */
export const AREA_LINK_LIMIT = 32;

export const COPY = {
  title: "What covers {name}?",
  sub: "Tick the cameras that see this area. If only part of a camera's picture shows it, tick just that part.",
  wholeView: "Whole view",
  partsCaption: "Or only part of the view:",
  noParts: "Only the whole view. You can mark parts of this camera's picture in its camera settings.",
  goneLegend: "Not set up any more",
  goneHint: "Untick these to take them off. If a camera comes back under the same name, it covers this area again.",
  uncheckedLegend: "Couldn't check these",
  uncheckedHint: "Droplet couldn't check these just now. They still cover this area unless you untick them.",
  noCameras: "No cameras are set up yet. Add one on the Cameras page, then come back here.",
  cameraSystemDown: "Droplet couldn't check the camera system, so parts of a camera's view may be missing from this list.",
  sourcesDown: "Droplet couldn't load the cameras just now.",
  retry: "Retry",
  overLimit: "An area can be covered by up to 32 cameras and parts. Untick some to save.",
  cancel: "Cancel",
  save: "Save",
  wholeViewPhrase: "{camera} (whole view)",
  partPhrase: "{camera} (the '{part}' part of the view)",
  suggested: "Suggested by Droplet",
} as const;

/** Fill `{name}`-style holes in a COPY template. */
export function fillCopy(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? values[k] : m));
}

/** The Frigate camera a link points at — the part of `sourceRef` before any `/`. */
export function cameraOf(sourceRef: string): string {
  const slash = sourceRef.indexOf("/");
  return slash === -1 ? sourceRef : sourceRef.slice(0, slash);
}

/** A camera_zone link's part (its Frigate zone key) — ALWAYS `sourceRef` after the first `/`. */
export function partOf(sourceRef: string): string {
  return sourceRef.slice(sourceRef.indexOf("/") + 1);
}

/**
 * "Front camera (whole view)" / "Back camera (the 'till' part of the view)".
 * `label` is always the CAMERA's display name and never includes the part
 * (the wire contract on SecurityZoneLinkView.label).
 */
export function linkPhrase(link: Pick<SecurityZoneLinkView, "sourceKind" | "sourceRef" | "label">): string {
  return link.sourceKind === "camera_zone"
    ? fillCopy(COPY.partPhrase, { camera: link.label, part: partOf(link.sourceRef) })
    : fillCopy(COPY.wholeViewPhrase, { camera: link.label });
}

const keyOf = (sourceKind: SecurityZoneSourceKind, sourceRef: string) => `${sourceKind}:${sourceRef}`;

interface Option {
  key: string;
  sourceKind: SecurityZoneSourceKind;
  sourceRef: string;
}

export interface AreaLinksDialogProps {
  open: boolean;
  /** The area, as the panel's list currently has it (its version moves after a save or a refresh). */
  zone: SecurityZoneView | null;
  /** GET /api/security/sources; null while loading or when it failed. */
  sources: SecuritySourcesView | null;
  sourcesError?: Error;
  /** WARP-2979 — Droplet's open suggestions for this area (tagged, unticked). */
  suggested?: ReadonlyArray<{ sourceKind: SecurityZoneSourceKind; sourceRef: string }>;
  onRetrySources: () => void;
  onClose: () => void;
  /** Reject to keep the dialog open (the caller shows the error). */
  onSave: (id: string, body: SecurityZoneLinksBody) => Promise<unknown>;
}

export function AreaLinksDialog({
  open,
  zone,
  sources,
  sourcesError,
  suggested = [],
  onRetrySources,
  onClose,
  onSave,
}: AreaLinksDialogProps) {
  const suggestedKeys = new Set(suggested.map((s) => keyOf(s.sourceKind, s.sourceRef)));
  const uid = useId();
  const titleId = `${uid}-title`;
  const subId = `${uid}-sub`;

  const linkedKeys = useMemo(
    () => (zone ? zone.links.map((l) => keyOf(l.sourceKind, l.sourceRef)) : []),
    [zone],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(linkedKeys));
  const [base, setBase] = useState<{ version: number; keys: ReadonlySet<string> }>(() => ({
    version: zone?.version ?? 0,
    keys: new Set(linkedKeys),
  }));
  const [pending, setPending] = useState(false);

  // Refill on every open, and whenever the area moves to a new version (a
  // refresh after someone else's save): Save must send the version the ticks
  // on screen came from, never a newer one it has not shown.
  useEffect(() => {
    if (!open || !zone) return;
    setSelected(new Set(linkedKeys));
    setBase({ version: zone.version, keys: new Set(linkedKeys) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, zone?.id, zone?.version]);

  // Every option in display order: each camera's whole view then its parts,
  // then the links that couldn't be checked, then the ones that are gone.
  const { cameraGroups, unchecked, gone, options } = useMemo(() => {
    const partOption = (camera: string, part: string) => ({
      part,
      option: {
        key: keyOf("camera_zone", `${camera}/${part}`),
        sourceKind: "camera_zone" as const,
        sourceRef: `${camera}/${part}`,
      },
    });
    const groups = (sources?.cameras ?? []).map((c) => ({
      name: c.name,
      label: c.label,
      whole: { key: keyOf("camera", c.name), sourceKind: "camera" as const, sourceRef: c.name },
      parts: c.parts.map((p) => partOption(c.name, p)),
    }));
    const byCamera = new Map(groups.map((g) => [g.name, g]));
    const listed = new Set<string>();
    for (const g of groups) {
      listed.add(g.whole.key);
      for (const p of g.parts) listed.add(p.option.key);
    }
    const status = new Map<string, SecurityLinkStatus>((sources?.linkStatus ?? []).map((s) => [s.linkId, s.status]));
    const goneLinks: SecurityZoneLinkView[] = [];
    const uncheckedLinks: SecurityZoneLinkView[] = [];
    for (const l of sources ? (zone?.links ?? []) : []) {
      const key = keyOf(l.sourceKind, l.sourceRef);
      if (listed.has(key)) continue;
      // Only the server's `missing` says a source is gone. With the camera
      // system down, every part is unlisted and `unknown` — not gone.
      if (status.get(l.id) === "missing") {
        goneLinks.push(l);
        continue;
      }
      const owner = l.sourceKind === "camera_zone" ? byCamera.get(cameraOf(l.sourceRef)) : undefined;
      if (owner) {
        owner.parts.push(partOption(owner.name, partOf(l.sourceRef)));
        listed.add(key);
      } else {
        uncheckedLinks.push(l);
      }
    }
    const all: Option[] = [];
    for (const g of groups) {
      all.push(g.whole);
      for (const p of g.parts) all.push(p.option);
    }
    for (const l of [...uncheckedLinks, ...goneLinks]) {
      all.push({ key: keyOf(l.sourceKind, l.sourceRef), sourceKind: l.sourceKind, sourceRef: l.sourceRef });
    }
    return { cameraGroups: groups, unchecked: uncheckedLinks, gone: goneLinks, options: all };
  }, [sources, zone]);

  const dirty = selected.size !== base.keys.size || [...selected].some((k) => !base.keys.has(k));
  const overLimit = selected.size > AREA_LINK_LIMIT;
  const canSave = Boolean(zone && sources) && dirty && !overLimit && !pending;

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const save = async () => {
    if (!zone || !canSave) return;
    const seen = new Set<string>();
    const links: SecurityZoneLinksBody["links"] = [];
    for (const o of options) {
      if (!selected.has(o.key) || seen.has(o.key)) continue;
      seen.add(o.key);
      links.push({ sourceKind: o.sourceKind, sourceRef: o.sourceRef });
    }
    setPending(true);
    try {
      await onSave(zone.id, { links, expectedVersion: base.version });
      onClose();
    } catch {
      // The caller has already shown why; stay open so the person can retry.
    } finally {
      setPending(false);
    }
  };

  const checkbox = (id: string, key: string, label: string) => (
    <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 32 }}>
      <input
        id={id}
        type="checkbox"
        checked={selected.has(key)}
        onChange={() => toggle(key)}
        style={{ width: 18, height: 18, flexShrink: 0, accentColor: "var(--brand)" }}
      />
      <label htmlFor={id} style={{ fontSize: 13.5, color: "var(--text)", overflowWrap: "anywhere" }}>
        {label}
      </label>
      {suggestedKeys.has(key) && (
        <span className="badge muted" data-suggested={key}>
          {COPY.suggested}
        </span>
      )}
    </div>
  );

  const fieldsetStyle = {
    margin: 0,
    padding: "12px 14px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-input)",
    minWidth: 0,
  } as const;
  const legendStyle = { padding: "0 6px", fontSize: 13.5, fontWeight: 600, color: "var(--text)" } as const;
  const noteStyle = { margin: 0, fontSize: 12.5, color: "var(--text-muted)" } as const;

  let body: ReactNode;
  if (!sources && sourcesError) {
    body = (
      <div role="alert" style={{ display: "grid", gap: 10, justifyItems: "start" }}>
        <p style={noteStyle}>{COPY.sourcesDown}</p>
        <button type="button" className="btn sm" onClick={onRetrySources}>
          <RefreshCw size={14} aria-hidden />
          {COPY.retry}
        </button>
      </div>
    );
  } else if (!sources) {
    body = (
      <div aria-busy="true" style={{ display: "flex", justifyContent: "center", padding: 24 }}>
        <Loader2 size={20} className="animate-spin" aria-hidden />
      </div>
    );
  } else {
    body = (
      <>
        {sources.frigate === "unavailable" && <p style={noteStyle}>{COPY.cameraSystemDown}</p>}
        {cameraGroups.length === 0 && unchecked.length === 0 && gone.length === 0 && (
          <p style={noteStyle}>{COPY.noCameras}</p>
        )}
        {cameraGroups.map((g, i) => (
          <fieldset key={g.name} style={fieldsetStyle} data-camera={g.name}>
            <legend style={legendStyle}>{g.label}</legend>
            {checkbox(`${uid}-c${i}`, g.whole.key, COPY.wholeView)}
            {g.parts.length === 0 ? (
              // With the camera system down no camera has parts listed, so
              // "only the whole view" would be a guess; the note above covers it.
              sources.frigate === "ok" && <p style={{ ...noteStyle, marginTop: 4 }}>{COPY.noParts}</p>
            ) : (
              <div style={{ paddingLeft: 28, marginTop: 4 }}>
                <p style={{ ...noteStyle, marginBottom: 2 }}>{COPY.partsCaption}</p>
                {g.parts.map((p, j) => checkbox(`${uid}-c${i}-p${j}`, p.option.key, p.part))}
              </div>
            )}
          </fieldset>
        ))}
        {unchecked.length > 0 && (
          <fieldset style={fieldsetStyle} data-unchecked="true">
            <legend style={legendStyle}>{COPY.uncheckedLegend}</legend>
            <p style={{ ...noteStyle, marginBottom: 4 }}>{COPY.uncheckedHint}</p>
            {unchecked.map((l, k) => checkbox(`${uid}-u${k}`, keyOf(l.sourceKind, l.sourceRef), linkPhrase(l)))}
          </fieldset>
        )}
        {gone.length > 0 && (
          <fieldset style={fieldsetStyle} data-gone="true">
            <legend style={legendStyle}>{COPY.goneLegend}</legend>
            <p style={{ ...noteStyle, marginBottom: 4 }}>{COPY.goneHint}</p>
            {gone.map((l, k) => checkbox(`${uid}-g${k}`, keyOf(l.sourceKind, l.sourceRef), linkPhrase(l)))}
          </fieldset>
        )}
        {overLimit && (
          <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger)" }}>
            {COPY.overLimit}
          </p>
        )}
      </>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} placement="right" labelledBy={titleId} describedBy={subId} flush>
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h2
            id={titleId}
            style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text)", overflowWrap: "anywhere" }}
          >
            {fillCopy(COPY.title, { name: zone?.name ?? "" })}
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>

        <div style={{ display: "grid", gap: 14, padding: 20, flex: 1, alignContent: "start" }}>
          <p id={subId} style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
            {COPY.sub}
          </p>
          {body}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            flexWrap: "wrap",
            gap: 8,
            padding: "14px 20px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <button type="button" className="btn ghost" onClick={onClose} disabled={pending}>
            {COPY.cancel}
          </button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={!canSave}>
            {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
            {COPY.save}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
