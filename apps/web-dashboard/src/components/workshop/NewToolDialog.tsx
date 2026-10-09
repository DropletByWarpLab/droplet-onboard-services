"use client";
/**
 * WARP-2974 (ADR-056) — "New custom tool": the door a person walks through
 * to have the box build them a tool.
 *
 * A custom tool starts as a WORKSPACE (WARP-2896): one git repository on the
 * box, seeded from a template under `extensions/templates/`. The templates
 * are read from the box (`/api/workspace/templates`) and laid out by
 * TEMPLATE_INFO: the language templates side by side, each with the file its
 * code lives in and the command that tests it, so a person who codes knows
 * what they are getting; every other start (a connector draft, a template
 * this dashboard does not know, blank) listed under them. Creating one does
 * not run anything — the composer takes over with the workspace selected,
 * and nothing happens until the person sends a goal.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Hammer } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { createWorkspace, listWorkspaceTemplates, TEMPLATE_INFO } from "./workspaces/api";
import { APP_TEMPLATES, NewAppForm } from "./NewAppForm";

const CALM_ERROR = "Something went wrong on the box. Try again in a moment.";

/** The option value for a workspace with no template. */
const BLANK = "";

/**
 * The box's templates in the order the dialog shows them: the language
 * templates TEMPLATE_INFO knows, in its order, then everything else in the
 * box's order — so a connector draft never lands between two languages.
 */
function groupTemplates(ids: string[]): { languages: string[]; others: string[] } {
  const languages = Object.keys(TEMPLATE_INFO).filter((id) => TEMPLATE_INFO[id].kind === "language" && ids.includes(id));
  return { languages, others: ids.filter((id) => !languages.includes(id) && !APP_TEMPLATES.includes(id)) };
}

export interface NewToolDialogProps {
  open: boolean;
  onClose: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
  initialKind?: "tool" | "app";
  onCreated: (workspace: { id: string; name: string; kind?: "app" }) => void;
}

