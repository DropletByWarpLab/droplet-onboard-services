"use client";
import { useEffect, useRef, useState } from "react";
import { WandSparkles } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useCreationCapabilities, type CreationCapability, type CreationState } from "@/lib/hooks/useCreationCapabilities";

const STATE_LABEL: Record<CreationState, string> = {
  ready: "Available", disabled: "Off", restricted: "Access restricted", not_configured: "Setup needed",
  offline: "Offline", busy: "Busy", unverified: "Configured, unverified", unavailable: "Unavailable",
};

function setupLink(row: CreationCapability): { href: string; label: string } | null {
  if (row.reason === "web_policy_disabled") return { href: "/network?tab=privacy", label: "Privacy settings" };
  if (row.reason === "files_module_disabled") return { href: "/settings", label: "Feature settings" };
  return null;
}

export function CreationCapabilitiesList({ enabled }: { enabled: boolean }) {
  const { user } = useAuth();
  const admin = user?.role === "owner" || user?.role === "admin";
  const { data, loading, error, refresh } = useCreationCapabilities(enabled);
  return <div>
    <div className="flex items-center justify-between gap-3 mb-3">
      <p className="type-caption-1 text-[var(--text-muted)]">Local creation services and your access on this Droplet.</p>
      <button type="button" disabled={loading} onClick={() => void refresh()} className="type-caption-1 text-[var(--brand)] disabled:opacity-50">{loading ? "Checking…" : "Refresh"}</button>
    </div>
    {loading && <p role="status" className="type-caption-1 text-[var(--text-muted)]">Checking local services…</p>}
    {error && <p role="status" className="type-caption-1 text-[var(--text-muted)]">Creation status is unavailable. Refresh to try again.</p>}
    {data && <>
      <ul className="space-y-3" aria-label="Creation capabilities">
        {data.capabilities.map((row) => {
          const link = admin ? setupLink(row) : null;
          return <li key={row.id} className="border-b border-[var(--card-bd)] pb-3 last:border-0 last:pb-0">
            <div className="flex justify-between items-start gap-3">
              <span className="type-body-2 font-medium text-[var(--text)]">{row.label}</span>
              <span className={`type-caption-2 whitespace-nowrap ${row.state === "ready" ? "text-[var(--brand)]" : "text-[var(--text-muted)]"}`}>{STATE_LABEL[row.state]}</span>
            </div>
            <p className="type-caption-1 text-[var(--text-muted)] mt-1">{row.detail}</p>
            {link && <Link href={link.href} className="type-caption-1 text-[var(--brand)]">{link.label}</Link>}
          </li>;
        })}
      </ul>
      <p className="type-caption-2 text-[var(--text-muted)] mt-3">Checked {new Date(data.checkedAt).toLocaleTimeString()}. Availability can change while a task is running.</p>
    </>}
  </div>;
}

/** The chat entry point makes setup failures discoverable before starting a task. */
export function CreationCapabilitiesPopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const click = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("mousedown", click); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", key); };
  }, [open]);
  return <div ref={root} className="lg:relative">
    <button ref={trigger} type="button" className={`chat-iconbtn ${open ? "is-on" : ""}`} onClick={() => setOpen((value) => !value)} aria-haspopup="dialog" aria-expanded={open} aria-label="Creation capabilities" title="Creation capabilities">
      <WandSparkles size={16} aria-hidden="true" />
    </button>
    {open && <div role="dialog" aria-label="Creation capabilities" className="absolute right-0 max-lg:right-3 mt-1 w-[440px] max-w-[92vw] max-h-[75vh] overflow-auto z-30 rounded-2xl bg-[var(--card-bg)] border border-[var(--card-bd)] shadow-xl p-4">
      <div className="flex items-center justify-between mb-3"><h2 className="type-body-1 font-medium">Creation capabilities</h2><button ref={closeButton} type="button" onClick={() => { setOpen(false); trigger.current?.focus(); }} className="type-caption-1 text-[var(--text-muted)]">Close</button></div>
      <CreationCapabilitiesList enabled />
    </div>}
  </div>;
}
