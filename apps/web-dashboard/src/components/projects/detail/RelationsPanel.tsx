"use client";

// WARP-3520 -- the drawer's Relations section: what this item blocks, what blocks
// it, what it relates to and what it duplicates, with add and remove for
// writers. It reads and writes the existing relations API
// (GET /work-items/:id/relations, POST /work-items/:id/relations,
// DELETE /relations/:id) — the server owns the symmetric-pair storage, the
// cycle refusal and the cross-project rule, and says why in `translateError`'s
// words when it declines a link.

import { useId, useState, type JSX } from "react";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "../icons";
import { editActions, useRelations } from "../useEditing";
import type { PmRelation, PmWorkItem, RelationKind } from "../types";
import { ItemSearchPicker } from "./pickers/ItemSearchPicker";
import "../editing.css";
import "./editors.css";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

/** What the user picks; `blocked_by` is `BLOCKS` stored the other way round. */
type LinkChoice = "blocks" | "blocked_by" | "relates" | "duplicates";

const GROUPS: Array<{ choice: LinkChoice; heading: string; match: (r: PmRelation) => boolean }> = [
  { choice: "blocks", heading: "Blocks", match: (r) => r.kind === "BLOCKS" && r.direction === "blocks" },
  { choice: "blocked_by", heading: "Blocked by", match: (r) => r.kind === "BLOCKS" && r.direction === "blocked_by" },
  { choice: "relates", heading: "Relates to", match: (r) => r.kind === "RELATES" },
  { choice: "duplicates", heading: "Duplicates", match: (r) => r.kind === "DUPLICATES" },
];

/** `from —kind→ to` for a choice made on `item` against `other`. */
function endpoints(choice: LinkChoice, item: string, other: string): { from: string; to: string; kind: RelationKind } {
  switch (choice) {
    case "blocks":
      return { from: item, to: other, kind: "BLOCKS" };
    case "blocked_by":
      return { from: other, to: item, kind: "BLOCKS" };
    case "relates":
      return { from: item, to: other, kind: "RELATES" };
    case "duplicates":
      return { from: item, to: other, kind: "DUPLICATES" };
  }
}

export function RelationsPanel({
  item,
  readOnly,
  onChanged,
}: {
  item: Pick<PmWorkItem, "id">;
  readOnly: boolean;
  /** A link was added or removed — both ends' activity changed. */
  onChanged: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const { relations, mutate } = useRelations(item.id);
  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState<LinkChoice>("relates");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const kindId = useId();

  const list = relations ?? [];

  const fail = (e: unknown, what: string) => {
    const message = translateError(e, "projects");
    setError(message);
    setAnnouncement(`Couldn't ${what}. ${message}`);
    toast(message, "error");
  };

  const add = async (other: PmWorkItem) => {
    setBusy(true);
    setError(null);
    const { from, to, kind } = endpoints(choice, item.id, other.id);
    try {
      await editActions().addRelation(from, to, kind);
      await mutate();
      setAdding(false);
      setAnnouncement(`Linked ${other.key}`);
      onChanged();
    } catch (e) {
      fail(e, "add that link");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (relation: PmRelation) => {
    setError(null);
    // Optimistic: the row goes at once and comes back if the server says no.
    await mutate({ relations: list.filter((r) => r.id !== relation.id) }, { revalidate: false });
    try {
      await editActions().removeRelation(relation.id);
      setAnnouncement(`Removed link to ${relation.relatedKey}`);
      onChanged();
    } catch (e) {
      fail(e, "remove that link");
    } finally {
      await mutate();
    }
  };

  const linked = (other: PmWorkItem) =>
    list.some((r) => r.relatedId === other.id && GROUPS.find((g) => g.choice === choice)?.match(r));

  return (
    <div>
      <div className="pm-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <div className="pm-sect">
          Relations <span className="sx">{list.length}</span>
        </div>
        {!readOnly && !adding && (
          <button type="button" className="pm-btn ghost sm" onClick={() => setAdding(true)}>
            <PmIcon name="plus" size={12} />
            Add link
          </button>
        )}
      </div>
      <span className="pm-sr" role="status" aria-live="polite">
        {announcement}
      </span>

      {list.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--text-4)" }}>No linked items yet.</div>
      ) : (
        GROUPS.map((g) => {
          const rows = list.filter(g.match);
          if (rows.length === 0) return null;
          return (
            <div key={g.choice} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11.5, color: "var(--text-3)", fontWeight: 600, margin: "4px 0" }}>{g.heading}</div>
              {rows.map((r) => (
                <div key={r.id} className="pm-rel-row">
                  <span className="pm-mono" style={{ fontSize: 11, color: "var(--text-4)", flex: "none" }}>
                    {r.relatedKey}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>
                    {r.relatedName}
                  </span>
                  {r.crossProject && (
                    <span className="pm-tag sm" title="This item is in another project">
                      Other project
                    </span>
                  )}
                  {!readOnly && (
                    <button
                      type="button"
                      className="pm-iconbtn"
                      style={{ width: 24, height: 24 }}
                      aria-label={`Remove link to ${r.relatedKey}`}
                      onClick={() => void remove(r)}
                    >
                      <PmIcon name="x" size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          );
        })
      )}

      {adding && !readOnly && (
        <div className="pm-picker" aria-busy={busy}>
          <label htmlFor={kindId} style={{ fontSize: 12, color: "var(--text-3)" }}>
            This item
          </label>
          <ThemedSelect
            id={kindId}
            className="pm-input sm"
            style={{ width: "auto" }}
            value={choice}
            onChange={(e) => setChoice(e.target.value as LinkChoice)}
          >
            <option value="blocks">blocks</option>
            <option value="blocked_by">is blocked by</option>
            <option value="relates">relates to</option>
            <option value="duplicates">duplicates</option>
          </ThemedSelect>
          <ItemSearchPicker
            label="Search for an item to link"
            filter={(r) => r.id !== item.id && !linked(r)}
            onCancel={() => {
              setAdding(false);
              setError(null);
            }}
            onPick={(other) => void add(other)}
          />
          {error && (
            <div className="pm-field-error" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
      {!adding && error && (
        <div className="pm-field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
