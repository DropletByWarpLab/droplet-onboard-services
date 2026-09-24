"use client";
/**
 * WARP-2974 (ADR-056) — "New custom tool": the door a person walks through
 * to have the box build them a tool.
 *
 * A custom tool starts as a WORKSPACE (WARP-2896): one git repository on the
 * box, seeded from a template under `extensions/templates/`. The templates
 * are read from the box (`/api/workspace/templates`) and shown with the
 * design brief's names (§3.5); an id the brief does not know renders raw.
 * Creating one does not run anything — the composer takes over with the
 * workspace selected, and nothing happens until the person sends a goal.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { Hammer } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { createWorkspace, listWorkspaceTemplates, TEMPLATE_LABELS } from "./workspaces/api";

const CALM_ERROR = "Something went wrong on the box. Try again in a moment.";

export interface NewToolDialogProps {
  open: boolean;
  onClose: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
  onCreated: (workspace: { id: string; name: string }) => void;
}

export function NewToolDialog({ open, onClose, triggerRef, onCreated }: NewToolDialogProps) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [templates, setTemplates] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    listWorkspaceTemplates()
      .then((t) => {
        setTemplates(t);
        setTemplate((cur) => (cur && t.includes(cur) ? cur : (t[0] ?? "")));
      })
      .catch(() => setTemplates([]));
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
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

  return (
    <Dialog open={open} onClose={onClose} triggerRef={triggerRef} labelledBy="new-tool-heading" describedBy="new-tool-sub" initialFocusRef={nameRef}>
      <form onSubmit={(e) => void submit(e)} aria-label="New custom tool" className="flex flex-col gap-4">
        <div>
          <h2 id="new-tool-heading" className="flex items-center gap-2 text-[16px] font-semibold m-0">
            <Hammer size={16} aria-hidden /> New custom tool
          </h2>
          <p id="new-tool-sub" className="text-[13px] m-0 mt-1" style={{ color: "var(--text-muted)" }}>
            A tool your Droplet builds for you, in a workspace of its own on the box. Nothing it builds runs until you accept it.
          </p>
        </div>

        <label className="flex flex-col gap-1 text-[12.5px]">
          Name
          <input
            ref={nameRef}
            type="text"
            required
            maxLength={80}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Booking reminders"
            className="rounded px-2 py-1.5 text-[13px]"
          />
        </label>

        <fieldset className="m-0 p-0 border-0 flex flex-col gap-2" disabled={busy}>
          <legend className="text-[12.5px] mb-1">Start from</legend>
          {templates === null ? (
            <p className="text-[13px] m-0" style={{ color: "var(--text-muted)" }} aria-busy="true">
              Loading the templates…
            </p>
          ) : (
            <>
              {templates.map((t) => {
                const known = TEMPLATE_LABELS[t];
                return (
                  <label
                    key={t}
                    className="flex items-start gap-2 rounded px-3 py-2 text-[13px] cursor-pointer"
                    style={{
                      border: "1px solid var(--border)",
                      background: template === t ? "var(--brand-subtle)" : "transparent",
                    }}
                  >
                    <input
                      type="radio"
                      name="template"
                      value={t}
                      checked={template === t}
                      onChange={() => setTemplate(t)}
                      className="mt-0.5"
                      data-testid={`template-${t}`}
                    />
                    <span className="flex flex-col gap-0.5 min-w-0">
                      <span className="font-medium">{known?.label ?? t}</span>
                      <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                        {known?.blurb ?? "A template on this box."}
                      </span>
                    </span>
                  </label>
                );
              })}
              <label
                className="flex items-start gap-2 rounded px-3 py-2 text-[13px] cursor-pointer"
                style={{ border: "1px solid var(--border)", background: template === "" ? "var(--brand-subtle)" : "transparent" }}
              >
                <input type="radio" name="template" value="" checked={template === ""} onChange={() => setTemplate("")} className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">An empty workspace</span>
                  <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                    No files to start from; the run lays everything down.
                  </span>
                </span>
              </label>
            </>
          )}
        </fieldset>

        {error && (
          <p role="status" className="text-[13px] m-0" title={error}>
            {CALM_ERROR}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim() || templates === null}>
            <Hammer size={14} aria-hidden /> Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}
