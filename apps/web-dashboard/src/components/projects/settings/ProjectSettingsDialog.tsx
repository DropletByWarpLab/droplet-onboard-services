"use client";

// WARP-3520 -- Project settings, opened from the project header: details, states,
// labels and custom fields in one dialog. The canonical <Dialog> gives it the
// focus trap, Escape, scroll lock and focus return; the tabs are the ARIA tab
// pattern (roving focus, Arrow/Home/End).

import { useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Dialog } from "@/components/Dialog";
import { SafetyChip } from "../bits";
import type { PmProject } from "../types";
import { DetailsTab } from "./DetailsTab";
import { StatesTab } from "./StatesTab";
import { LabelsTab } from "./LabelsTab";
import { FieldsTab } from "./FieldsTab";
import "./settings.css";

type Tab = "details" | "states" | "labels" | "fields";
const TABS: Array<[Tab, string]> = [
  ["details", "Details"],
  ["states", "States"],
  ["labels", "Labels"],
  ["fields", "Fields"],
];

export function ProjectSettingsDialog({
  project,
  canManageFields,
  onClose,
  onProjectChanged,
  onItemsChanged,
}: {
  project: PmProject;
  /** Owner / admin / the project's lead may define fields; everyone else sees them. */
  canManageFields: boolean;
  onClose: () => void;
  /** Name, colour, lead… changed — the project list and header must refresh. */
  onProjectChanged: () => void;
  /** A state, label or field changed — the cards on the board show them. */
  onItemsChanged: () => void;
}): JSX.Element {
  const titleId = useId();
  const baseId = useId();
  const [tab, setTab] = useState<Tab>("details");
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex(([id]) => id === tab);
    const next =
      e.key === "ArrowRight" ? (at + 1) % TABS.length
      : e.key === "ArrowLeft" ? (at - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? TABS.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    const [id] = TABS[next];
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="2xl" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <div className="pm-set-head">
          <h2 id={titleId} style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            Project settings <span className="pm-mono" style={{ fontSize: 12.5, color: "var(--text-3)" }}>· {project.identifier}</span>
          </h2>
        </div>

        <div className="pm-pills" role="tablist" aria-label="Project settings" onKeyDown={move}>
          {TABS.map(([id, label]) => (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[id] = el;
              }}
              id={`${baseId}-tab-${id}`}
              type="button"
              role="tab"
              className={tab === id ? "on" : ""}
              aria-selected={tab === id}
              aria-controls={`${baseId}-panel`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="pm-set-panel" role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`}>
          {tab === "details" && <DetailsTab project={project} onProjectChanged={onProjectChanged} />}
          {tab === "states" && <StatesTab project={project} onItemsChanged={onItemsChanged} />}
          {tab === "labels" && <LabelsTab project={project} onItemsChanged={onItemsChanged} />}
          {tab === "fields" && <FieldsTab project={project} canManage={canManageFields} onItemsChanged={onItemsChanged} />}
        </div>

        <div className="pm-set-foot">
          <SafetyChip tier="write" />
          <button type="button" className="pm-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
