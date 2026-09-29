"use client";
/**
 * WARP-2974 (ADR-056) — the composer's `Work in` chip.
 *
 * A menu button, not a native `<select>`: the browser draws a select's open
 * list itself (a light OS list on Windows), so none of the Workshop's tone
 * reaches it. This menu takes the Mac app's chrome (DropletAgent design spec
 * §5): a tone and a soft lift, no stroke; the chosen row carries a check, the
 * focused row a tonal fill.
 *
 * Accessibility: the WAI-ARIA menu-button pattern, as DepartmentSwitcher. The
 * trigger carries `aria-haspopup="menu"` and `aria-expanded`; the choices are
 * `menuitemradio` with exactly one `aria-checked`. Arrow keys, Home and End
 * move focus; Enter and Space pick; Escape closes and returns focus; Tab and
 * a click outside close.
 */
import { Check, ChevronDown, Hammer } from "lucide-react";
import { useMenuButton } from "@/components/ui/useMenuButton";
import "@/components/ui/pick-menu.css";
import type { WorkspaceSummary } from "./workspaces/api";

export const NO_WORKSPACE_LABEL = "No workspace";

interface Choice {
  id: string;
  label: string;
  caption: string;
}

export interface WorkInPickerProps {
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  onWorkspaceId: (id: string) => void;
  disabled?: boolean;
}

export function WorkInPicker({ workspaces, workspaceId, onWorkspaceId, disabled }: WorkInPickerProps) {
  const menu = useMenuButton({ disabled });

  // Only an active workspace takes a new run. The chip still names a chosen
  // workspace that is not (a `?workspace=` link to a proposed one), so what
  // it says always matches what Start would send.
  const choices: Choice[] = [
    { id: "", label: NO_WORKSPACE_LABEL, caption: "An ordinary run, across the box" },
    ...workspaces
      .filter((w) => w.status === "active")
      .map((w) => ({ id: w.id, label: w.name, caption: "Custom tool · a workshop run" })),
  ];
  const currentLabel = workspaces.find((w) => w.id === workspaceId)?.name ?? NO_WORKSPACE_LABEL;

  const pick = (id: string) => {
    onWorkspaceId(id);
    menu.close(true);
  };

  return (
    <div ref={menu.rootRef} className="ws-workin-wrap">
      <button
        ref={menu.buttonRef}
        type="button"
        className="ws-workin"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menu.menuId : undefined}
        aria-label={`Work in: ${currentLabel}`}
        title="An ordinary run works across the box. A custom tool's workspace makes it a workshop run."
        disabled={disabled}
        data-testid="workspace-picker"
        onClick={menu.onButtonClick}
        onKeyDown={menu.onButtonKeyDown}
      >
        <Hammer size={13} aria-hidden />
        <span className="ws-workin-label">{currentLabel}</span>
        <ChevronDown size={14} className="ws-workin-chevron" aria-hidden />
      </button>

      {menu.open && (
        <div
          ref={menu.menuRef}
          id={menu.menuId}
          role="menu"
          aria-label="Work in"
          className="pick-menu"
          data-align={menu.align}
          onKeyDown={menu.onMenuKeyDown}
        >
          {choices.map((c, idx) => (
            <div key={c.id || "__none"} role="none">
              {idx === 1 && <div role="separator" className="pick-sep" />}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={c.id === workspaceId}
                tabIndex={-1}
                className="pick-item"
                onClick={() => pick(c.id)}
              >
                <span className="pick-item-text">
                  <span className="pick-item-name">{c.label}</span>
                  <span className="pick-item-caption">{c.caption}</span>
                </span>
                {c.id === workspaceId && <Check size={14} className="pick-check" aria-hidden />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
