"use client";

// File a ticket by hand: for yourself, or on behalf of a customer who called or
// walked in. The canonical Dialog, laid out like the new-item modal.

import { useId, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { ErrorStrip, Field, ModalFooter } from "./form-bits";
import { RequesterPicker } from "./RequesterPicker";
import { PRIORITY_CHOICES, textToHtml } from "./support-config";
import { supportActions } from "./useSupport";
import type { ContactCandidate, Desk, SupportPerson, Ticket, TicketPriority } from "./types";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

export function NewTicketModal({
  desks,
  defaultDeskId,
  agents,
  onClose,
  onCreated,
}: {
  desks: Desk[];
  defaultDeskId: string | null;
  agents: SupportPerson[];
  onClose: () => void;
  onCreated: (ticket: Ticket) => void;
}): JSX.Element {
  const titleId = useId();
  const { toast } = useToast();
  const [deskId, setDeskId] = useState(defaultDeskId ?? desks[0]?.id ?? "");
  const [forWhom, setForWhom] = useState<"me" | "customer">("me");
  const [contact, setContact] = useState<ContactCandidate | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [channel, setChannel] = useState<"INTERNAL" | "PHONE">("INTERNAL");
  const [priority, setPriority] = useState<TicketPriority>("none");
  const [assignee, setAssignee] = useState("");
  const [typeId, setTypeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subjectError, setSubjectError] = useState<string | null>(null);

  const desk = desks.find((d) => d.id === deskId);
  const types = desk?.labels.filter((l) => l.isType) ?? [];
  const needsCustomer = forWhom === "customer" && !contact;

  const submit = async () => {
    if (busy) return;
    if (!subject.trim()) {
      setSubjectError("Add a subject.");
      return;
    }
    if (needsCustomer || !desk) return;
    setBusy(true);
    setError(null);
    try {
      const { ticket } = await supportActions().createTicket({
        deskId: desk.id,
        subject: subject.trim(),
        ...(body.trim() ? { descriptionHtml: textToHtml(body) } : {}),
        requester: forWhom === "customer" && contact ? { kind: "CONTACT", contactId: contact.id } : { kind: "USER" },
        channel,
        priority,
        ...(assignee ? { assigneeIds: [assignee] } : {}),
        ...(typeId ? { labelIds: [typeId] } : {}),
      });
      toast(`Ticket ${ticket.key} created`, "success");
      onCreated(ticket);
      onClose();
    } catch (e) {
      setError(translateError(e, "support"));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} placement="center" maxWidth="md" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body">
        <h2 id={titleId} style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>
          New ticket
        </h2>
        <ErrorStrip message={error} />
        {desks.length > 1 && (
          <Field label="Desk" htmlFor="nt-desk">
            <ThemedSelect id="nt-desk" className="pm-input" value={deskId} onChange={(e) => { setDeskId(e.target.value); setTypeId(""); }}>
              {desks.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </ThemedSelect>
          </Field>
        )}
        <Field label="Who is it for?">
          <div className="pm-pills" role="radiogroup" aria-label="Who is it for?">
            {(["me", "customer"] as const).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={forWhom === v} className={forWhom === v ? "on" : ""} onClick={() => setForWhom(v)}>
                {v === "me" ? "Me" : "A customer"}
              </button>
            ))}
          </div>
        </Field>
        {forWhom === "customer" && (
          <Field label="Customer">
            <RequesterPicker value={contact} onChange={setContact} />
          </Field>
        )}
        <Field label="Subject" htmlFor="nt-subject" error={subjectError}>
          <input
            id="nt-subject"
            className="pm-input"
            placeholder="Add a subject"
            maxLength={500}
            value={subject}
            onChange={(e) => { setSubject(e.target.value); setSubjectError(null); }}
            autoFocus
          />
        </Field>
        <Field label="Details" htmlFor="nt-body">
          <textarea id="nt-body" className="pm-input" rows={4} placeholder="What do they need?" value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="pm-row" style={{ gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 140px" }}>
            <Field label="How did it arrive?" htmlFor="nt-channel">
              <ThemedSelect id="nt-channel" className="pm-input" value={channel} onChange={(e) => setChannel(e.target.value as "INTERNAL" | "PHONE")}>
                <option value="INTERNAL">Added by the team</option>
                <option value="PHONE">Phone call</option>
              </ThemedSelect>
            </Field>
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <Field label="Priority" htmlFor="nt-priority">
              <ThemedSelect id="nt-priority" className="pm-input" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
                {PRIORITY_CHOICES.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </ThemedSelect>
            </Field>
          </div>
        </div>
        <div className="pm-row" style={{ gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 140px" }}>
            <Field label="Assignee" htmlFor="nt-assignee">
              <ThemedSelect id="nt-assignee" className="pm-input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Unassigned</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.displayName}</option>
                ))}
              </ThemedSelect>
            </Field>
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <Field label="Type" htmlFor="nt-type">
              <ThemedSelect id="nt-type" className="pm-input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                <option value="">No type</option>
                {types.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </ThemedSelect>
            </Field>
          </div>
        </div>
        <ModalFooter
          onClose={onClose}
          onSubmit={() => void submit()}
          submitLabel="Create ticket"
          busy={busy}
          disabled={needsCustomer || !desk}
        />
      </div>
    </Dialog>
  );
}
