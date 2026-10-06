"use client";

import { useId, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { useAuth } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";
import { ErrorStrip, Field } from "./form-bits";
import { PRIORITY_CHOICES, textToHtml } from "./support-config";
import { canManageDesks, type Desk, type SupportPerson, type TicketPriority } from "./types";
import { macroDraftText, slaActions, useMacros, type Macro } from "./useSla";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

export function MacroManager({ desk, agents, onClose }: { desk: Desk; agents: SupportPerson[]; onClose: () => void }): JSX.Element {
  const id = useId();
  const { user } = useAuth();
  const list = useMacros(desk.id);
  const manage = canManageDesks(user?.role) && list.data?.canManageShared === true;
  const [editing, setEditing] = useState<Macro | "new" | null>(null);
  const editable = (macro: Macro) => macro.visibility === "SHARED" ? manage : macro.ownerId === user?.id;
  return <Dialog open onClose={onClose} placement="center" maxWidth="lg" labelledBy={id}><div className="pm-scope">
    <h2 id={id}>Reply macros · {desk.name}</h2>
    <p className="sp-hint">Macros prepare a reply and change ticket fields after a preview. You send the reply separately.</p>
    {list.error ? <><ErrorStrip message="Couldn't load macros." /><button className="pm-btn" type="button" onClick={() => void list.mutate()}>Try again</button></> : !list.data ? <p role="status">Loading macros…</p> : <ul style={{ listStyle: "none", padding: 0 }}>{list.data.macros.map((macro) => <li key={macro.id} className="pm-row" style={{ gap: 8, marginBottom: 8 }}><span>{macro.name} · {macro.visibility === "PERSONAL" ? "Personal" : "Shared"} · {macro.projectId ? "This desk" : "All desks"}</span>{editable(macro) && <button className="pm-btn sm" type="button" onClick={() => setEditing(macro)}>Edit {macro.name}</button>}</li>)}</ul>}
    <div className="pm-row" style={{ gap: 8 }}><button className="pm-btn primary" type="button" onClick={() => setEditing("new")}>New macro</button><button className="pm-btn" type="button" onClick={onClose}>Close</button></div>
    {editing && <MacroEditor key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} desk={desk} agents={agents} manage={manage} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.mutate(); }} />}
  </div></Dialog>;
}

function MacroEditor({ initial, desk, agents, manage, onClose, onSaved }: { initial: Macro | null; desk: Desk; agents: SupportPerson[]; manage: boolean; onClose: () => void; onSaved: () => void }): JSX.Element {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const initialText = initial ? macroDraftText(initial.bodyHtml) : "";
  const [text, setText] = useState(initialText);
  const [global, setGlobal] = useState(initial ? initial.projectId === null : false);
  const [visibility, setVisibility] = useState<Macro["visibility"]>(initial?.visibility ?? "PERSONAL");
  const [actions, setActions] = useState<Macro["actions"]>(initial?.actions ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = async (remove = false) => {
    if (busy) return; setBusy(true); setError(null);
    try {
      if (remove && initial) await slaActions.deleteMacro(initial.id);
      else {
        const next = { ...actions };
        if (global) { delete next.stateId; delete next.addLabelIds; delete next.removeLabelIds; }
        await slaActions.saveMacro(initial?.id ?? null, { name: name.trim(), projectId: global ? null : desk.id, visibility, actions: next, bodyHtml: initial && text === initialText ? initial.bodyHtml : textToHtml(text) });
      }
      onSaved();
    } catch (e) { setError(translateError(e, "support")); }
    finally { setBusy(false); }
  };
  return <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={id}><div className="pm-scope"><h2 id={id}>{initial ? "Edit macro" : "New macro"}</h2><ErrorStrip message={error} /><fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0 }}>
    <Field label="Name" htmlFor="macro-name"><input id="macro-name" className="pm-input" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></Field>
    <Field label="Reply" htmlFor="macro-body" hint="Variables: {{requester.firstName}}, {{ticket.key}}, {{agent.name}}, {{desk.name}}."><textarea id="macro-body" className="pm-input" rows={6} maxLength={50000} value={text} onChange={(e) => setText(e.target.value)} /></Field>
    <Field label="Visibility" htmlFor="macro-visibility"><ThemedSelect id="macro-visibility" className="pm-input" value={visibility} disabled={!manage} onChange={(e) => setVisibility(e.target.value as Macro["visibility"])}><option value="PERSONAL">Only me</option><option value="SHARED">Shared with Support</option></ThemedSelect></Field>
    <label><input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> Available in all desks</label>
    <h3>Ticket changes</h3>
    {!global && <Field label="Status" htmlFor="macro-status"><ThemedSelect id="macro-status" className="pm-input" value={actions.stateId ?? ""} onChange={(e) => { const next = { ...actions }; if (e.target.value) next.stateId = e.target.value; else delete next.stateId; setActions(next); }}><option value="">Keep status</option>{desk.states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</ThemedSelect></Field>}
    <Field label="Priority" htmlFor="macro-priority"><ThemedSelect id="macro-priority" className="pm-input" value={actions.priority ?? ""} onChange={(e) => { const next = { ...actions }; if (e.target.value) next.priority = e.target.value as TicketPriority; else delete next.priority; setActions(next); }}><option value="">Keep priority</option>{PRIORITY_CHOICES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</ThemedSelect></Field>
    <Field label="Assignee" htmlFor="macro-assignee"><ThemedSelect id="macro-assignee" className="pm-input" value={typeof actions.assignee === "object" ? `user:${actions.assignee.userId}` : actions.assignee ?? ""} onChange={(e) => { const next = { ...actions }; const value = e.target.value; if (!value) delete next.assignee; else next.assignee = value.startsWith("user:") ? { userId: value.slice(5) } : value as "me" | "none"; setActions(next); }}><option value="">Keep assignee</option><option value="me">Assign to me</option><option value="none">Unassign</option>{agents.map((person) => <option key={person.id} value={`user:${person.id}`}>{person.displayName}</option>)}</ThemedSelect></Field>
    {!global && desk.labels.length > 0 && <Field label="Labels">{desk.labels.map((label) => <div key={label.id} className="pm-row" style={{ gap: 12 }}><span>{label.name}</span>{(["addLabelIds", "removeLabelIds"] as const).map((key) => <label key={key}><input type="checkbox" checked={actions[key]?.includes(label.id) ?? false} onChange={(e) => { const opposite = key === "addLabelIds" ? "removeLabelIds" : "addLabelIds"; setActions({ ...actions, [key]: e.target.checked ? [...(actions[key] ?? []), label.id] : (actions[key] ?? []).filter((id) => id !== label.id), [opposite]: (actions[opposite] ?? []).filter((id) => id !== label.id) }); }} /> {key === "addLabelIds" ? "Add" : "Remove"}</label>)}</div>)}</Field>}
    <div className="pm-row" style={{ gap: 8, flexWrap: "wrap" }}><button className="pm-btn" type="button" onClick={onClose}>Cancel</button><button className="pm-btn primary" type="button" disabled={!name.trim() || !text.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save macro"}</button>{initial && <button className="pm-btn" type="button" onClick={() => confirmDelete ? void save(true) : setConfirmDelete(true)}>{confirmDelete ? "Confirm delete macro" : "Delete macro"}</button>}</div>
  </fieldset></div></Dialog>;
}
