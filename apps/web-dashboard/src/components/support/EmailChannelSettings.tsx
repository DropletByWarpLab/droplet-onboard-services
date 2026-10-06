"use client";

import { useEffect, useMemo, useState, type JSX } from "react";
import { useAgents, supportActions, useRevalidateSupport } from "./useSupport";
import type { Desk, DeskEmailAccount, DeskEmailChannelSettings } from "./types";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

const DEFAULT_TEMPLATE = [
  "Hi {{requester.firstName}},",
  "",
  "Thanks for getting in touch. We have received your request and logged it as {{ticket.key}}.",
  "",
  "Someone from {{desk.name}} will reply as soon as they can. You can answer this email to add more detail.",
  "",
  "— {{desk.name}}",
].join("\n");

export function EmailChannelSettings({ desk }: { desk: Desk }): JSX.Element {
  const [accounts, setAccounts] = useState<DeskEmailAccount[]>([]);
  const [channel, setChannel] = useState<DeskEmailChannelSettings | null>(null);
  const [accountId, setAccountId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [autoAck, setAutoAck] = useState(false);
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [reopenDays, setReopenDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agents = useAgents().agents ?? [];
  const revalidateSupport = useRevalidateSupport();

  useEffect(() => {
    let live = true;
    const actions = supportActions();
    void Promise.all([actions.listEmailAccounts(), actions.getEmailChannel(desk.id)])
      .then(([mailboxes, settings]) => {
        if (!live) return;
        setAccounts(mailboxes.accounts);
        setChannel(settings.channel);
        setAccountId(settings.channel?.emailAccountId ?? "");
        setOwnerId(settings.channel?.contactOwnerUserId ?? "");
        setEnabled(settings.channel?.enabled ?? true);
        setAutoAck(settings.channel?.autoAckEnabled ?? false);
        setTemplate(settings.channel?.autoAckTemplate ?? DEFAULT_TEMPLATE);
        setReopenDays(settings.channel?.reopenWindowDays ?? 14);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error && err.message === "email_module_disabled"
          ? "Enable the Email module in Settings before connecting a mailbox."
          : "Couldn't load email channel settings.");
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [desk.id]);

  useEffect(() => {
    if (!ownerId && agents.length > 0) setOwnerId(agents[0]!.id);
  }, [agents, ownerId]);

  const preview = useMemo(() => template
    .replaceAll("{{requester.firstName}}", "Alex")
    .replaceAll("{{ticket.key}}", `${desk.identifier}-123`)
    .replaceAll("{{ticket.title}}", "The printer is offline")
    .replaceAll("{{desk.name}}", desk.name), [template, desk.identifier, desk.name]);

  const save = async () => {
    setBusy(true); setError("");
    try {
      const result = await supportActions().saveEmailChannel(desk.id, accountId ? {
        emailAccountId: accountId,
        contactOwnerUserId: ownerId,
        enabled,
        autoAckEnabled: autoAck,
        autoAckTemplate: template,
        reopenWindowDays: reopenDays,
      } : { emailAccountId: null, contactOwnerUserId: ownerId });
      setChannel(result.channel);
      void revalidateSupport();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save email channel settings.");
    } finally { setBusy(false); }
  };

  return <section aria-labelledby="support-email-channel-heading" style={{ borderTop: "1px solid var(--border)", marginTop: 18, paddingTop: 16 }}>
    <h3 id="support-email-channel-heading" style={{ margin: "0 0 8px", fontSize: 14 }}>Email channel</h3>
    <p className="sp-hint" style={{ margin: "0 0 10px" }}>New mailbox messages become tickets. Email is sent only when outbound_email is enabled.</p>
    {loading ? <p role="status">Loading mailbox settings…</p> : error && accounts.length === 0 ? <p role="alert">{error}</p> : <>
      <label className="pm-field"><span>Mailbox</span><ThemedSelect className="pm-input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
        <option value="">Not connected</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName} · {account.address}</option>)}
      </ThemedSelect></label>
      {accountId && <>
        <label className="pm-field"><span>Contact owner</span><ThemedSelect className="pm-input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
          <option value="">Choose an active Support agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
        </ThemedSelect></label>
        <label className="pm-row" style={{ gap: 8, margin: "10px 0" }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Accept new messages</label>
        <label className="pm-field"><span>Reopen window (days)</span><input className="pm-input" type="number" min={0} max={365} value={reopenDays} onChange={(e) => setReopenDays(Number(e.target.value))} /></label>
        <label className="pm-row" style={{ gap: 8, margin: "10px 0" }}><input type="checkbox" checked={autoAck} onChange={(e) => setAutoAck(e.target.checked)} />Send an automatic acknowledgement</label>
        {autoAck && <>
          <label className="pm-field"><span>Acknowledgement template</span><textarea className="pm-input" rows={6} maxLength={4000} value={template} onChange={(e) => setTemplate(e.target.value)} /></label>
          <div className="pm-prose" aria-label="Acknowledgement preview" style={{ whiteSpace: "pre-wrap", padding: 12, background: "var(--surface-2)" }}>{preview}</div>
        </>}
      </>}
      {error && <p role="alert">{error}</p>}
      <button className="pm-btn" type="button" disabled={busy || (accountId !== "" && !ownerId)} onClick={() => void save()}>{busy ? "Saving…" : channel ? "Save email channel" : "Connect mailbox"}</button>
    </>}
  </section>;
}
