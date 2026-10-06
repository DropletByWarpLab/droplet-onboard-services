"use client";
import { ThemedDateInput } from "@/components/ui/ThemedDateInput";


import { useId, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { useDepartments } from "@/components/projects/usePm";
import { translateError } from "@/lib/friendly-errors";
import { ErrorStrip, Field } from "./form-bits";
import { PRIORITY_CHOICES } from "./support-config";
import type { Desk, SupportPerson } from "./types";
import { slaActions, useBusinessCalendars, useDeskSla, type BusinessCalendar, type DeskSla, type EscalationAction, type SlaMetric, type SlaPolicy, type SlaReport } from "./useSla";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

const METRICS: Array<[SlaMetric, string]> = [["firstResponse", "First response"], ["nextResponse", "Next response"], ["resolution", "Resolution"]];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DEFAULT_POLICY: SlaPolicy = { enabled: false, calendarId: null, targets: {}, atRiskPercent: 80, escalation: [] };

export function SlaSettingsModal({ desk, agents, onClose }: { desk: Desk; agents: SupportPerson[]; onClose: () => void }): JSX.Element {
  const id = useId();
  const settings = useDeskSla(desk.id);
  const calendars = useBusinessCalendars();
  return <Dialog open onClose={onClose} placement="center" maxWidth="lg" labelledBy={id}>
    <div className="pm-scope">
      <h2 id={id}>Service levels · {desk.name}</h2>
      {settings.error || calendars.error ? <><ErrorStrip message="Couldn't load service level settings." /><button className="pm-btn" type="button" onClick={() => { void settings.mutate(); void calendars.mutate(); }}>Try again</button></> : !settings.data || !calendars.data ? <p role="status">Loading settings…</p> : <SlaSettingsForm desk={desk} agents={agents} initial={settings.data} calendars={calendars.data.calendars} onCalendarChanged={() => void calendars.mutate()} onSaved={(value) => void settings.mutate({ ...value, canManage: settings.data?.canManage })} />}
      <button className="pm-btn" type="button" onClick={onClose} style={{ marginTop: 16 }}>Close</button>
    </div>
  </Dialog>;
}

function SlaSettingsForm({ desk, agents, initial, calendars, onCalendarChanged, onSaved }: {
  desk: Desk; agents: SupportPerson[]; initial: DeskSla; calendars: BusinessCalendar[];
  onCalendarChanged: () => void; onSaved: (value: DeskSla) => void;
}): JSX.Element {
  const [policy, setPolicy] = useState<SlaPolicy>(initial.policy ?? DEFAULT_POLICY);
  const [assignment, setAssignment] = useState(initial.assignment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [calendar, setCalendar] = useState<BusinessCalendar | "new" | null>(null);
  const { departments } = useDepartments();
  const save = async () => {
    if (busy || !initial.canManage) return;
    setBusy(true); setError(null); setSaved(false);
    try { const value = await slaActions.saveDesk(desk.id, { policy, assignment }); onSaved(value); setSaved(true); }
    catch (e) { setError(translateError(e, "support")); }
    finally { setBusy(false); }
  };
  const changeTarget = (priority: (typeof PRIORITY_CHOICES)[number]["value"], metric: SlaMetric, input: string) => {
    setSaved(false);
    const targets = { ...policy.targets };
    const target = { ...targets[priority] };
    const key = `${metric}Mins` as const;
    if (input === "") delete target[key]; else target[key] = Number(input);
    if (Object.keys(target).length) targets[priority] = target; else delete targets[priority];
    setPolicy({ ...policy, targets });
  };
  const updateRule = (index: number, patch: Partial<SlaPolicy["escalation"][number]>) => setPolicy({ ...policy, escalation: policy.escalation.map((rule, i) => i === index ? { ...rule, ...patch } : rule) });
  return <>
    <ErrorStrip message={error} />
    {!initial.canManage && <p className="sp-hint">You can review service levels and reports. An owner or admin with Support management access can change them.</p>}
    <fieldset disabled={busy || !initial.canManage} style={{ border: 0, padding: 0, margin: 0 }}>
      <label><input type="checkbox" checked={policy.enabled} onChange={(e) => { setPolicy({ ...policy, enabled: e.target.checked }); setSaved(false); }} /> Enable service levels</label>
      <Field label="Business calendar" htmlFor="sla-calendar" hint="24/7 uses elapsed time. Calendars use their named time zone and exclude holidays.">
        <ThemedSelect id="sla-calendar" className="pm-input" value={policy.calendarId ?? ""} onChange={(e) => setPolicy({ ...policy, calendarId: e.target.value || null })}>
          <option value="">24/7</option>{calendars.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.timezone}</option>)}
        </ThemedSelect>
      </Field>
      <div className="pm-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="pm-btn" type="button" onClick={() => setCalendar("new")}>New business calendar</button>
        {policy.calendarId && calendars.some((c) => c.id === policy.calendarId) && <button className="pm-btn" type="button" onClick={() => setCalendar(calendars.find((c) => c.id === policy.calendarId)!)}>Edit calendar</button>}
      </div>
      <h3>Targets in business minutes</h3>
      <p className="sp-hint">Leave a target empty to omit that clock. Policy changes apply to new tickets or a priority change; active tickets keep their assigned business calendar.</p>
      {PRIORITY_CHOICES.map((p) => <fieldset key={p.value} style={{ border: "1px solid var(--border)", borderRadius: 8, marginBottom: 10 }}>
        <legend>{p.label}</legend><div className="sp-props">{METRICS.map(([metric, label]) => <Field key={metric} label={label} htmlFor={`sla-${p.value}-${metric}`}><input id={`sla-${p.value}-${metric}`} className="pm-input" type="number" min={1} max={525600} step={1} value={policy.targets[p.value]?.[`${metric}Mins`] ?? ""} onChange={(e) => changeTarget(p.value, metric, e.target.value)} /></Field>)}</div>
      </fieldset>)}
      <Field label="At risk after this percent of the target" htmlFor="sla-risk"><input id="sla-risk" className="pm-input" type="number" min={1} max={99} value={policy.atRiskPercent} onChange={(e) => setPolicy({ ...policy, atRiskPercent: Number(e.target.value) })} /></Field>
      <h3>Escalation rules</h3>
      {policy.escalation.map((rule, index) => <fieldset key={index} style={{ border: "1px solid var(--border)", borderRadius: 8, marginBottom: 10 }}>
        <legend>Rule {index + 1}</legend>
        <Field label="When" htmlFor={`sla-rule-${index}-on`}><ThemedSelect id={`sla-rule-${index}-on`} className="pm-input" value={rule.on} onChange={(e) => updateRule(index, { on: e.target.value as typeof rule.on })}><option value="AT_RISK">At risk</option><option value="BREACHED">Breached</option></ThemedSelect></Field>
        <Field label="Clock" htmlFor={`sla-rule-${index}-metric`}><ThemedSelect id={`sla-rule-${index}-metric`} className="pm-input" value={rule.metric} onChange={(e) => updateRule(index, { metric: e.target.value as typeof rule.metric })}><option value="any">Any clock</option>{METRICS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</ThemedSelect></Field>
        {rule.actions.map((action, a) => <div key={a} className="pm-field" style={{ marginBottom: 12 }}>
          <label htmlFor={`sla-rule-${index}-action-${a}`}>Action {a + 1}</label>
          <ThemedSelect id={`sla-rule-${index}-action-${a}`} className="pm-input" value={action.type} onChange={(e) => {
            const next: EscalationAction = e.target.value === "reassign" ? { type: "reassign", userId: agents[0]?.id ?? "" } : e.target.value === "notify" ? { type: "notify", userIds: [] } : { type: "raise_priority" };
            updateRule(index, { actions: rule.actions.map((current, j) => j === a ? next : current) });
          }}><option value="raise_priority">Raise priority</option><option value="reassign">Reassign</option><option value="notify">Notify people</option></ThemedSelect>
          {action.type === "reassign" && <ThemedSelect className="pm-input" aria-label={`Reassign rule ${index + 1} action ${a + 1}`} value={action.userId} onChange={(e) => updateRule(index, { actions: rule.actions.map((current, j) => j === a ? { type: "reassign", userId: e.target.value } : current) })}><option value="">Choose a person</option>{agents.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</ThemedSelect>}
          {action.type === "notify" && <div aria-label={`Notify rule ${index + 1} action ${a + 1}`}>{agents.map((person) => <label key={person.id} style={{ display: "block" }}><input type="checkbox" checked={action.userIds.includes(person.id)} onChange={(e) => updateRule(index, { actions: rule.actions.map((current, j) => j === a ? { type: "notify", userIds: e.target.checked ? [...action.userIds, person.id] : action.userIds.filter((id) => id !== person.id) } : current) })} /> {person.displayName}</label>)}</div>}
          {rule.actions.length > 1 && <button className="pm-btn sm" type="button" onClick={() => updateRule(index, { actions: rule.actions.filter((_, j) => j !== a) })}>Remove action</button>}
        </div>)}
        <div className="pm-row" style={{ gap: 8 }}><button className="pm-btn sm" type="button" disabled={rule.actions.length >= 10} onClick={() => updateRule(index, { actions: [...rule.actions, { type: "raise_priority" }] })}>Add action</button><button className="pm-btn sm" type="button" onClick={() => setPolicy({ ...policy, escalation: policy.escalation.filter((_, i) => i !== index) })}>Remove rule</button></div>
      </fieldset>)}
      <button className="pm-btn" type="button" disabled={policy.escalation.length >= 20} onClick={() => setPolicy({ ...policy, escalation: [...policy.escalation, { on: "BREACHED", metric: "any", actions: [{ type: "raise_priority" }] }] })}>Add escalation rule</button>
      <h3>New ticket assignment</h3>
      <Field label="Assignment" htmlFor="sla-assignment"><ThemedSelect id="sla-assignment" className="pm-input" value={assignment.mode} onChange={(e) => setAssignment({ ...assignment, mode: e.target.value as typeof assignment.mode })}><option value="MANUAL">Manual</option><option value="ROUND_ROBIN">Round robin</option><option value="LEAST_OPEN">Fewest open tickets</option></ThemedSelect></Field>
      <Field label="Department" htmlFor="sla-department"><ThemedSelect id="sla-department" className="pm-input" value={assignment.departmentId ?? ""} onChange={(e) => setAssignment({ ...assignment, departmentId: e.target.value || null })}><option value="">Keep desk department</option>{(departments ?? []).filter((d) => d.kind !== "HOUSEHOLD").map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</ThemedSelect></Field>
      {assignment.mode !== "MANUAL" && <Field label="Assignment pool" hint="Only currently eligible Support agents receive new tickets.">{agents.map((person) => <label key={person.id} style={{ display: "block" }}><input type="checkbox" checked={assignment.memberIds.includes(person.id)} onChange={(e) => setAssignment({ ...assignment, memberIds: e.target.checked ? [...assignment.memberIds, person.id] : assignment.memberIds.filter((id) => id !== person.id) })} /> {person.displayName}</label>)}</Field>}
      <button className="pm-btn primary" type="button" disabled={assignment.mode !== "MANUAL" && assignment.memberIds.length === 0} onClick={() => void save()}>{busy ? "Saving…" : "Save service levels"}</button>
      {saved && <p role="status">Service levels saved.</p>}
    </fieldset>
    <SlaReportPanel deskId={desk.id} />
    {calendar && <CalendarEditor key={calendar === "new" ? "new" : calendar.id} initial={calendar === "new" ? null : calendar} onClose={() => setCalendar(null)} onSaved={() => { onCalendarChanged(); setCalendar(null); }} />}
  </>;
}

function CalendarEditor({ initial, onClose, onSaved }: { initial: BusinessCalendar | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const id = useId();
  const [value, setValue] = useState<Omit<BusinessCalendar, "id">>(initial ?? { name: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), holidays: [] });
  const [holidays, setHolidays] = useState(value.holidays.join("\n"));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (remove = false) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (remove && initial) await slaActions.deleteCalendar(initial.id);
      else await slaActions.saveCalendar(initial?.id ?? null, { ...value, holidays: holidays.split(/\s+/).filter(Boolean) });
      onSaved();
    } catch (e) { setError(translateError(e, "support")); }
    finally { setBusy(false); }
  };
  return <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={id}><div className="pm-scope"><h2 id={id}>{initial ? "Edit business calendar" : "New business calendar"}</h2><ErrorStrip message={error} /><fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0 }}>
    <Field label="Name" htmlFor="calendar-name"><input id="calendar-name" className="pm-input" value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value })} /></Field>
    <Field label="Time zone" htmlFor="calendar-zone" hint="Use an IANA name such as America/Los_Angeles."><input id="calendar-zone" className="pm-input" value={value.timezone} onChange={(e) => setValue({ ...value, timezone: e.target.value })} /></Field>
    <h3>Weekly hours</h3><p className="sp-hint">End 24:00 means midnight. An end earlier than the start continues into the next day. Holidays exclude windows that start on that date.</p>
    {value.windows.map((window, index) => <div key={index} className="pm-row" style={{ gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
      <ThemedSelect className="pm-input" aria-label={`Day ${index + 1}`} value={window.day} onChange={(e) => setValue({ ...value, windows: value.windows.map((w, i) => i === index ? { ...w, day: Number(e.target.value) } : w) })} style={{ width: "auto" }}>{DAYS.map((day, i) => <option key={day} value={i}>{day}</option>)}</ThemedSelect>
      {(["start", "end"] as const).map((key) => <input key={key} className="pm-input" aria-label={`${key === "start" ? "Start" : "End"} ${index + 1}`} value={window[key]} placeholder="HH:MM" maxLength={5} onChange={(e) => setValue({ ...value, windows: value.windows.map((w, i) => i === index ? { ...w, [key]: e.target.value } : w) })} style={{ width: 85 }} />)}
      <button className="pm-btn sm" type="button" aria-label={`Remove hours ${index + 1}`} onClick={() => setValue({ ...value, windows: value.windows.filter((_, i) => i !== index) })}>Remove</button>
    </div>)}
    <button className="pm-btn" type="button" disabled={value.windows.length >= 100} onClick={() => setValue({ ...value, windows: [...value.windows, { day: 1, start: "09:00", end: "17:00" }] })}>Add hours</button>
    <Field label="Holidays" htmlFor="calendar-holidays" hint="One local date per line, YYYY-MM-DD."><textarea id="calendar-holidays" className="pm-input" rows={4} value={holidays} onChange={(e) => setHolidays(e.target.value)} /></Field>
    <div className="pm-row" style={{ gap: 8, flexWrap: "wrap" }}><button className="pm-btn" type="button" onClick={onClose}>Cancel</button><button className="pm-btn primary" type="button" disabled={!value.name.trim()} onClick={() => void submit()}>Save calendar</button>{initial && <button className="pm-btn" type="button" onClick={() => confirmDelete ? void submit(true) : setConfirmDelete(true)}>{confirmDelete ? "Confirm delete calendar" : "Delete calendar"}</button>}</div>
    {confirmDelete && <p className="sp-hint">A calendar used by a policy cannot be deleted. Select another calendar and save the policy first.</p>}
  </fieldset></div></Dialog>;
}

function SlaReportPanel({ deskId }: { deskId: string }): JSX.Element {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<SlaReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => { if (busy) return; setBusy(true); setError(null); setReport(null); try { setReport(await slaActions.report(deskId, from, to)); } catch (e) { setError(translateError(e, "support")); } finally { setBusy(false); } };
  return <section aria-label="SLA attainment" style={{ marginTop: 24 }}><h3>SLA attainment</h3><p className="sp-hint">Completed tickets created in the date range, at most 366 days. Active tickets appear in the status counts.</p><div className="pm-row" style={{ gap: 8, flexWrap: "wrap" }}><label>From <ThemedDateInput className="pm-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>To <ThemedDateInput className="pm-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label><button className="pm-btn" type="button" disabled={busy || !from || !to || from > to} onClick={() => void load()}>{busy ? "Loading…" : "Show attainment"}</button></div><ErrorStrip message={error} />{report && <div role="status"><p>{report.total} tickets · {report.met} met · {report.breached} breached · {report.attainmentPercent === null ? "No measured tickets" : `${report.attainmentPercent}% attainment`}</p><ul>{Object.entries(report.statusCounts).map(([status, count]) => <li key={status}>{status.replaceAll("_", " ").toLowerCase()}: {count}</li>)}</ul></div>}</section>;
}
