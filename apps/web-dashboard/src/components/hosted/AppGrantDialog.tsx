"use client";
import { useRef, useState, type RefObject } from "react";
import useSWR from "swr";
import { Dialog } from "@/components/Dialog";
import { fetchHostedAppGrants, hostedErrorCopy, updateHostedAppGrants } from "./api";
import { useOwnerConfirmation } from "./useOwnerConfirmation";

export function AppGrantDialog({ slug, onClose, onSaved, triggerRef }: {
  slug: string; onClose: () => void; onSaved: () => Promise<void>; triggerRef: RefObject<HTMLElement | null>;
}) {
  const initialFocus = useRef<HTMLInputElement>(null);
  const grants = useSWR(`/api/extensions/${slug}/grants`, () => fetchHostedAppGrants(slug));
  const [members, setMembers] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = useOwnerConfirmation({ actionLabel: "Save access", onError: setError, triggerRef });
  const allowMembers = members ?? grants.data?.roles.includes("family") ?? false;
  const save = async (currentPassword?: string) => {
    setBusy(true); setError(null);
    try { await updateHostedAppGrants(slug, allowMembers ? ["family"] : [], currentPassword); await onSaved(); onClose(); }
    catch (err) { if (!owner.requestConfirmation(err, save)) setError(hostedErrorCopy(err)); }
    finally { setBusy(false); }
  };
  return <>
    <Dialog open={!owner.confirmingIdentity} onClose={() => { if (!busy) onClose(); }} triggerRef={triggerRef}
      initialFocusRef={initialFocus} labelledBy="app-grants-heading">
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (!busy && grants.data) void save(); }}>
        <h2 id="app-grants-heading" className="type-headline">Who can open {slug}</h2>
        <p className="sub">The owner and admins always have access. Guests cannot open apps.</p>
        {grants.isLoading && <p role="status" className="sub">Loading access…</p>}
        {grants.error && <p role="alert" className="sub">Couldn&apos;t read access. {hostedErrorCopy(grants.error)}</p>}
        {grants.data && <label><input ref={initialFocus} type="checkbox" checked={allowMembers} disabled={busy} onChange={(event) => setMembers(event.target.checked)} /> Allow members to open this app</label>}
        {error && <p role="alert" className="sub" style={{ color: "var(--danger-ink)" }}>{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !grants.data || !!grants.error}>{busy ? "Saving…" : "Save access"}</button></div>
      </form>
    </Dialog>
    {owner.confirmation}
  </>;
}
