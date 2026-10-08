"use client";
import { useEffect, useState, type RefObject } from "react";
import { fetchHostedApps } from "@/components/hosted/api";
import { createWorkspace, importWorkspaceArchive, TEMPLATE_INFO } from "./workspaces/api";

type Source = "template" | "archive" | "push";
export const APP_TEMPLATES = ["static-site", "node-app", "python-app"];
export const ARCHIVE_CAP_BYTES = 256 * 1024 * 1024;

export function NewAppForm({ templates, onCreated, onClose, initialFocusRef, onBusyChange }: {
  templates: string[] | null;
  onCreated: (workspace: { id: string; name: string; kind?: "app" }) => void;
  onClose: () => void;
  initialFocusRef: RefObject<HTMLInputElement | null>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<Source>("template");
  const [template, setTemplate] = useState("static-site");
  const [file, setFile] = useState<File | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = initialFocusRef;
  useEffect(() => {
    let active = true;
    nameRef.current?.focus();
    fetchHostedApps().then((state) => { if (active) setEnabled(state.supervisionEnabled); })
      .catch(() => { if (active) setStatusError(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (templates && !templates.includes(template)) setTemplate(APP_TEMPLATES.find((id) => templates.includes(id)) ?? "");
  }, [templates, template]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || enabled !== true) return;
    if (!name.trim()) { setError("Give the app a name first."); nameRef.current?.focus(); return; }
    if (source === "template" && !template) { setError("Choose an app template on this Droplet."); return; }
    if (source === "archive" && (!file || !/\.(zip|tar\.gz)$/i.test(file.name))) {
      setError("Choose a .zip or .tar.gz archive."); return;
    }
    if (source === "archive" && file && file.size > ARCHIVE_CAP_BYTES) {
      setError("That archive is too large. The limit is 256 MiB."); return;
    }
    setBusy(true); onBusyChange(true); setError(null);
    try {
      const workspace = source === "archive"
        ? await importWorkspaceArchive({ name: name.trim(), archive: file! })
        : await createWorkspace({ name: name.trim(), kind: "app", ...(source === "template" ? { template } : {}) });
      onCreated({ ...workspace, kind: "app" });
      onClose();
    } catch { setError("The Droplet could not create this app workspace. Try again in a moment."); }
    finally { setBusy(false); onBusyChange(false); }
  };
  return <form onSubmit={(e) => void submit(e)} noValidate aria-label="New app" className="flex flex-col gap-4">
    <div><h2 id="new-tool-heading" className="text-[16px] font-semibold m-0">New app</h2>
      <p id="new-tool-sub" className="ws-note">Bring a web app or UI into a workspace. The assistant can set it up; the owner reviews it before it runs.</p></div>
    {enabled === null && !statusError && <p className="ws-note" role="status">Checking whether apps are available…</p>}
    {statusError && <p className="ws-note" role="alert">Couldn&apos;t check apps on this Droplet. Close this dialog and try again.</p>}
    {enabled === false && <p className="ws-note" role="status">Apps are turned off on this Droplet. Ask the owner to enable them before creating an app.</p>}
    <label className="flex flex-col gap-1 text-[13px]">Name
      <input ref={nameRef} className="input rounded px-2 py-1.5" value={name} maxLength={80} disabled={busy}
        onChange={(e) => setName(e.target.value)} placeholder="e.g. Team dashboard" required /></label>
    <fieldset className="m-0 p-0 border-0 flex flex-col gap-2" disabled={busy}>
      <legend className="text-[13px] font-medium mb-1">Bring code in</legend>
      <div className="flex flex-wrap gap-4">{(["template", "archive", "push"] as Source[]).map((value) =>
        <label key={value}><input type="radio" name="app-source" checked={source === value} onChange={() => { setSource(value); setError(null); }} /> {value === "template" ? "Template" : value === "archive" ? "Archive" : "Git push"}</label>)}</div>
      {source === "template" && (templates === null ? <p className="ws-note">Loading templates…</p> : <div className="ws-pick-grid">
        {APP_TEMPLATES.filter((id) => templates.includes(id)).map((id) => <label key={id} className={`ws-pick${template === id ? " is-on" : ""}`}>
          <input type="radio" name="app-template" checked={template === id} onChange={() => setTemplate(id)} />
          <span className="ws-pick-body"><span className="ws-pick-t">{TEMPLATE_INFO[id].label}</span><span className="ws-pick-d">{TEMPLATE_INFO[id].blurb}</span></span>
        </label>)}
        {!APP_TEMPLATES.some((id) => templates.includes(id)) && <p className="ws-note">No app templates are available yet. Bring an archive or push your code instead.</p>}
      </div>)}
      {source === "archive" && <label className="flex flex-col gap-1 text-[13px]">Archive (.zip or .tar.gz, up to 256 MiB)
        <input type="file" accept=".zip,.tar.gz" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
      </label>}
      {source === "push" && <p className="ws-note">Create an empty workspace, then clone it and push your code. Its clone URL appears in the workspace pane.</p>}
    </fieldset>
    <p className="ws-note">Include any dependencies in your archive or repository. Apps run offline and cannot install packages from the internet.</p>
    <p className="ws-note">Droplet connects the app for you. Open it in your browser from Apps.</p>
    {error && <p role="alert" className="ws-field-error">{error}</p>}
    <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" className="btn primary" disabled={busy || enabled !== true || (source === "template" && templates === null)} aria-busy={busy}>{busy ? "Creating…" : "Create app workspace"}</button></div>
  </form>;
}
