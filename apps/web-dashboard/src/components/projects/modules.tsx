"use client";

// Modules (milestones / epics) — grouping work beyond the sprint boundary,
// WARP-3521. Replaces the "Modules aren't ready yet" placeholder (design brief
// §3.8): a grid of module cards with progress, lead, status and target date, and
// a detail view that lists a module's work items and lets a writer add and remove
// them. Dates are CALENDAR dates — everything goes through ./date-only.

import { useEffect, useId, useMemo, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "./icons";
import { Avatar, EmptyBlock, PriorityFlag, SafetyChip, Skel, usePerson } from "./bits";
import {
  MODULE_STATUS_LABEL,
  MODULE_STATUS_ORDER,
  ModuleStatusBadge,
  ProgressBar,
  progressText,
} from "./planning-bits";
import { dayDiff, fmtDay, localToday } from "./date-only";
import { useFocusAfterRemoval } from "./focus-after-removal";
import {
  pmActions,
  useModuleItems,
  usePeople,
  useProjectItems,
  useProjectModules,
} from "./usePm";
import type { ModuleStatus, PmModule, PmProject, PmWorkItem } from "./types";

/** The most items one "Add" call may carry — the API's own bound. */
export const MAX_ADD = 200;
/** The project-items route defaults to its first 100 rows until WS-1 pagination. */
const PROJECT_ITEMS_PAGE_CAP = 100;

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function validateModuleForm(v: { name: string; start: string; target: string }): {
  name?: string;
  dates?: string;
} {
  const errors: { name?: string; dates?: string } = {};
  if (!v.name.trim()) errors.name = "Name can't be empty.";
  if (v.start && v.target && dayDiff(v.start, v.target) < 0) {
    errors.dates = "Target date can't be before the start date.";
  }
  return errors;
}

/** "Oct 5 – Dec 1", "Target Dec 1", "Starts Oct 5" or "No dates set" — a module's
 *  second date is a TARGET, which is not what a cycle's "Ends" means. */
export function moduleDates(start: string | null, target: string | null): string {
  if (start && target) return `${fmtDay(start)} – ${fmtDay(target)}`;
  if (target) return `Target ${fmtDay(target)}`;
  if (start) return `Starts ${fmtDay(start)}`;
  return "No dates set";
}

/** Past its target and not finished or dropped. A soft state — orange, never red. */
export function isModuleOverdue(m: Pick<PmModule, "targetDate" | "status">, today: string = localToday()): boolean {
  if (!m.targetDate) return false;
  if (m.status === "completed" || m.status === "cancelled") return false;
  return dayDiff(m.targetDate, today) > 0;
}

// ── Form pieces (small equivalents of the ones in modals.tsx / cycles.tsx) ───

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="pm-field" style={{ marginBottom: 14 }}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error && (
        <div role="alert" style={{ fontSize: 11.5, color: "var(--err)", marginTop: 4 }}>
          {error}
        </div>
      )}
    </div>
  );
}

