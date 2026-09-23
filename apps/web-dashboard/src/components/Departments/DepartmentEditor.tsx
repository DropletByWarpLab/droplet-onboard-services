"use client";

/**
 * WARP-2976 (ADR-059 §2.6, DS-001) — "Customize" for a department home.
 *
 * Three things an owner or the department's manager can change: the icon,
 * which pages the department's nav shows, and the widgets on its home (order,
 * size, add, remove). The template itself is not re-picked here; it only
 * seeded these lists.
 *
 * Two guarantees:
 *   · The page checklist lists only destinations the EDITOR can reach
 *     (`navChoices` runs their own gates) — and a saved href the editor
 *     cannot see is kept, not silently deleted (`mergeNavSelection`). A
 *     manager without Integrations must not strip it from the owner's
 *     Security profile by saving.
 *   · A widget id this dashboard does not know is kept on save too (appended
 *     after the ones it does), so an older dashboard never erases what a
 *     newer one added.
 */
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";

import {
  mergeNavSelection,
  type NavChoice,
} from "@/lib/departments/department-nav";
import {
  DEPARTMENT_ICONS,
  DEPARTMENT_WIDGET_IDS,
  isDepartmentWidgetId,
} from "@/lib/departments/templates";
import type {
  DepartmentHomeWidget,
  DepartmentWidgetSize,
  PutDepartmentProfilePayload,
} from "@/lib/types";

import { DEPARTMENT_WIDGETS } from "./department-widgets";

/** The orchestrator's stable profile-write codes, in words a person can act
 *  on. Shared by the template picker and Customize. */
export function profileSaveErrorCopy(err: unknown): string {
  switch ((err as { code?: string } | undefined)?.code) {
    case "ARCHIVED":
      return "This department is archived, so it can’t be changed.";
    case "FORBIDDEN":
      return "Only an owner, an admin or this department’s manager can change it.";
    case "TEAM_INHERITS_PROFILE":
      return "Teams use their department’s setup.";
    case "VALIDATION_ERROR":
      return "Some of these changes weren’t accepted. Check the pages and widgets, then save again.";
    default:
      return "Couldn’t save your changes. Try again.";
  }
}

const SIZE_LABEL: Record<DepartmentWidgetSize, string> = {
  s: "Small",
  m: "Medium",
  l: "Large",
};

