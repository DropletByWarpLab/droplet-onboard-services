"use client";

// One ticket, in full: header, the properties an agent changes, the customer,
// linked engineering work, the conversation and the composer.

import { useMemo, useState, type JSX } from "react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "@/components/projects/icons";
import { EmptyBlock, LabelTag, PriorityFlag, Skel, StatePill } from "@/components/projects/bits";
import { useDepartments } from "@/components/projects/usePm";
import { Composer } from "./Composer";
import { MacroPicker } from "./MacroPicker";
import { Conversation } from "./Conversation";
import { EscalateDialog } from "./EscalateDialog";
import { RequesterCard } from "./RequesterCard";
import { SlaBadge } from "./TicketList";
import { CHANNEL_LABELS, PRIORITY_CHOICES, toPmState } from "./support-config";
import { SupportRequestError, supportActions, useConversation, useRevalidateSupport, useTicket } from "./useSupport";
import { canWrite, type Desk, type SupportPerson, type TicketPriority, type UpdateTicketInput } from "./types";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

export interface TicketWorkspaceProps {
  /** A work item id or a key like SUP-12 — straight from `?t=`. */
  ticketRef: string;
  desks: Desk[];
  agents: SupportPerson[];
  /** Clears `?t=`. */
  onClose: () => void;
  onSelectTicket: (ref: string) => void;
  /** Called after any change so the page can revalidate its list and counts. */
  onChanged: () => void;
}

