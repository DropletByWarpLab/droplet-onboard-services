"use client";

// The five steps of the import wizard (WARP-3527). Each is a controlled
// component: ImportWizard owns the job and the analysis, these render them.
// Copy follows the design brief §6 — sentence case, no exclamation marks, no
// emoji, plain words before jargon.

import { useId, useRef, useState, type DragEvent, type JSX } from "react";
import { Upload } from "lucide-react";
import { PRIORITY, PRIORITY_ORDER } from "../config";
import { EmptyBlock, Skel } from "../bits";
import type { Priority, StateGroup } from "../types";
import type {
  DateOrder,
  FieldKey,
  ImportAnalysis,
  ImportJob,
  ImportMapping,
  ImportSource,
  PlannedPerson,
  PlannedPriority,
  PlannedStatus,
  PreviewRow,
  StateDecision,
} from "./types";

// ── step 1 — choose a file ──────────────────────────────────────────────────

export function UploadStep({
  busy,
  onFile,
}: {
  busy: boolean;
  onFile: (file: File) => void;
}): JSX.Element {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && !busy) onFile(file);
  };

  if (busy) {
    return (
      <div aria-busy="true" aria-live="polite">
        <p className="pm-imp-sub">Reading your file…</p>
        <Skel h={92} r={14} />
      </div>
    );
  }
  return (
    <div>
      <h3 className="pm-imp-h">Choose a file</h3>
      <p className="pm-imp-sub">
        A CSV from Jira, Asana, Linear, GitHub or any spreadsheet, or a Trello board saved as JSON.
      </p>
      <div className="pm-imp-drop-wrap">
        <label
          htmlFor={inputId}
          className={"pm-imp-drop" + (over ? " over" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <Upload size={22} aria-hidden style={{ color: "var(--accent)" }} />
          <strong>Choose a file or drop it here</strong>
          <span>Up to 10 MB and 20,000 rows. Nothing is imported until you check the preview and start it.</span>
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".csv,.tsv,.txt,.json,text/csv,application/json,text/plain"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onFile(file);
          }}
        />
      </div>
    </div>
  );
}

// ── step 2 — which tool is it from ──────────────────────────────────────────