function Footer({
  onClose,
  onSubmit,
  submitLabel,
  busy,
  disabled,
}: {
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
  disabled?: boolean;
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
        <button className="pm-btn primary" type="button" onClick={onSubmit} disabled={busy || disabled}>
          {busy ? "Working…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── New / edit module ────────────────────────────────────────────────────────

function ModuleFormDialog({
  project,
  module: existing,
  onClose,
  onSaved,
}: {
  project: PmProject;
  module: PmModule | null;
  onClose: () => void;
  onSaved: (m: PmModule) => void;
}): JSX.Element {
  const titleId = useId();
  const nameId = useId();
  const descId = useId();
  const statusId = useId();
  const leadId = useId();
  const startId = useId();
  const targetId = useId();
  const { toast } = useToast();
  const person = usePerson();
  const { users } = usePeople();
  const [name, setName] = useState(existing?.name ?? "");
  const [desc, setDesc] = useState(existing?.description ?? "");
  const [status, setStatus] = useState<ModuleStatus>(existing?.status ?? "backlog");
  const [lead, setLead] = useState(existing?.leadId ?? "");
  const [start, setStart] = useState(existing?.startDate ?? "");
  const [target, setTarget] = useState(existing?.targetDate ?? "");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const errors = validateModuleForm({ name, start, target });

  // A lead is a local User.id; a directory entry with no local row cannot be one.
  const leads = (users ?? []).filter((u) => !!u.userId);
  const leadMissing = lead !== "" && !leads.some((u) => u.userId === lead);

  const submit = async () => {
    setTried(true);
    if (busy || errors.name || errors.dates) return;
    setBusy(true);
    try {
      const actions = pmActions();
      const res = existing
        ? await actions.updateModule(existing.id, {
            name: name.trim(),
            description: desc.trim() || null,
            status,
            lead_id: lead || null,
            start_date: start || null,
            target_date: target || null,
          })
        : await actions.createModule(project.id, {
            name: name.trim(),
            ...(desc.trim() ? { description: desc.trim() } : {}),
            status,
            ...(lead ? { lead_id: lead } : {}),
            ...(start ? { start_date: start } : {}),
            ...(target ? { target_date: target } : {}),
          });
      toast(existing ? "Module saved" : "Module created", "success");
      onSaved(res.module);
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
          {existing ? "Edit module" : "New module"}
        </h2>
        <Field label="Name" htmlFor={nameId} error={tried ? errors.name : undefined}>
          <input
            id={nameId}
            className="pm-input"
            placeholder="e.g. Spring launch"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Description" htmlFor={descId}>
          <textarea
            id={descId}
            className="pm-input"
            placeholder="Add a description"
            rows={2}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </Field>
        <div className="pm-row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <Field label="Status" htmlFor={statusId}>
              <select id={statusId} className="pm-input" value={status} onChange={(e) => setStatus(e.target.value as ModuleStatus)}>
                {MODULE_STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {MODULE_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Lead" htmlFor={leadId}>
              <select id={leadId} className="pm-input" value={lead} onChange={(e) => setLead(e.target.value)}>
                <option value="">No lead</option>
                {leadMissing && <option value={lead}>{person(lead).name}</option>}
                {leads.map((u) => (
                  <option key={u.userId as string} value={u.userId as string}>
                    {u.displayName}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
        <div className="pm-row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <Field label="Start date" htmlFor={startId}>
              <input id={startId} className="pm-input pm-mono" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Target date" htmlFor={targetId} error={tried || start || target ? errors.dates : undefined}>
              <input id={targetId} className="pm-input pm-mono" type="date" value={target} onChange={(e) => setTarget(e.target.value)} />
            </Field>
          </div>
        </div>
        <Footer
          onClose={onClose}
          onSubmit={submit}
          submitLabel={existing ? "Save" : "Create module"}
          busy={busy}
        />
      </div>
    </Dialog>
  );
}

// ── Add work items to a module ───────────────────────────────────────────────

function AddItemsDialog({
  project,
  module: mod,
  existingIds,
  onClose,
  onAdded,
}: {
  project: PmProject;
  module: PmModule;
  existingIds: ReadonlySet<string>;
  onClose: () => void;
  onAdded: () => void;
}): JSX.Element {
  const titleId = useId();
  const searchId = useId();
  const { toast } = useToast();
  const { items, isLoading, error } = useProjectItems(project.id);
  const reachedPageCap = (items?.length ?? 0) >= PROJECT_ITEMS_PAGE_CAP;
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? [])
      .filter((i) => !existingIds.has(i.id))
      .filter((i) => !needle || i.name.toLowerCase().includes(needle) || i.key.toLowerCase().includes(needle));
  }, [items, existingIds, q]);

  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_ADD) next.add(id);
      return next;
    });

  const submit = async () => {
    if (busy || picked.size === 0) return;
    setBusy(true);
    try {
      await pmActions().addModuleItems(mod.id, [...picked]);
      toast(`Added ${picked.size} ${picked.size === 1 ? "item" : "items"} to ${mod.name}`, "success");
      onAdded();
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
        <h2 id={titleId} style={{ margin: "0 0 12px", fontSize: 18, fontWeight: 600 }}>
          Add work items to {mod.name}
        </h2>
        <div className="pm-search" style={{ marginBottom: 10 }}>
          <PmIcon name="search" size={14} />
          <input
            id={searchId}
            placeholder="Search work items"
            aria-label="Search work items"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="pm-module-picklist" role="group" aria-label="Work items">
          {error && !items ? (
            <EmptyBlock icon="alert" tone="error" heading="Couldn't load work items." body="Check the appliance connection and try again." />
          ) : isLoading && !items ? (
            <Skel w="100%" h={120} r={8} />
          ) : candidates.length === 0 ? (
            <p className="pm-cycle-hint" style={{ padding: "14px 4px" }}>
              {q.trim()
                ? "No work items match that search."
                : reachedPageCap
                  ? `Showing the first ${PROJECT_ITEMS_PAGE_CAP} work items. All shown items are already in this module.`
                  : "Every work item in this project is already in this module."}
            </p>
          ) : (
            <>
              {candidates.map((i) => (
                <label key={i.id} className="pm-module-pick">
                  <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
                  <span className="pm-mono pm-backlog-key">{i.key}</span>
                  <span className="pm-backlog-name-text">{i.name}</span>
                </label>
              ))}
              {reachedPageCap && <p className="pm-cycle-hint">Showing the first {PROJECT_ITEMS_PAGE_CAP} work items.</p>}
            </>
          )}
        </div>
        {picked.size >= MAX_ADD && <p className="pm-cycle-hint">You can add up to {MAX_ADD} items at a time.</p>}
        <Footer
          onClose={onClose}
          onSubmit={submit}
          submitLabel={picked.size > 0 ? `Add ${picked.size} ${picked.size === 1 ? "item" : "items"}` : "Add items"}
          busy={busy}
          disabled={picked.size === 0}
        />
      </div>
    </Dialog>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────────

function ModuleCard({ module: m, onOpen }: { module: PmModule; onOpen: (m: PmModule) => void }): JSX.Element {
  const metaId = useId();
  const person = usePerson();
  const overdue = isModuleOverdue(m);
  const finished = m.status === "completed";
  return (
    <div
      className="pm-card pm-module-card"
      role="button"
      tabIndex={0}
      aria-label={`${m.name}, ${MODULE_STATUS_LABEL[m.status]}`}
      // A button's children are presentational to a screen reader, so the lead,
      // the target and the progress words ride along as its description.
      aria-describedby={`${metaId}-lead ${metaId}-progress`}
      onClick={() => onOpen(m)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(m);
        }
      }}
    >
      <div className="pm-row pm-cycle-head">
        <span className="pm-cycle-name">{m.name}</span>
        <ModuleStatusBadge status={m.status} />
      </div>
      <div className="pm-cycle-meta pm-module-lead" id={`${metaId}-lead`}>
        {m.leadId ? (
          <>
            <Avatar id={m.leadId} size={20} />
            <span>Lead — {person(m.leadId).name}</span>
          </>
        ) : (
          <span>No lead</span>
        )}
      </div>
      {m.targetDate && (
        <div className="pm-cycle-meta" style={overdue ? { color: "var(--text-2)" } : undefined}>
          <span className="pm-mono">Target {fmtDay(m.targetDate)}</span>
          {overdue ? " · Past target" : ""}
        </div>
      )}
      <ProgressBar progress={m.progress} label={m.name} tone={finished ? "ok" : "accent"} />
      <div className="pm-cycle-figures" id={`${metaId}-progress`}>
        <span>{progressText(m.progress)}</span>
        {m.progress.totalEstimate > 0 && <span className="pm-mono">{progressText(m.progress, "estimate")}</span>}
      </div>
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

function ModuleDetail({
  module: m,
  project,
  readOnly,
  onBack,
  onOpenItem,
  onChanged,
  refreshModules,
}: {
  module: PmModule;
  project: PmProject;
  readOnly: boolean;
  onBack: () => void;
  onOpenItem: (item: PmWorkItem) => void;
  onChanged: () => void;
  refreshModules: () => Promise<unknown>;
}): JSX.Element {
  const { toast } = useToast();
  const person = usePerson();
  const itemsQ = useModuleItems(m.id);
  const [dialog, setDialog] = useState<"edit" | "delete" | "add" | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [announce, setAnnounce] = useState("");
  const items = itemsQ.items;
  const existingIds = useMemo(() => new Set((items ?? []).map((i) => i.id)), [items]);
  const overdue = isModuleOverdue(m);
  // Removing an item removes its row; keyboard focus must not fall to <body> with it.
  const focus = useFocusAfterRemoval(items ?? [], busyIds);

  const refreshAll = async () => {
    await Promise.all([itemsQ.mutate(), refreshModules()]);
    onChanged();
  };

  const removeItem = async (item: PmWorkItem) => {
    if (busyIds.has(item.id)) return;
    setBusyIds((s) => new Set(s).add(item.id));
    try {
      await pmActions().removeModuleItem(m.id, item.id);
      await refreshAll();
      setAnnounce(`Removed ${item.key} from ${m.name}.`);
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  };

  const remove = async () => {
    try {
      await pmActions().deleteModule(m.id);
      toast("Module deleted", "success");
      await refreshModules();
      onChanged();
      onBack();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
      throw e; // ConfirmDialog keeps itself open on a rejection
    }
  };

  return (
    <div className="pm-cycle-detail">
      <button className="pm-btn ghost sm" type="button" onClick={onBack} style={{ alignSelf: "flex-start" }}>
        <PmIcon name="chevL" size={14} /> All modules
      </button>

      <div className="pm-cycle-detail-head">
        <div style={{ minWidth: 0 }}>
          <div className="pm-row" style={{ gap: 10, flexWrap: "wrap" }}>
            <h2 className="pm-cycle-title">{m.name}</h2>
            <ModuleStatusBadge status={m.status} />
          </div>
          <div className="pm-cycle-meta pm-module-lead">
            {m.leadId ? (
              <>
                <Avatar id={m.leadId} size={20} />
                <span>Lead — {person(m.leadId).name}</span>
              </>
            ) : (
              <span>No lead</span>
            )}
            <span className="pm-mono" style={overdue ? { color: "var(--text-2)" } : undefined}>
              {" · "}
              {moduleDates(m.startDate, m.targetDate)}
              {overdue ? " · Past target" : ""}
            </span>
          </div>
          {m.description && <p className="pm-cycle-desc">{m.description}</p>}
        </div>
        {!readOnly && (
          <div className="pm-row pm-cycle-actions">
            <button className="pm-btn primary" type="button" onClick={() => setDialog("add")}>
              <PmIcon name="plus" size={14} /> Add work items
            </button>
            <button className="pm-btn" type="button" onClick={() => setDialog("edit")}>
              Edit
            </button>
            <button className="pm-btn" type="button" onClick={() => setDialog("delete")}>
              Delete
            </button>
          </div>
        )}
      </div>

      <div className="pm-cycle-progress">
        <ProgressBar progress={m.progress} label={m.name} tone={m.status === "completed" ? "ok" : "accent"} />
        <span className="pm-cycle-figures">{progressText(m.progress)}</span>
      </div>

      <section className="pm-surface pm-cycle-panel" aria-label="Work items in this module">
        <div className="pm-sect pm-focus-target" tabIndex={-1} ref={focus.headingRef} style={{ marginBottom: 6 }}>
          Work items <span className="sx">{itemsQ.total ?? items?.length ?? 0}</span>
        </div>
        {itemsQ.error && !items ? (
          <EmptyBlock
            icon="alert"
            tone="error"
            heading="Couldn't load this module."
            body="Check the appliance connection and try again."
            cta={
              <button className="pm-btn ghost" type="button" onClick={() => void itemsQ.mutate()}>
                Try again
              </button>
            }
          />
        ) : itemsQ.isLoading && !items ? (
          <div>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="pm-row" style={{ gap: 10, padding: "10px 2px", borderBottom: "1px solid var(--border)" }}>
                <Skel w={52} h={11} />
                <Skel w="60%" h={12} />
              </div>
            ))}
          </div>
        ) : !items || items.length === 0 ? (
          <EmptyBlock
            icon="inbox"
            heading="No work items in this module yet."
            body={readOnly ? undefined : "Add some to start tracking progress."}
          />
        ) : (
          <div>
            {items.map((item) => (
              <div key={item.id} className="pm-backlog-row">
                <span className="pm-mono pm-backlog-key">{item.key}</span>
                <span className="pm-dot" style={{ background: item.state?.color ?? "var(--text-4)" }} />
                <PriorityFlag p={item.priority} size={12} />
                <button type="button" className="pm-backlog-name" onClick={() => onOpenItem(item)}>
                  {item.name}
                </button>
                {item.state && <span className="pm-cycle-meta">{item.state.name}</span>}
                {!readOnly && (
                  <button
                    type="button"
                    className="pm-iconbtn"
                    ref={focus.rowRef(item.id)}
                    disabled={busyIds.has(item.id)}
                    aria-label={`Remove ${item.key} from ${m.name}`}
                    title="Remove from module"
                    onClick={(e) => {
                      focus.arm(item.id, e.currentTarget);
                      void removeItem(item);
                    }}
                  >
                    <PmIcon name="x" size={14} />
                  </button>
                )}
              </div>
            ))}
            {itemsQ.total !== undefined && itemsQ.total > items.length && (
              <p className="pm-cycle-hint" style={{ marginTop: 8 }}>
                Showing {items.length} of {itemsQ.total}
              </p>
            )}
          </div>
        )}
      </section>

      <div role="status" aria-live="polite" className="pm-sr-only">
        {announce}
      </div>

      {dialog === "edit" && (
        <ModuleFormDialog project={project} module={m} onClose={() => setDialog(null)} onSaved={() => void refreshAll()} />
      )}
      {dialog === "add" && (
        <AddItemsDialog
          project={project}
          module={m}
          existingIds={existingIds}
          onClose={() => setDialog(null)}
          onAdded={() => void refreshAll()}
        />
      )}
      <ConfirmDialog
        open={dialog === "delete"}
        onCancel={() => setDialog(null)}
        onConfirm={remove}
        title="Delete this module?"
        description="Its work items stay where they are. This can't be undone."
        confirmLabel="Delete module"
      />
    </div>
  );
}

// ── The view ─────────────────────────────────────────────────────────────────

export function ModulesView({
  project,
  readOnly,
  onOpenItem,
  onChanged,
}: {
  project: PmProject;
  readOnly: boolean;
  /** Open the work-item drawer. */
  onOpenItem: (item: PmWorkItem) => void;
  /** After any write, so the page refreshes what it shows. */
  onChanged: () => void;
}): JSX.Element {
  const { modules, error, isLoading, mutate } = useProjectModules(project.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // A module deleted (here or elsewhere) while open: back to the list.
  useEffect(() => {
    if (selectedId && modules && !modules.some((m) => m.id === selectedId)) setSelectedId(null);
  }, [modules, selectedId]);

  const selected = modules?.find((m) => m.id === selectedId) ?? null;

  if (selected) {
    return (
      <ModuleDetail
        module={selected}
        project={project}
        readOnly={readOnly}
        onBack={() => setSelectedId(null)}
        onOpenItem={onOpenItem}
        onChanged={onChanged}
        refreshModules={() => mutate()}
      />
    );
  }

  const list = modules ?? [];
  return (
    <div className="pm-cycle-list">
      <div className="pm-row" style={{ justifyContent: "flex-end", gap: 8, marginBottom: 12 }}>
        {!readOnly && (
          <button className="pm-btn primary" type="button" onClick={() => setCreating(true)}>
            <PmIcon name="plus" size={14} /> New module
          </button>
        )}
        <button className="pm-btn" type="button" onClick={() => void mutate()} aria-label="Refresh modules">
          <PmIcon name="refresh" size={15} />
        </button>
      </div>

      {error && !modules ? (
        <div className="pm-surface" style={{ padding: 8 }}>
          <EmptyBlock
            icon="alert"
            tone="error"
            heading="Couldn't load modules."
            body="Check the appliance connection and try again."
            cta={
              <button className="pm-btn ghost" type="button" onClick={() => void mutate()}>
                Try again
              </button>
            }
          />
        </div>
      ) : isLoading && !modules ? (
        <div className="pm-cycle-grid" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="pm-card" style={{ cursor: "default", gap: 10 }}>
              <Skel w="55%" h={14} />
              <Skel w="40%" h={11} />
              <Skel w="100%" h={8} r={4} />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="pm-surface" style={{ padding: 8 }}>
          <EmptyBlock
            icon="layers"
            heading="No modules yet."
            body="Group work into bigger efforts here."
            cta={
              !readOnly ? (
                <button className="pm-btn primary" type="button" onClick={() => setCreating(true)}>
                  <PmIcon name="plus" size={14} /> New module
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="pm-cycle-grid">
          {list.map((m) => (
            <ModuleCard key={m.id} module={m} onOpen={(mod) => setSelectedId(mod.id)} />
          ))}
        </div>
      )}

      {creating && (
        <ModuleFormDialog
          project={project}
          module={null}
          onClose={() => setCreating(false)}
          onSaved={(m) => {
            // Open the new module only once the list has it.
            void (async () => {
              await mutate();
              onChanged();
              if (m?.id) setSelectedId(m.id);
            })();
          }}
        />
      )}
    </div>
  );
}
