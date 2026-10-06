"use client";

// WARP-3520 -- project details: name, description, icon, colour, lead, department
// and customer. One explicit Save sends ONLY the fields that changed (the API's
// PATCH leaves an omitted field alone and clears one sent as null), so saving a
// rename cannot clobber a lead somebody else just set.

import { useMemo, useState, type FormEvent, type JSX } from "react";
import { useToast } from "@/components/Toast";
import { useCompanies } from "@/components/crm/useCrm";
import { PmIcon } from "../icons";
import { usePerson } from "../bits";
import { editActions } from "../useEditing";
import { useDepartments, usePeople } from "../usePm";
import { toPersonOptions } from "../detail/pickers/PeoplePicker";
import type { PmProject } from "../types";
import { DEFAULT_COLOR, ErrorStrip, SwatchPicker, useSettingsAction } from "./parts";

/** Glyphs a project can wear (the keys of the Projects icon map). */
const PROJECT_ICONS = ["board", "target", "layers", "briefcase", "handshake", "building", "flag", "bulb", "doc", "shield", "spark", "server", "users", "inbox", "cal", "msg"];

export function DetailsTab({
  project,
  onProjectChanged,
}: {
  project: PmProject;
  onProjectChanged: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const person = usePerson();
  const { people: roster } = usePeople();
  const people = useMemo(() => toPersonOptions(roster), [roster]);
  const { departments } = useDepartments();
  // `undefined` when the CRM module is off or the caller cannot read it: the
  // customer field is then simply not offered (an unreadable list is not an error).
  const { companies } = useCompanies("", false);
  const { run, busy, error } = useSettingsAction();

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [icon, setIcon] = useState(project.icon ?? "board");
  const [color, setColor] = useState(project.color ?? DEFAULT_COLOR);
  const [leadId, setLeadId] = useState(project.leadId ?? "");
  const [departmentId, setDepartmentId] = useState(project.department?.id ?? "");
  const [companyId, setCompanyId] = useState(project.companyId ?? "");

  // Only what differs from the saved project.
  const patch: Record<string, unknown> = {};
  if (name.trim() !== project.name) patch.name = name.trim();
  if ((description.trim() || null) !== project.description) patch.description = description.trim() || null;
  if (icon !== (project.icon ?? "board")) patch.icon = icon;
  if (color !== (project.color ?? DEFAULT_COLOR)) patch.color = color;
  if ((leadId || null) !== project.leadId) patch.leadId = leadId || null;
  if ((departmentId || null) !== (project.department?.id ?? null)) patch.department_id = departmentId || null;
  if (companies !== undefined && (companyId || null) !== (project.companyId ?? null)) patch.company_id = companyId || null;
  const dirty = Object.keys(patch).length > 0;

  const departmentChoices = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; kind: string }>();
    for (const d of departments ?? []) if (d.kind !== "HOUSEHOLD") byId.set(d.id, d);
    // The project's own department stays selectable even when the caller's scoped
    // list does not include it (archived, or one they are not a member of).
    if (project.department) byId.set(project.department.id, project.department);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [departments, project.department]);

  const leadChoices = useMemo(() => {
    const options = [...(people ?? [])];
    if (project.leadId && !options.some((p) => p.id === project.leadId)) {
      options.unshift({ id: project.leadId, name: person(project.leadId).name });
    }
    return options;
  }, [people, person, project.leadId]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || !name.trim() || busy) return;
    const ok = await run(() => editActions().updateProject(project.id, patch), () => onProjectChanged());
    if (ok) toast("Project updated.", "success");
  };

  return (
    <form onSubmit={save} noValidate>
      <ErrorStrip message={error} />

      <div className="pm-field" style={{ marginBottom: 14 }}>
        <label htmlFor="pm-set-name">Name</label>
        <input id="pm-set-name" className="pm-input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        {!name.trim() && <div className="pm-field-error">Name can&apos;t be empty.</div>}
      </div>

      <div className="pm-field" style={{ marginBottom: 14 }}>
        <label htmlFor="pm-set-desc">Description</label>
        <textarea id="pm-set-desc" className="pm-input" rows={3} placeholder="Add a description" value={description} maxLength={10000} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="pm-field" style={{ marginBottom: 14 }}>
        <label id="pm-set-icon">Icon</label>
        <div className="pm-icon-choices" role="group" aria-labelledby="pm-set-icon">
          {PROJECT_ICONS.map((i) => (
            <button key={i} type="button" className="pm-icon-choice" aria-label={i} aria-pressed={icon === i} onClick={() => setIcon(i)}>
              <PmIcon name={i} size={16} />
            </button>
          ))}
        </div>
      </div>

      <div className="pm-field" style={{ marginBottom: 14 }}>
        <label id="pm-set-color">Color</label>
        <SwatchPicker value={color} label="Project color" onPick={setColor} />
      </div>

      <div className="pm-row" style={{ gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="pm-field" style={{ flex: "1 1 200px", marginBottom: 14 }}>
          <label htmlFor="pm-set-lead">Lead</label>
          <select
            id="pm-set-lead"
            className="pm-input"
            value={leadId}
            disabled={people === undefined && !project.leadId}
            onChange={(e) => setLeadId(e.target.value)}
          >
            <option value="">{people === undefined && !project.leadId ? "The people list isn't available" : "No lead"}</option>
            {leadChoices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="pm-field" style={{ flex: "1 1 200px", marginBottom: 14 }}>
          <label htmlFor="pm-set-dept">Department</label>
          <select id="pm-set-dept" className="pm-input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">No department</option>
            {departmentChoices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.kind === "TEAM" ? `${d.name} (team)` : d.name}
              </option>
            ))}
          </select>
        </div>

        {(companies !== undefined || project.companyId) && (
          <div className="pm-field" style={{ flex: "1 1 200px", marginBottom: 14 }}>
            <label htmlFor="pm-set-company">Customer</label>
            <select
              id="pm-set-company"
              className="pm-input"
              value={companyId}
              disabled={companies === undefined}
              onChange={(e) => setCompanyId(e.target.value)}
            >
              <option value="">No customer</option>
              {companyId && !(companies ?? []).some((c) => c.id === companyId) && <option value={companyId}>Current customer</option>}
              {(companies ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="pm-row" style={{ justifyContent: "flex-end" }}>
        <button type="submit" className="pm-btn primary" disabled={!dirty || !name.trim() || busy}>
          {busy ? "Working…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