export function SourceStep({
  analysis,
  busy,
  onPick,
}: {
  analysis: ImportAnalysis;
  busy: boolean;
  onPick: (source: ImportSource) => void;
}): JSX.Element {
  return (
    <div>
      <h3 className="pm-imp-h">Where is this file from?</h3>
      <p className="pm-imp-sub">
        The preset decides which column means what. You can change any of it on the next step.
      </p>
      <div className="pm-imp-presets" role="radiogroup" aria-label="Source">
        {analysis.sources.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={analysis.source === s.id}
            className="pm-imp-preset"
            disabled={busy || !s.compatible}
            title={s.compatible ? undefined : "This preset needs a different kind of file"}
            onClick={() => analysis.source !== s.id && onPick(s.id)}
          >
            <span className="pm-imp-radio" aria-hidden />
            <span>
              <div className="t">
                {s.label}
                {analysis.detected === s.id && (
                  <span className="pm-tag sm" style={{ marginLeft: 8, verticalAlign: "middle" }}>
                    Looks like this file
                  </span>
                )}
              </div>
              <div className="h">{s.hint}</div>
            </span>
          </button>
        ))}
      </div>
      {analysis.fileWarnings.length > 0 && (
        <ul className="pm-imp-notes" aria-label="About the file">
          {analysis.fileWarnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── step 3 — match columns and values ───────────────────────────────────────

const FIELD_ROWS: Array<{ key: FieldKey; label: string; hint?: string }> = [
  { key: "name", label: "Title" },
  { key: "description", label: "Description" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "assignee", label: "Assignee" },
  { key: "labels", label: "Labels", hint: "Columns that share a name are all used." },
  { key: "dueDate", label: "Due date" },
  { key: "startDate", label: "Start date" },
  { key: "createdAt", label: "Created" },
  { key: "parent", label: "Parent item" },
  { key: "externalId", label: "Id", hint: "Used to match rows when you import the same file again." },
];

/** The Assignee row writes `assignees` when the preset reads a LIST of people (GitHub, Trello). */
const boundKey = (m: ImportMapping, key: FieldKey): FieldKey =>
  key === "assignee" && (m.columns.assignees?.length ?? 0) > 0 ? "assignees" : key;

function withColumn(m: ImportMapping, key: FieldKey, header: string): ImportMapping {
  const k = boundKey(m, key);
  const columns = { ...m.columns, [k]: header === "" ? [] : [header] };
  // exactly one of assignee / assignees is ever bound
  if (key === "assignee" && header !== "") columns[k === "assignee" ? "assignees" : "assignee"] = [];
  return { ...m, columns };
}

const GROUPS: Array<[StateGroup, string]> = [
  ["backlog", "Backlog"],
  ["unstarted", "Not started"],
  ["started", "In progress"],
  ["completed", "Done"],
  ["cancelled", "Cancelled"],
];

const DATE_ORDERS: Array<[ImportMapping["dateOrder"], string]> = [
  ["auto", "Work it out from the file"],
  ["MDY", "Month first (03/04/2024 is 4 March)"],
  ["DMY", "Day first (03/04/2024 is 3 April)"],
  ["YMD", "Year first (2024/03/04)"],
];

const SEPARATORS: Array<[string, string]> = [
  [",", "Comma"],
  [";", "Semicolon"],
  ["|", "Vertical bar"],
  ["\n", "New line"],
];

function StatusRow({
  s,
  analysis,
  onChange,
}: {
  s: PlannedStatus;
  analysis: ImportAnalysis;
  onChange: (d: StateDecision) => void;
}): JSX.Element {
  const d = s.decision;
  const value = d.kind === "state" ? `state:${d.stateId}` : d.kind;
  return (
    <tr>
      <td>{s.value}</td>
      <td className="num">{s.count}</td>
      <td>
        <select
          className="pm-input"
          aria-label={`State for status ${s.value}`}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "default") onChange({ kind: "default" });
            else if (v === "create") onChange({ kind: "create", name: s.value.slice(0, 100), group: s.group });
            else onChange({ kind: "state", stateId: v.slice("state:".length) });
          }}
        >
          {analysis.states.map((st) => (
            <option key={st.id} value={`state:${st.id}`}>
              {st.name}
            </option>
          ))}
          <option value="create">Create “{s.value}” as a new state</option>
          <option value="default">Use the project default</option>
        </select>
        {d.kind === "create" && (
          <select
            className="pm-input"
            style={{ marginLeft: 8 }}
            aria-label={`Group for the new state ${d.name}`}
            value={d.group}
            onChange={(e) => onChange({ kind: "create", name: d.name, group: e.target.value as StateGroup })}
          >
            {GROUPS.map(([g, label]) => (
              <option key={g} value={g}>
                {label}
              </option>
            ))}
          </select>
        )}
      </td>
    </tr>
  );
}

function PersonRow({
  p,
  members,
  onChange,
}: {
  p: PlannedPerson;
  members: ImportAnalysis["members"];
  onChange: (v: string | null | undefined) => void;
}): JSX.Element {
  const value = p.by === "override" ? (p.userId ?? "__skip") : "__auto";
  return (
    <tr>
      <td>{p.value}</td>
      <td className="num">{p.count}</td>
      <td>
        <select
          className="pm-input"
          aria-label={`Member for ${p.value}`}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === "__auto" ? undefined : v === "__skip" ? null : v);
          }}
        >
          <option value="__auto">
            {p.userId ? `Match automatically (${p.displayName ?? "a member"})` : "Match automatically"}
          </option>
          <option value="__skip">Leave unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </td>
      <td className="muted">
        {p.userId && p.by !== "override" ? `Matched by ${p.by}` : p.by === "override" ? "Your choice" : (p.detail ?? "No member matches")}
      </td>
    </tr>
  );
}

