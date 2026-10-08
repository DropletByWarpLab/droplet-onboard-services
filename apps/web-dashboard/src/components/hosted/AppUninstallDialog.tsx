"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Dialog } from "@/components/Dialog";
import { uninstallExtension } from "@/lib/api";
import { explainExtensionError } from "@/components/admin/extensions/copy";
import { useOwnerConfirmation } from "./useOwnerConfirmation";
import { useHostedActionScope } from "./useHostedActionScope";

export function AppUninstallDialog({ slug, onClose, onDone, triggerRef, dataOnly = false }: {
  slug: string; onClose: () => void; onDone: () => Promise<void>; triggerRef: RefObject<HTMLElement | null>; dataOnly?: boolean;
}) {
  const scope = useHostedActionScope(`uninstall:${slug}:${dataOnly}`, ["owner"]);
  const openedBy = useRef(scope.key);
  const retired = useRef(false);
  if (openedBy.current !== scope.key) retired.current = true;
  const visible = scope.key !== null && !retired.current;
  useEffect(() => { if (!visible) onClose(); }, [visible, onClose]);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [deleteData, setDeleteData] = useState(dataOnly);
  const [confirmSlug, setConfirmSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = useOwnerConfirmation({ actionLabel: dataOnly ? "Delete saved data" : "Uninstall app", destructive: true, onError: setError, triggerRef });
  const uninstall = async (currentPassword?: string) => {
    const isCurrent = scope.capture();
    if (!visible || !isCurrent()) return;
    if (deleteData && confirmSlug !== slug) return;
    setBusy(true); setError(null);
    try {
      await uninstallExtension(slug, deleteData ? { deleteData: true, confirmSlug } : undefined, currentPassword);
      if (!isCurrent()) return;
      await onDone(); if (isCurrent()) onClose();
    } catch (err) { if (isCurrent() && !owner.requestConfirmation(err, uninstall)) setError(explainExtensionError(err)); }
    finally { if (isCurrent()) setBusy(false); }
  };
  if (!visible) return null;
  return <>
    <Dialog open={!owner.confirmingIdentity} onClose={() => { if (!busy) onClose(); }} triggerRef={triggerRef} initialFocusRef={cancelRef} labelledBy="app-uninstall-heading">
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (!busy) void uninstall(); }}>
        <h2 id="app-uninstall-heading" className="type-headline">{dataOnly ? `Delete saved data for ${slug}?` : `Uninstall ${slug}?`}</h2>
        <p className="sub">{dataOnly ? "This permanently removes the app's saved data from this Droplet." : "This stops the app and removes its running code and access. Its saved data stays on this Droplet unless you delete it below."}</p>
        {!dataOnly && <label><input type="checkbox" checked={deleteData} disabled={busy} onChange={(event) => { setDeleteData(event.target.checked); setConfirmSlug(""); }} /> Also permanently delete this app&apos;s saved data</label>}
        {deleteData && <label className="flex flex-col gap-1">Type {slug} to delete its data
          <input className="input w-full" value={confirmSlug} autoComplete="off" disabled={busy} onChange={(event) => setConfirmSlug(event.target.value)} /></label>}
        {error && <p role="alert" className="sub" style={{ color: "var(--danger-ink)" }}>{error}</p>}
        <div className="flex justify-end gap-2"><button ref={cancelRef} type="button" className="btn" disabled={busy} onClick={onClose}>{dataOnly ? "Keep data" : "Keep app"}</button>
          <button type="submit" className="btn danger" disabled={busy || (deleteData && confirmSlug !== slug)}>{busy ? "Removing…" : dataOnly ? "Delete saved data" : "Confirm uninstall"}</button></div>
      </form>
    </Dialog>
    {owner.confirmation}
  </>;
}