export function NewToolDialog({ open, onClose, triggerRef, onCreated, initialKind = "tool" }: NewToolDialogProps) {
  const [kind, setKind] = useState<"tool" | "app">(initialKind);
  const [name, setName] = useState("");
  const [nameMissing, setNameMissing] = useState(false);
  const [template, setTemplate] = useState(BLANK);
  const [templates, setTemplates] = useState<string[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setError(null);
    setNameMissing(false);
    setTemplatesError(null);
    listWorkspaceTemplates()
      .then((t) => {
        setTemplates(t);
        // Keep a choice the box still offers; otherwise the first language.
        setTemplate((cur) => (cur && t.includes(cur) ? cur : (groupTemplates(t).languages[0] ?? BLANK)));
      })
      .catch((err: unknown) => {
        setTemplates([]);
        setTemplate(BLANK);
        setTemplatesError(err instanceof Error ? err.message : String(err));
      });
  }, [open, initialKind]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameMissing(true);
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createWorkspace({ name: trimmed, ...(template ? { template } : {}) });
      setName("");
      onCreated(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const { languages, others } = groupTemplates(templates ?? []);
  const option = (value: string, body: ReactNode) => (
    <TemplateOption key={value || "blank"} value={value} selected={template === value} onSelect={() => setTemplate(value)}>
      {body}
    </TemplateOption>
  );

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      triggerRef={triggerRef}
      labelledBy="new-tool-heading"
      describedBy="new-tool-sub"
      initialFocusRef={nameRef}
      maxWidth="lg"
    >
      <fieldset className="m-0 p-0 border-0 flex gap-4 mb-4" disabled={busy}>
        <legend className="text-[12.5px] font-medium mb-1">Build</legend>
        <label><input type="radio" name="workspace-kind" checked={kind === "tool"} onChange={() => setKind("tool")} /> Tool</label>
        <label><input type="radio" name="workspace-kind" checked={kind === "app"} onChange={() => setKind("app")} /> App</label>
      </fieldset>
      {kind === "app" ? <NewAppForm templates={templates} onCreated={onCreated} onClose={onClose} initialFocusRef={nameRef} onBusyChange={setBusy} /> : (
      <form onSubmit={(e) => void submit(e)} noValidate aria-label="New custom tool" className="flex flex-col gap-4">
        <div>
          <h2 id="new-tool-heading" className="flex items-center gap-2 text-[16px] font-semibold m-0">
            <Hammer size={16} aria-hidden /> New custom tool
          </h2>
          <p id="new-tool-sub" className="text-[13px] m-0 mt-1" style={{ color: "var(--text-muted)" }}>
            Your Droplet writes it in a workspace of its own on the box. Nothing it builds runs until you review and accept it.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="new-tool-name" className="text-[12.5px] font-medium">
            Name
          </label>
          <input
            id="new-tool-name"
            ref={nameRef}
            type="text"
            required
            maxLength={80}
            value={name}
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
              if (e.target.value.trim()) setNameMissing(false);
            }}
            placeholder="e.g. Booking reminders"
            aria-invalid={nameMissing || undefined}
            aria-describedby={nameMissing ? "new-tool-name-missing" : undefined}
            className="form-input rounded px-2 py-1.5 text-[13px]"
          />
          {nameMissing && (
            <p id="new-tool-name-missing" className="ws-field-error">
              Give the tool a name first.
            </p>
          )}
        </div>

        <fieldset className="m-0 p-0 border-0 flex flex-col gap-2" disabled={busy}>
          <legend className="text-[12.5px] font-medium mb-1">Start from</legend>
          {templates === null ? (
            <p className="ws-note" aria-busy="true">
              Loading the templates…
            </p>
          ) : (
            <>
              {languages.length > 0 && (
                <>
                  <div className="ws-pick-grid">
                    {languages.map((t) => {
                      const info = TEMPLATE_INFO[t];
                      return option(
                        t,
                        <>
                          <span className="ws-pick-t">
                            {info.label}
                            {info.runtime && <span className="ws-pick-rt">{info.runtime}</span>}
                          </span>
                          <span className="ws-pick-code">
                            <code>{info.entry}</code> · <code>{info.test}</code>
                          </span>
                        </>,
                      );
                    })}
                  </div>
                  <p className="ws-note">
                    Each starts from a working <code className="ws-mono">run(input)</code> and its test. There are no packages to
                    install — tools run offline, on what the language ships with.
                  </p>
                </>
              )}
              {templatesError && (
                <p className="ws-note" role="status" title={templatesError}>
                  Couldn&apos;t load the templates from the box. You can still start blank.
                </p>
              )}
              {languages.length > 0 && <p className="ws-pick-sub">Something else</p>}
              {others.map((t) =>
                option(
                  t,
                  <>
                    <span className="ws-pick-t">{TEMPLATE_INFO[t]?.label ?? t}</span>
                    <span className="ws-pick-d">{TEMPLATE_INFO[t]?.blurb ?? "A template on this box."}</span>
                  </>,
                ),
              )}
              {option(
                BLANK,
                <>
                  <span className="ws-pick-t">Blank</span>
                  <span className="ws-pick-d">No starter files. Your Droplet sets up the project itself.</span>
                </>,
              )}
            </>
          )}
        </fieldset>

        <p className="ws-note">
          Next, tell your Droplet what the tool should do. Prefer to code it yourself? Clone it from the workspace pane.
        </p>

        {error && (
          <p role="status" className="text-[13px] m-0" title={error}>
            {CALM_ERROR}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || templates === null} aria-busy={busy}>
            <Hammer size={14} aria-hidden /> {busy ? "Creating…" : "Create tool"}
          </button>
        </div>
      </form>
      )}
    </Dialog>
  );
}

/** One place a tool can start from: a radio and what it gives you, as one hit target. */
function TemplateOption({ value, selected, onSelect, children }: { value: string; selected: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <label className={`ws-pick${selected ? " is-on" : ""}`}>
      <input type="radio" name="template" value={value} checked={selected} onChange={onSelect} data-testid={`template-${value || "blank"}`} />
      <span className="ws-pick-body">{children}</span>
    </label>
  );
}