function iconLabel(name: string): string {
  const words = name.replace(/-\d+$/, "").split("-");
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function DepartmentEditor({
  initial,
  choices,
  isModuleOn,
  saving,
  error,
  onSave,
  onCancel,
}: {
  initial: PutDepartmentProfilePayload;
  /** Destinations this editor may pick (their own gates already applied). */
  choices: NavChoice[];
  isModuleOn: (moduleId: string) => boolean;
  saving: boolean;
  error: string | null;
  onSave: (payload: PutDepartmentProfilePayload) => void;
  onCancel: () => void;
}) {
  const [icon, setIcon] = useState(initial.icon);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initial.navHrefs));
  const [widgets, setWidgets] = useState<DepartmentHomeWidget[]>(() =>
    initial.homeWidgets.filter((w) => isDepartmentWidgetId(w.widget)),
  );
  const unknownWidgets = useMemo(
    () => initial.homeWidgets.filter((w) => !isDepartmentWidgetId(w.widget)),
    [initial.homeWidgets],
  );
  const [toAdd, setToAdd] = useState("");
  const addId = useId();

  const addable = DEPARTMENT_WIDGET_IDS.filter((id) => {
    if (widgets.some((w) => w.widget === id)) return false;
    const mod = DEPARTMENT_WIDGETS[id].requiresModule;
    return !mod || isModuleOn(mod);
  });

  const toggle = (href: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(href)) next.delete(href);
      else next.add(href);
      return next;
    });

  const move = (i: number, delta: -1 | 1) =>
    setWidgets((prev) => {
      const j = i + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const submit = () => {
    onSave({
      template: initial.template,
      icon,
      navHrefs: mergeNavSelection(
        initial.navHrefs,
        choices.map((c) => c.href),
        checked,
      ),
      homeWidgets: [...widgets, ...unknownWidgets],
    });
  };

  const iconNames = Object.keys(DEPARTMENT_ICONS);
  const onIconKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = iconNames.indexOf(icon);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % iconNames.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (i - 1 + iconNames.length) % iconNames.length;
    if (next < 0) return;
    e.preventDefault();
    setIcon(iconNames[next]);
    const el = e.currentTarget.querySelector<HTMLElement>(`[data-icon="${iconNames[next]}"]`);
    el?.focus();
  };

  return (
    <form
      className="card dept-editor"
      aria-label="Customize this department"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset>
        <legend>Icon</legend>
        <div role="radiogroup" aria-label="Icon" className="dept-icons" onKeyDown={onIconKey}>
          {iconNames.map((name) => {
            const Icon = DEPARTMENT_ICONS[name];
            const on = name === icon;
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={iconLabel(name)}
                title={iconLabel(name)}
                tabIndex={on || (!iconNames.includes(icon) && name === iconNames[0]) ? 0 : -1}
                data-icon={name}
                className="dept-icon-opt"
                onClick={() => setIcon(name)}
              >
                <Icon size={16} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend>Pages in this department&rsquo;s menu</legend>
        {choices.length === 0 ? (
          <p className="dept-note">There are no pages you can add right now.</p>
        ) : (
          <div className="dept-checks">
            {choices.map((c) => {
              const Icon = c.icon;
              return (
                <label key={c.href} className="dept-check" data-child={c.parentLabel ? "true" : undefined}>
                  <input
                    type="checkbox"
                    checked={checked.has(c.href)}
                    onChange={() => toggle(c.href)}
                  />
                  <Icon size={15} aria-hidden="true" />
                  <span>{c.parentLabel ? `${c.label} (${c.parentLabel})` : c.label}</span>
                </label>
              );
            })}
          </div>
        )}
        <p className="dept-note">
          Settings and Help are always in the menu. A page someone can&rsquo;t open stays hidden
          for them, whatever is picked here.
        </p>
      </fieldset>

      <fieldset>
        <legend>Widgets on the home</legend>
        {widgets.length === 0 ? (
          <p className="dept-note">No widgets yet. Add one below.</p>
        ) : (
          <ul className="dept-widget-list">
            {widgets.map((w, i) => {
              const def = DEPARTMENT_WIDGETS[w.widget as keyof typeof DEPARTMENT_WIDGETS];
              const off = def.requiresModule ? !isModuleOn(def.requiresModule) : false;
              return (
                <li key={w.widget} className="dept-widget-row">
                  <span className="dept-widget-row-name">{def.label}</span>
                  <select
                    aria-label={`Size of ${def.label}`}
                    value={w.size}
                    onChange={(e) =>
                      setWidgets((prev) =>
                        prev.map((x, k) =>
                          k === i ? { ...x, size: e.target.value as DepartmentWidgetSize } : x,
                        ),
                      )
                    }
                  >
                    {(Object.keys(SIZE_LABEL) as DepartmentWidgetSize[]).map((s) => (
                      <option key={s} value={s}>
                        {SIZE_LABEL[s]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Move ${def.label} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Move ${def.label} down`}
                    disabled={i === widgets.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${def.label}`}
                    onClick={() => setWidgets((prev) => prev.filter((_, k) => k !== i))}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                  {off && (
                    <span className="dept-widget-row-note">
                      Not shown to you while its module is off.
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {addable.length > 0 && (
          <div className="dept-editor-actions">
            <label htmlFor={addId} className="sr-only">
              Widget to add
            </label>
            <select id={addId} value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
              <option value="">Choose a widget</option>
              {addable.map((id) => (
                <option key={id} value={id}>
                  {DEPARTMENT_WIDGETS[id].label} — {DEPARTMENT_WIDGETS[id].description}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn sm"
              disabled={!toAdd}
              onClick={() => {
                if (!toAdd) return;
                setWidgets((prev) => [...prev, { widget: toAdd, size: "m" }]);
                setToAdd("");
              }}
            >
              Add widget
            </button>
          </div>
        )}
      </fieldset>

      {error && (
        <p className="dept-error" role="alert">
          {error}
        </p>
      )}

      <div className="dept-editor-actions">
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
