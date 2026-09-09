"use client";

// Create item / create project / delete-project — canonical Dialog (center).

import { useId, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { PmIcon } from "./icons";
import { SafetyChip } from "./bits";
import { PRIORITY_ORDER, PRIORITY } from "./config";
import { pmActions, useProjectStates } from "./usePm";
import type { PmProject, Priority } from "./types";
import { escapeHtml } from "@/lib/escape-html";
import { translateError } from "@/lib/friendly-errors";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="pm-field" style={{ marginBottom: 14 }}>
      <label>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: "var(--text-4)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Footer({
  onClose,
  onSubmit,
  submitLabel,
  busy,
  disabled,
  danger,
}: {
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
  disabled?: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <div
      className="pm-row"
      style={{ justifyContent: "space-between", gap: 8, padding: "14px 0 0", borderTop: "1px solid var(--border)", marginTop: 16 }}
    >
      <SafetyChip tier="write" />
      <div className="pm-row" style={{ gap: 8 }}>
        <button className="pm-btn" type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className={"pm-btn " + (danger ? "danger" : "primary")}
          type="button"
          onClick={onSubmit}
          disabled={busy || disabled}
        >
          {busy ? "Working…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

export function NewItemModal({
  project,
  onClose,
  onCreated,
}: {
  project: PmProject;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const titleId = useId();
  const { toast } = useToast();
  const { states } = useProjectStates(project.id);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [stateId, setStateId] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await pmActions().createWorkItem(project.id, {
        name: name.trim(),
        description_html: desc.trim()
          ? `<p>${escapeHtml(desc.trim()).split("\n").join("<br>")}</p>`
          : undefined,
        state_id: stateId || undefined,
        priority,
        due_date: dueDate ? new Date(dueDate).toISOString() : undefined,
      });
      toast("Item created", "success");
      onCreated();
      onClose();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>
          New item
        </h2>
        <Field label="Title">
          <input className="pm-input" placeholder="What needs doing?" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Description">
          <textarea className="pm-input" placeholder="Add a description" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <div className="pm-row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <Field label="State">
              <select className="pm-input" value={stateId} onChange={(e) => setStateId(e.target.value)}>
                <option value="">Default ({states?.find((s) => s.isDefault)?.name ?? "Todo"})</option>
                {(states ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Priority">
              <select className="pm-input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {PRIORITY_ORDER.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY[p].label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Due date">
              <input className="pm-input pm-mono" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          </div>
        </div>
        <Footer onClose={onClose} onSubmit={submit} submitLabel="Create item" busy={busy} disabled={!name.trim()} />
      </div>
    </Dialog>
  );
}

const SWATCHES = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#8b5cf6"];

export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): JSX.Element {
  const titleId = useId();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [desc, setDesc] = useState("");
  const [color, setColor] = useState(SWATCHES[0]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await pmActions().createProject({
        name: name.trim(),
        identifier: identifier.trim() ? identifier.trim().toUpperCase() : undefined,
        description: desc.trim() || undefined,
        color,
      });
      toast("Project created", "success");
      onCreated();
      onClose();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>
          New project
        </h2>
        <Field label="Name">
          <input className="pm-input" placeholder="e.g. Onboarding" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Identifier" hint="Leave blank to auto-generate from the name">
          <input
            className="pm-input pm-mono"
            placeholder="INBOX"
            value={identifier}
            maxLength={10}
            onChange={(e) => setIdentifier(e.target.value.replace(/[^A-Za-z0-9]/g, ""))}
            style={{ maxWidth: 160 }}
          />
        </Field>
        <Field label="Description">
          <textarea className="pm-input" placeholder="Add a description" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <Field label="Color">
          <div className="pm-row" style={{ gap: 8 }}>
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 7,
                  background: c,
                  cursor: "pointer",
                  border: "none",
                  boxShadow: color === c ? "0 0 0 2px var(--bg-canvas), 0 0 0 4px var(--accent)" : "none",
                }}
              />
            ))}
          </div>
        </Field>
        <Footer onClose={onClose} onSubmit={submit} submitLabel="Create project" busy={busy} disabled={!name.trim()} />
      </div>
    </Dialog>
  );
}

export function ConfirmDeleteProject({
  project,
  onClose,
  onDeleted,
}: {
  project: PmProject;
  onClose: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const titleId = useId();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (confirm !== project.identifier || busy) return;
    setBusy(true);
    try {
      await pmActions().deleteProject(project.id);
      toast("Project deleted", "success");
      onDeleted();
      onClose();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="sm" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>
          Delete project
        </h2>
        <div className="pm-row" style={{ gap: 12, alignItems: "flex-start" }}>
          <span
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: "var(--err-soft)",
              color: "var(--err)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
            }}
          >
            <PmIcon name="alert" size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: "0 0 10px", fontSize: 14, color: "var(--text)", fontWeight: 500 }}>
              Delete this project? This removes its work items and can&apos;t be undone.
            </p>
            <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--text-3)" }}>
              Type <span className="pm-mono" style={{ color: "var(--text)" }}>{project.identifier}</span> to confirm.
            </p>
            <input
              className="pm-input pm-mono"
              placeholder={project.identifier}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        </div>
        <Footer
          onClose={onClose}
          onSubmit={submit}
          submitLabel="Delete"
          busy={busy}
          disabled={confirm !== project.identifier}
          danger
        />
      </div>
    </Dialog>
  );
}