function PriorityRow({
  p,
  onChange,
}: {
  p: PlannedPriority;
  onChange: (v: Priority) => void;
}): JSX.Element {
  return (
    <tr>
      <td>{p.value}</td>
      <td className="num">{p.count}</td>
      <td>
        <select
          className="pm-input"
          aria-label={`Priority for ${p.value}`}
          value={p.priority}
          onChange={(e) => onChange(e.target.value as Priority)}
        >
          {PRIORITY_ORDER.map((v) => (
            <option key={v} value={v}>
              {PRIORITY[v].label}
            </option>
          ))}
        </select>
      </td>
      <td className="muted">{p.known ? "" : "Not recognised"}</td>
    </tr>
  );
}

export function MappingStep({
  analysis,
  onChange,
}: {
  analysis: ImportAnalysis;
  onChange: (next: ImportMapping) => void;
}): JSX.Element {
  const m = analysis.mapping;
  const hasLists = (m.columns.labels?.length ?? 0) > 0 || (m.columns.assignees?.length ?? 0) > 0;
  const hasDates = (["dueDate", "startDate", "createdAt"] as FieldKey[]).some((k) => (m.columns[k]?.length ?? 0) > 0);
  const setStatus = (key: string, d: StateDecision) => onChange({ ...m, statuses: { ...m.statuses, [key]: d } });
  const setPriority = (key: string, v: Priority) => onChange({ ...m, priorities: { ...m.priorities, [key]: v } });
  const setPerson = (key: string, v: string | null | undefined) => {
    const people = { ...m.people };
    if (v === undefined) delete people[key];
    else people[key] = v;
    onChange({ ...m, people });
  };

  return (
    <div>
      <h3 className="pm-imp-h">Match columns</h3>
      <p className="pm-imp-sub">
        {analysis.totalRows.toLocaleString("en-US")} {analysis.totalRows === 1 ? "row" : "rows"} in the file. Pick the column
        for each field, or leave it out.
      </p>

      {FIELD_ROWS.map((f) => {
        const k = boundKey(m, f.key);
        const bound = m.columns[k] ?? [];
        const id = `imp-col-${f.key}`;
        return (
          <div className="pm-imp-field" key={f.key}>
            <label htmlFor={id}>{f.label}</label>
            <select
              id={id}
              className="pm-input"
              value={bound[0] ?? ""}
              onChange={(e) => onChange(withColumn(m, f.key, e.target.value))}
            >
              <option value="">{f.key === "name" ? "Choose a column" : "Don’t import"}</option>
              {analysis.columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {bound.length > 1 && <div className="also">Also reads {bound.slice(1).join(", ")}</div>}
            {f.hint && bound.length <= 1 && <div className="also">{f.hint}</div>}
          </div>
        );
      })}

      {hasDates && (
        <div className="pm-imp-field">
          <label htmlFor="imp-date-order">Date format</label>
          <select
            id="imp-date-order"
            className="pm-input"
            value={m.dateOrder}
            onChange={(e) => onChange({ ...m, dateOrder: e.target.value as DateOrder | "auto" })}
          >
            {DATE_ORDERS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
      {hasLists && (
        <div className="pm-imp-field">
          <label htmlFor="imp-sep">Several in one cell</label>
          <select
            id="imp-sep"
            className="pm-input"
            value={m.listSeparator}
            onChange={(e) => onChange({ ...m, listSeparator: e.target.value })}
          >
            {SEPARATORS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div style={{ margin: "8px 0 4px" }}>
        <label className="pm-imp-check">
          <input
            type="checkbox"
            checked={m.createMissingStates}
            onChange={(e) => onChange({ ...m, createMissingStates: e.target.checked })}
          />
          Create states that don’t exist yet
        </label>
        <label className="pm-imp-check">
          <input
            type="checkbox"
            checked={m.createMissingLabels}
            onChange={(e) => onChange({ ...m, createMissingLabels: e.target.checked })}
          />
          Create labels that don’t exist yet
        </label>
      </div>

      {analysis.statuses.length > 0 && (
        <section style={{ marginTop: 18 }} aria-label="Statuses">
          <h4 className="pm-imp-h">Statuses</h4>
          <div className="pm-imp-scroll tall">
            <table className="pm-imp-table">
              <thead>
                <tr>
                  <th scope="col">In the file</th>
                  <th scope="col" className="num">
                    Rows
                  </th>
                  <th scope="col">Becomes</th>
                </tr>
              </thead>
              <tbody>
                {analysis.statuses.map((s) => (
                  <StatusRow key={s.key} s={s} analysis={analysis} onChange={(d) => setStatus(s.key, d)} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {analysis.priorities.length > 0 && (
        <section style={{ marginTop: 18 }} aria-label="Priorities">
          <h4 className="pm-imp-h">Priorities</h4>
          <div className="pm-imp-scroll tall">
            <table className="pm-imp-table">
              <thead>
                <tr>
                  <th scope="col">In the file</th>
                  <th scope="col" className="num">
                    Rows
                  </th>
                  <th scope="col">Becomes</th>
                  <th scope="col">
                    <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>Note</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {analysis.priorities.map((p) => (
                  <PriorityRow key={p.key} p={p} onChange={(v) => setPriority(p.key, v)} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {analysis.people.length > 0 && (
        <section style={{ marginTop: 18 }} aria-label="People">
          <h4 className="pm-imp-h">People</h4>
          <p className="pm-imp-sub">
            Matched by email, then name, then username, against active members. Guests aren’t assigned by an import.
          </p>
          <div className="pm-imp-scroll tall">
            <table className="pm-imp-table">
              <thead>
                <tr>
                  <th scope="col">In the file</th>
                  <th scope="col" className="num">
                    Items
                  </th>
                  <th scope="col">Assign to</th>
                  <th scope="col">Match</th>
                </tr>
              </thead>
              <tbody>
                {analysis.people.map((p) => (
                  <PersonRow key={p.key} p={p} members={analysis.members} onChange={(v) => setPerson(p.key, v)} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// ── step 4 — preview ────────────────────────────────────────────────────────

const ACTION_LABEL: Record<PreviewRow["action"], string> = { create: "Create", update: "Update", skip: "Skip" };
const ACTION_CLASS: Record<PreviewRow["action"], string> = { create: "unstarted", update: "started", skip: "" };

export function PreviewStep({ analysis }: { analysis: ImportAnalysis }): JSX.Element {
  const c = analysis.counts;
  const unmatched = analysis.people.filter((p) => !p.userId && p.by !== "override").length;
  return (
    <div>
      <h3 className="pm-imp-h">Check the preview</h3>
      <p className="pm-imp-sub">This is how the first rows will land. Nothing has been imported yet.</p>
      <div className="pm-imp-tiles">
        <div className="pm-imp-tile">
          <div className="v">{c.create.toLocaleString("en-US")}</div>
          <div className="l">To create</div>
        </div>
        <div className="pm-imp-tile">
          <div className="v">{c.update.toLocaleString("en-US")}</div>
          <div className="l">To update</div>
        </div>
        <div className="pm-imp-tile">
          <div className="v">{c.skip.toLocaleString("en-US")}</div>
          <div className="l">To skip</div>
        </div>
        <div className="pm-imp-tile">
          <div className="v">{unmatched}</div>
          <div className="l">People not matched</div>
        </div>
      </div>

      {(analysis.newStates.length > 0 || analysis.newLabels.length > 0) && (
        <ul className="pm-imp-list" aria-label="What will be added to the project">
          {analysis.newStates.length > 0 && (
            <li>
              New {analysis.newStates.length === 1 ? "state" : "states"}:{" "}
              {analysis.newStates.map((s) => s.name).join(", ")}
            </li>
          )}
          {analysis.newLabels.length > 0 && (
            <li>
              {analysis.newLabels.length} new {analysis.newLabels.length === 1 ? "label" : "labels"}:{" "}
              {analysis.newLabels.slice(0, 8).join(", ")}
              {analysis.newLabels.length > 8 ? ` and ${analysis.newLabels.length - 8} more` : ""}
            </li>
          )}
        </ul>
      )}
      {analysis.notes.length > 0 && (
        <ul className="pm-imp-notes" aria-label="Things to know">
          {analysis.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <div className="pm-imp-scroll" style={{ marginTop: 14 }}>
        <table className="pm-imp-table">
          <caption style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>
            First {analysis.preview.length} rows
          </caption>
          <thead>
            <tr>
              <th scope="col" className="num">
                Row
              </th>
              <th scope="col">Title</th>
              <th scope="col">Action</th>
              <th scope="col">State</th>
              <th scope="col">Priority</th>
              <th scope="col">Assignees</th>
              <th scope="col">Labels</th>
              <th scope="col">Due</th>
            </tr>
          </thead>
          <tbody>
            {analysis.preview.map((r) => (
              <tr key={r.row}>
                <td className="num muted">{r.row}</td>
                <td style={{ minWidth: 180 }}>
                  {r.key && <span className="pm-mono muted" style={{ marginRight: 6 }}>{r.key}</span>}
                  {r.name || <span className="muted">No title</span>}
                  {r.issues.map((i) => (
                    <div key={i} className="muted" style={{ fontSize: 11.5 }}>
                      {i}
                    </div>
                  ))}
                </td>
                <td>
                  <span className={"pm-statechip " + ACTION_CLASS[r.action]}>{ACTION_LABEL[r.action]}</span>
                  {r.skipReason && (
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                      {r.skipReason}
                    </div>
                  )}
                </td>
                <td>
                  {r.status ? (
                    <>
                      {r.status.text}
                      {r.status.isNew && <span className="pm-tag sm" style={{ marginLeft: 6 }}>New</span>}
                    </>
                  ) : (
                    <span className="muted">Default</span>
                  )}
                </td>
                <td>{r.priority ? PRIORITY[r.priority].label : <span className="muted">—</span>}</td>
                <td>
                  {r.assignees.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    r.assignees.map((a) => (
                      <div key={a.value}>
                        {a.name ?? a.value}
                        {a.problem && (
                          <div className="muted" style={{ fontSize: 11.5 }}>
                            Not matched — {a.problem}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </td>
                <td>{r.labels.length > 0 ? r.labels.join(", ") : <span className="muted">—</span>}</td>
                <td className="pm-mono">{r.dueDate ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pm-imp-sub" style={{ marginTop: 8 }}>
        Showing the first {analysis.preview.length} of {analysis.totalRows.toLocaleString("en-US")} rows.
      </p>
    </div>
  );
}

// ── step 5 — run, progress, summary ─────────────────────────────────────────

const SKIP_WORDS: Record<string, string> = {
  unchanged: "already imported and unchanged",
  missing_title: "had no title",
  archived_in_source: "were archived in the source",
  duplicate_id_in_file: "repeated an id from earlier in the file",
  error: "couldn’t be saved",
};

export function RunStep({ job }: { job: ImportJob }): JSX.Element {
  const s = job.stats;
  const pct = s.toProcess > 0 ? Math.min(100, Math.round((s.processed / s.toProcess) * 100)) : 0;

  if (job.status === "PENDING" || job.status === "RUNNING") {
    return (
      <div aria-live="polite">
        <h3 className="pm-imp-h">{job.status === "PENDING" ? "Waiting to start" : "Importing"}</h3>
        <p className="pm-imp-sub">
          {job.status === "PENDING"
            ? "The import is queued and will start in a moment."
            : `${s.processed.toLocaleString("en-US")} of ${s.toProcess.toLocaleString("en-US")} rows`}
          . You can close this window — the import keeps running.
        </p>
        <div
          className="pm-imp-bar"
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
        <p className="pm-imp-sub" style={{ marginTop: 8 }}>
          {s.created} created · {s.updated} updated · {s.skipped} skipped so far
        </p>
      </div>
    );
  }

  if (job.status === "FAILED") {
    return (
      <div>
        <h3 className="pm-imp-h">The import stopped</h3>
        <div className="pm-imp-error" role="alert">
          {job.error ?? "Something went wrong."}
        </div>
        <p className="pm-imp-sub" style={{ marginTop: 10 }}>
          {s.processed.toLocaleString("en-US")} of {s.toProcess.toLocaleString("en-US")} rows were handled and are kept.
          Run it again to continue from where it stopped.
        </p>
      </div>
    );
  }

  if (job.status === "CANCELLED") {
    return (
      <div>
        <h3 className="pm-imp-h">Import cancelled</h3>
        <p className="pm-imp-sub">
          It stopped after {s.processed.toLocaleString("en-US")} of {s.toProcess.toLocaleString("en-US")} rows. Items
          already imported stay in the project: {s.created} created, {s.updated} updated.
        </p>
      </div>
    );
  }

  if (job.status === "PREVIEWED") {
    return <EmptyBlock icon="inbox" heading="Ready to import" body="Start the import from the preview." />;
  }

  // SUCCEEDED
  const reasons = Object.entries(s.skippedReasons).filter(([, n]) => n > 0);
  return (
    <div aria-live="polite">
      <h3 className="pm-imp-h">Import finished</h3>
      <div className="pm-imp-tiles">
        <div className="pm-imp-tile">
          <div className="v">{s.created.toLocaleString("en-US")}</div>
          <div className="l">Created</div>
        </div>
        <div className="pm-imp-tile">
          <div className="v">{s.updated.toLocaleString("en-US")}</div>
          <div className="l">Updated</div>
        </div>
        <div className="pm-imp-tile">
          <div className="v">{s.skipped.toLocaleString("en-US")}</div>
          <div className="l">Skipped</div>
        </div>
      </div>
      {reasons.length > 0 && (
        <ul className="pm-imp-list" aria-label="Why rows were skipped">
          {reasons.map(([code, n]) => (
            <li key={code}>
              {n.toLocaleString("en-US")} {SKIP_WORDS[code] ?? code}
            </li>
          ))}
        </ul>
      )}
      {(s.createdStates.length > 0 || s.createdLabels.length > 0) && (
        <ul className="pm-imp-list" aria-label="Added to the project">
          {s.createdStates.length > 0 && <li>New states: {s.createdStates.join(", ")}</li>}
          {s.createdLabels.length > 0 && <li>{s.createdLabels.length} new labels</li>}
        </ul>
      )}

      {s.unknownAssignees.length > 0 && (
        <section style={{ marginTop: 16 }} aria-label="People not matched">
          <h4 className="pm-imp-h">People we couldn’t match</h4>
          <p className="pm-imp-sub">
            Their items were imported without them. Add them as members, then import the same file again to assign them.
          </p>
          <div className="pm-imp-scroll tall">
            <table className="pm-imp-table">
              <thead>
                <tr>
                  <th scope="col">In the file</th>
                  <th scope="col" className="num">
                    Items
                  </th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {s.unknownAssignees.map((u) => (
                  <tr key={u.value}>
                    <td>{u.value}</td>
                    <td className="num">{u.count}</td>
                    <td className="muted">{u.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {s.issues.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-2)" }}>
            Details for {s.issues.length}
            {s.issuesTruncated ? "+" : ""} {s.issues.length === 1 && !s.issuesTruncated ? "row" : "rows"}
          </summary>
          <ul className="pm-imp-list">
            {s.issues.map((i, n) => (
              <li key={`${i.row}-${i.code}-${n}`}>
                Row {i.row}
                {i.key ? ` (${i.key})` : ""}: {i.message}
              </li>
            ))}
          </ul>
          {s.issuesTruncated && <p className="pm-imp-sub">Only the first {s.issues.length} are listed.</p>}
        </details>
      )}
    </div>
  );
}
