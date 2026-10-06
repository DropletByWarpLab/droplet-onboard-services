"use client";

// Escalate a ticket to engineering: one new work item in a project, linked to
// the ticket. Only the title chosen here leaves the desk — never the
// conversation — and the dialog says so before the agent presses the button.

import { useId, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { useProjects } from "@/components/projects/usePm";
import { ErrorStrip, Field, ModalFooter } from "./form-bits";
import { supportActions } from "./useSupport";
import type { Ticket } from "./types";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

export function EscalateDialog({
  ticket,
  onClose,
  onDone,
}: {
  ticket: Ticket;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const titleId = useId();
  const { toast } = useToast();
  const { projects, error: projectsError, isLoading } = useProjects(false);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState(ticket.subject);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No Projects grant answers the box's own 404 on this read — say what to do.
  const noAccess = !!projectsError && !projects;
  const choices = projects ?? [];

  const submit = async () => {
    if (busy || !projectId || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await supportActions().escalate(ticket.id, { projectId, title: title.trim() });
      toast(`Escalated as ${res.workItem.key}`, "success");
      onDone();
      onClose();
    } catch (e) {
      setError(translateError(e, "support"));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 600 }}>
          Escalate to a project
        </h2>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--text-3)" }}>
          This creates a work item linked to {ticket.key}. Only the title below is shared with the project — not the
          conversation or the customer.
        </p>
        <ErrorStrip message={error} />
        {noAccess ? (
          <p role="status" style={{ fontSize: 13, color: "var(--text-2)" }}>
            Escalating needs access to Projects. Ask an owner or admin.
          </p>
        ) : (
          <>
            <Field label="Project" htmlFor="esc-project">
              <ThemedSelect id="esc-project" className="pm-input" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={isLoading}>
                <option value="">{isLoading ? "Loading projects…" : choices.length ? "Choose a project" : "No projects yet"}</option>
                {choices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.identifier})
                  </option>
                ))}
              </ThemedSelect>
            </Field>
            <Field label="Title" htmlFor="esc-title">
              <input id="esc-title" className="pm-input" value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </>
        )}
        <ModalFooter
          onClose={onClose}
          onSubmit={() => void submit()}
          submitLabel="Escalate"
          busy={busy}
          disabled={noAccess || !projectId || !title.trim()}
        />
      </div>
    </Dialog>
  );
}