function Prop({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="pm-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

export function TicketWorkspace({
  ticketRef,
  desks,
  agents,
  onClose,
  onSelectTicket,
  onChanged,
}: TicketWorkspaceProps): JSX.Element {
  const { user } = useAuth();
  const writable = canWrite(user?.role);
  const { toast } = useToast();
  const { ticket, error, isLoading, mutate: mutateTicket } = useTicket(ticketRef);
  const convo = useConversation(ticket?.id ?? null);
  const { departments } = useDepartments();
  const revalidate = useRevalidateSupport();
  const [saving, setSaving] = useState(false);
  const [escalating, setEscalating] = useState(false);
  const [macroDraft, setMacroDraft] = useState<{ id: number; text: string } | null>(null);

  const desk = desks.find((d) => d.id === ticket?.deskId);
  const types = useMemo(() => desk?.labels.filter((l) => l.isType) ?? [], [desk]);
  const assignable = useMemo(() => {
    // The current assignee stays selectable even if they have since lost the
    // grant, so the control never shows "Unassigned" for an assigned ticket.
    const list = [...agents];
    for (const a of ticket?.assignees ?? []) if (!list.some((p) => p.id === a.id)) list.push(a);
    return list;
  }, [agents, ticket]);

  const back = (
    <button className="pm-btn ghost sm" type="button" onClick={onClose} style={{ alignSelf: "flex-start" }}>
      <PmIcon name="chevL" size={14} /> Back to tickets
    </button>
  );

  if (isLoading && !ticket) {
    return (
      <div className="sp-ws" aria-busy="true" aria-label="Loading the ticket">
        {back}
        <div className="pm-surface sp-ws-h">
          <Skel w="30%" h={11} />
          <Skel w="70%" h={20} />
        </div>
      </div>
    );
  }
  if (!ticket) {
    const gone = error instanceof SupportRequestError && error.status === 404;
    return (
      <div className="sp-ws">
        {back}
        <div className="pm-surface">
          <EmptyBlock
            icon="inbox"
            tone={gone ? undefined : "error"}
            heading={gone ? "That ticket isn't available." : "Couldn't load this ticket."}
            body={gone ? "It may have been removed, or it isn't part of your access." : "Check the appliance connection and try again."}
            cta={gone ? undefined : <button className="pm-btn ghost" type="button" onClick={() => void mutateTicket()}>Try again</button>}
          />
        </div>
      </div>
    );
  }

  const refresh = async () => {
    await Promise.all([mutateTicket(), convo.mutate()]);
    void revalidate();
    onChanged();
  };

  const save = async (patch: UpdateTicketInput) => {
    if (saving) return;
    setSaving(true);
    try {
      await supportActions().updateTicket(ticket.id, patch);
      await refresh();
    } catch (e) {
      toast(translateError(e, "support"), "error");
      // A stale ticket is the usual cause of a refusal: show the truth again.
      void mutateTicket();
    } finally {
      setSaving(false);
    }
  };

  const currentType = ticket.labels.find((l) => l.isType)?.id ?? "";
  const otherLabels = ticket.labels.filter((l) => !l.isType).map((l) => l.id);
  const ownDepartment = ticket.department?.source === "item" ? ticket.department.id : "";
  const choosable = (departments ?? []).filter((d) => d.kind !== "HOUSEHOLD");
  const disabled = !writable || saving;

  return (
    <div className="sp-ws" aria-label={`Ticket ${ticket.key}`}>
      {back}
      <header className="pm-surface sp-ws-h">
        <div className="pm-row" style={{ gap: 8, flexWrap: "wrap", fontSize: 12.5, color: "var(--text-3)" }}>
          <span className="pm-mono">{ticket.key}</span>
          <span>{ticket.deskName}</span>
          <span>· {CHANNEL_LABELS[ticket.channel]}</span>
          <span>· opened {new Date(ticket.createdAt).toLocaleDateString()}</span>
          {ticket.reopenCount > 0 && <span>· reopened {ticket.reopenCount}×</span>}
        </div>
        <h2>{ticket.subject}</h2>
        <div className="pm-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <StatePill state={toPmState(ticket.status, ticket.deskId)} />
          <PriorityFlag p={ticket.priority} withLabel />
          <SlaBadge status={ticket.slaStatus} />
          {ticket.sla && <span className="sp-hint" aria-label="SLA clock">
            {ticket.sla.paused ? "Clock paused" : ticket.sla.remainingBusinessMins === null ? "No active clock" : `${Math.ceil(ticket.sla.remainingBusinessMins)} business minutes remaining`}
          </span>}
        </div>
        {ticket.sla && <dl className="sp-kv" aria-label="Service level deadlines">{([
          ["First response", ticket.sla.firstResponseDueAt], ["Next response", ticket.sla.nextResponseDueAt], ["Resolution", ticket.sla.resolutionDueAt],
        ] as const).filter(([, date]) => date).map(([label, date]) => <div key={label}><dt>{label}</dt><dd><time dateTime={date!}>{new Date(date!).toLocaleString()}</time></dd></div>)}</dl>}
      </header>

      <div className="pm-surface sp-card" aria-label="Ticket details">
        <div className="sp-props">
          <Prop label="Status" htmlFor="tw-status">
            <ThemedSelect id="tw-status" className="pm-input" value={ticket.status.id} disabled={disabled} onChange={(e) => void save({ stateId: e.target.value })}>
              {(desk?.states ?? [ticket.status]).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </ThemedSelect>
          </Prop>
          <Prop label="Priority" htmlFor="tw-priority">
            <ThemedSelect id="tw-priority" className="pm-input" value={ticket.priority} disabled={disabled} onChange={(e) => void save({ priority: e.target.value as TicketPriority })}>
              {PRIORITY_CHOICES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </ThemedSelect>
          </Prop>
          <Prop label="Assignee" htmlFor="tw-assignee">
            <ThemedSelect id="tw-assignee" className="pm-input" value={ticket.assignees[0]?.id ?? ""} disabled={disabled} onChange={(e) => void save({ assigneeIds: e.target.value ? [e.target.value] : [] })}>
              <option value="">Unassigned</option>
              {assignable.map((a) => (
                <option key={a.id} value={a.id}>{a.displayName}</option>
              ))}
            </ThemedSelect>
          </Prop>
          <Prop label="Type" htmlFor="tw-type">
            <ThemedSelect id="tw-type" className="pm-input" value={currentType} disabled={disabled} onChange={(e) => void save({ labelIds: [...otherLabels, ...(e.target.value ? [e.target.value] : [])] })}>
              <option value="">No type</option>
              {types.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </ThemedSelect>
          </Prop>
          {choosable.length > 0 && (
            <Prop label="Department" htmlFor="tw-dept">
              <ThemedSelect id="tw-dept" className="pm-input" value={ownDepartment} disabled={disabled} onChange={(e) => void save({ departmentId: e.target.value || null })}>
                <option value="">{ticket.department && ticket.department.source === "project" ? `Desk's department (${ticket.department.name})` : "No department"}</option>
                {choosable.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </ThemedSelect>
            </Prop>
          )}
        </div>
        {ticket.labels.some((l) => !l.isType) && (
          <div className="pm-row" style={{ gap: 6, flexWrap: "wrap" }} aria-label="Labels">
            {ticket.labels.filter((l) => !l.isType).map((l) => (
              <LabelTag key={l.id} label={{ ...l, projectId: ticket.deskId }} />
            ))}
          </div>
        )}
        {!writable && <p className="sp-hint" style={{ margin: 0 }}>You can read this ticket but not change it.</p>}
      </div>

      <div className="sp-ws-body">
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          {ticket.descriptionHtml && (
            <section className="pm-surface sp-card" aria-label="The request">
              <h3>The request</h3>
              {/* nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- ticket create/update call cleanHtml, which enforces the strict sanitizePmHtml allowlist before persistence; ticket-html.test.ts exercises that boundary. */}
              <div className="pm-prose" dangerouslySetInnerHTML={{ __html: ticket.descriptionHtml }} />
            </section>
          )}
          <Conversation
            entries={convo.conversation?.entries}
            truncated={convo.conversation?.truncated ?? false}
            loading={convo.isLoading}
            error={!!convo.error}
            onRetry={() => void convo.mutate()}
            onRetryDelivery={(commentId) => {
              void supportActions().retryReply(ticket.id, commentId).then(() => convo.mutate());
            }}
          />
          {writable && desk && <MacroPicker ticket={ticket} desk={desk} agents={agents} onApplied={(text) => { setMacroDraft({ id: Date.now(), text }); void refresh(); }} />}
          {writable && <Composer ticket={ticket} desk={desk} onSent={() => void refresh()} macroDraft={macroDraft} onDraftUsed={() => setMacroDraft(null)} />}
        </div>
        <aside className="sp-side" aria-label="About this ticket">
          <RequesterCard ticket={ticket} onSelectTicket={onSelectTicket} />
          <section className="pm-surface sp-card" aria-label="Linked work">
            <h3>Linked work</h3>
            {ticket.linkedItems.length === 0 ? (
              <p className="sp-hint" style={{ margin: 0 }}>Nothing linked yet.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {ticket.linkedItems.map((l) => (
                  <li key={l.relationId} className="sp-kv">
                    {l.restricted ? (
                      <span>Linked item (no access)</span>
                    ) : (
                      <>
                        <span><span className="pm-mono">{l.key}</span> {l.name}</span>
                        <span>{[l.projectName, l.state?.name].filter(Boolean).join(" · ")}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {writable && (
              <button className="pm-btn sm" type="button" onClick={() => setEscalating(true)}>
                <PmIcon name="branch" size={13} /> Escalate to a project
              </button>
            )}
          </section>
        </aside>
      </div>

      {escalating && <EscalateDialog ticket={ticket} onClose={() => setEscalating(false)} onDone={() => void refresh()} />}
    </div>
  );
}
