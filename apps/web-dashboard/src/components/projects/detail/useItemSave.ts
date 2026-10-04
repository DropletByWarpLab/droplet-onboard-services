"use client";

// WARP-3520 -- the optimistic-update layer every drawer editor shares (design
// brief §4.2, §4.4).
//
// `view` is the item with every in-flight or just-saved edit laid over it, so a
// control reflects the new value the instant it is chosen. `save` applies that
// overlay, runs the write, and on failure puts the overlay back exactly as it
// was, raises an error toast and records an inline message for the control. The
// overlay is dropped whenever the parent hands over a fresher item (the server's
// copy wins) — except for fields whose write is still in flight, so a refresh
// that lands mid-write cannot flip a control back for a moment.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { fieldError } from "../useEditing";
import type { PmWorkItem } from "../types";

export interface ItemSave {
  /** The item with every in-flight / just-saved edit applied. */
  view: PmWorkItem;
  /**
   * Optimistically apply `optimistic`, run `write`, roll back on failure.
   * `key` names the control (one write per control at a time: a second `save`
   * for a key still in flight is ignored); `label` is the human name used in
   * announcements. Resolves true on success, false on failure or when ignored.
   */
  save: (
    key: string,
    label: string,
    optimistic: Partial<PmWorkItem>,
    write: () => Promise<unknown>,
  ) => Promise<boolean>;
  isBusy: (key: string) => boolean;
  /** The inline message for a control whose last write failed. */
  errorFor: (key: string) => string | null;
  /** Text for the visually hidden `role="status"` live region. */
  announcement: string;
}

type Overlay = Partial<PmWorkItem>;

export function useItemSave(item: PmWorkItem, onChanged: () => void): ItemSave {
  const { toast } = useToast();
  const [overlay, setOverlay] = useState<Overlay>({});
  const overlayRef = useRef<Overlay>({});
  overlayRef.current = overlay;
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  // control key -> the item fields its in-flight write owns
  const inflight = useRef(new Map<string, string[]>());
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    setOverlay((prev) => {
      const owned = new Set([...inflight.current.values()].flat());
      const next: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(prev)) if (owned.has(field)) next[field] = value;
      return next as Overlay;
    });
  }, [item]);

  const view = useMemo(() => ({ ...item, ...overlay }), [item, overlay]);

  const save: ItemSave["save"] = useCallback(
    async (key, label, optimistic, write) => {
      if (inflight.current.has(key)) return false;
      const fields = Object.keys(optimistic);
      // What the overlay held for these fields BEFORE this edit, so a rollback
      // restores it (not the bare server copy, which may predate a saved edit).
      const before = overlayRef.current as Record<string, unknown>;
      const snapshot = fields.map((f) => [f, f in before, before[f]] as const);

      inflight.current.set(key, fields);
      setBusy((b) => ({ ...b, [key]: true }));
      setOverlay((o) => ({ ...o, ...optimistic }));
      try {
        await write();
        setErrors(({ [key]: _gone, ...rest }) => rest);
        setAnnouncement(`${label} updated`);
        onChangedRef.current();
        return true;
      } catch (e) {
        setOverlay((o) => {
          const next = { ...o } as Record<string, unknown>;
          for (const [field, had, value] of snapshot) {
            if (had) next[field] = value;
            else delete next[field];
          }
          return next as Overlay;
        });
        const message = fieldError(e, "value") ?? translateError(e, "projects");
        setErrors((prev) => ({ ...prev, [key]: message }));
        setAnnouncement(`Couldn't update ${label.toLowerCase()}. ${message}`);
        toast(message, "error");
        return false;
      } finally {
        inflight.current.delete(key);
        setBusy(({ [key]: _done, ...rest }) => rest);
      }
    },
    [toast],
  );

  return {
    view,
    save,
    isBusy: (key) => busy[key] === true,
    errorFor: (key) => errors[key] ?? null,
    announcement,
  };
}
