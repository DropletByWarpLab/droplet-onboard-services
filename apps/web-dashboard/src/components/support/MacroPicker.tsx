"use client";

import { useId, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { translateError } from "@/lib/friendly-errors";
import { ErrorStrip } from "./form-bits";
import { MacroManager } from "./MacroManager";
import { macroDraftText, slaActions, useMacros, type MacroPreview } from "./useSla";
import type { Desk, SupportPerson, Ticket } from "./types";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

export function MacroPicker({ ticket, desk, agents, onApplied }: { ticket: Ticket; desk: Desk; agents: SupportPerson[]; onApplied: (draft: string) => void }): JSX.Element {
  const id = useId();
  const list = useMacros(desk.id);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<MacroPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const show = async () => { if (busy || !selected) return; setBusy(true); setError(null); try { setPreview(await slaActions.previewMacro(ticket.id, selected)); } catch (e) { setError(translateError(e, "support")); } finally { setBusy(false); } };
  const apply = async () => { if (busy || !selected || !preview) return; setBusy(true); setError(null); try { const result = await slaActions.applyMacro(ticket.id, selected); setPreview(null); onApplied(macroDraftText(result.bodyHtml)); } catch (e) { setError(translateError(e, "support")); } finally { setBusy(false); } };
  return <section className="pm-surface sp-card" aria-label="Reply macros"><h3>Reply macros</h3><ErrorStrip message={preview ? null : error} />
    {list.error ? <><p className="sp-hint">Couldn't load macros.</p><button className="pm-btn sm" type="button" onClick={() => void list.mutate()}>Try again</button></> : <ThemedSelect className="pm-input" aria-label="Reply macro" value={selected} disabled={busy || !list.data} onChange={(e) => { setSelected(e.target.value); setPreview(null); setError(null); }}><option value="">Choose a macro</option>{list.data?.macros.map((macro) => <option key={macro.id} value={macro.id}>{macro.name}</option>)}</ThemedSelect>}
    <div className="pm-row" style={{ gap: 8, marginTop: 8 }}><button className="pm-btn" type="button" disabled={busy || !selected} onClick={() => void show()}>Preview macro</button><button className="pm-btn" type="button" onClick={() => setManaging(true)}>Manage macros</button></div>
    {preview && <Dialog open onClose={() => { if (!busy) setPreview(null); }} placement="center" maxWidth="md" labelledBy={id}><div className="pm-scope"><h2 id={id}>{preview.name}</h2><ErrorStrip message={error} /><p className="sp-hint">These field changes apply together. The reply is prepared as a draft for you to review and send.</p>{preview.changes.length ? <ul>{preview.changes.map((change, i) => <li key={i}>{change}</li>)}</ul> : <p>No ticket fields change.</p>}<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit" }}>{macroDraftText(preview.bodyHtml)}</pre><div className="pm-row" style={{ gap: 8 }}><button className="pm-btn" type="button" disabled={busy} onClick={() => setPreview(null)}>Cancel</button><button className="pm-btn primary" type="button" disabled={busy} onClick={() => void apply()}>{busy ? "Applying…" : "Apply fields and prepare reply"}</button></div></div></Dialog>}
    {managing && <MacroManager desk={desk} agents={agents} onClose={() => { setManaging(false); void list.mutate(); }} />}
  </section>;
}
