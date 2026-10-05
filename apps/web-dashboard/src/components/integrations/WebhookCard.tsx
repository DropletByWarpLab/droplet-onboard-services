"use client";

/**
 * WARP-3532 — one webhook: what it is, whether it is working, and the things an
 * owner or admin does to it (send a test, pause, edit, rotate its secret, delete,
 * read its delivery log, re-deliver).
 *
 * The page never shows the part of the address that is the credential, and it
 * never has the signing secret except in the moment the box hands it over — that
 * moment belongs to the section above (`onSecret`), not to this card.
 *
 * Destructive actions confirm inline, in the card, with the consequence stated:
 * deleting takes the delivery log with it; rotating stops the old secret working
 * at once, so the receiver has to be updated.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, Loader2, Pause, Pencil, Play, RefreshCw, RotateCcw, Send, Trash2 } from "lucide-react";
import { Badge } from "@/components/shell/primitives";
import {
  deleteWorkWebhook,
  fetchWorkWebhookDeliveries,
  redeliverWorkWebhook,
  rotateWorkWebhookSecret,
  testWorkWebhook,
  updateWorkWebhook,
  type WorkWebhook,
  type WorkWebhookDelivery,
} from "@/lib/api.work-webhooks";
import {
  DELIVERY_STATUS_COPY,
  EGRESS_BLOCKED_ERROR,
  EGRESS_BLOCKED_HINT,
  FORMAT_OPTIONS,
  WEBHOOK_STATUS_COPY,
} from "./work-notifications-copy";

const when = (iso: string): string => new Date(iso).toLocaleString();

function deliveryDetail(d: WorkWebhookDelivery): string {
  if (d.status === "DELIVERED") return d.lastStatusCode ? `Answered ${d.lastStatusCode}` : "Delivered";
  const why = d.lastError ?? (d.status === "PENDING" ? "Not sent yet" : "");
  return d.lastStatusCode && !why.includes(String(d.lastStatusCode)) ? `${why} (${d.lastStatusCode})` : why;
}

/** One sentence for the result of "Send test". */
export function testResultLine(d: WorkWebhookDelivery): string {
  if (d.status === "DELIVERED") {
    return `Delivered. The receiver answered ${d.lastStatusCode ?? "OK"}.`;
  }
  return `Didn’t arrive: ${deliveryDetail(d) || "no answer"}.`;
}

// ── delivery log ─────────────────────────────────────────────────────────────

function DeliveryLog({ webhookId, eventLabels }: { webhookId: string; eventLabels: ReadonlyMap<string, string> }) {
  const [rows, setRows] = useState<WorkWebhookDelivery[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string | null) => {
      setError(null);
      try {
        const page = await fetchWorkWebhookDeliveries(webhookId, cursor);
        setRows((cur) => (cursor && cur ? [...cur, ...page.deliveries] : page.deliveries));
        setNext(page.nextCursor);
      } catch {
        setError("Couldn’t load the delivery log.");
        setRows((cur) => cur ?? []);
      }
    },
    [webhookId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function redeliver(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await redeliverWorkWebhook(webhookId, id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t queue that again.");
    } finally {
      setBusyId(null);
    }
  }

  if (rows === null) {
    return (
      <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
        Loading the delivery log…
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid={`log-${webhookId}`}>
      <div className="flex items-center justify-between">
        <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          Delivery log
        </p>
        <button type="button" className="btn" onClick={() => void load()} aria-label="Refresh the delivery log">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {error && (
        <p className="type-footnote text-system-red" role="alert">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
          Nothing has been sent yet. Work updates appear here a few seconds after they happen.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((d) => {
            const status = DELIVERY_STATUS_COPY[d.status];
            const blocked = d.lastError === EGRESS_BLOCKED_ERROR;
            return (
              <li
                key={d.id}
                className="flex flex-wrap items-start justify-between gap-2 pt-2"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                <div className="min-w-0">
                  <p className="type-footnote" style={{ color: "var(--text)" }}>
                    {eventLabels.get(d.event) ?? (d.event === "webhook.test" ? "Test message" : d.event)}
                    {d.subject ? ` · ${d.subject}` : ""}
                  </p>
                  <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>
                    {when(d.createdAt)}
                    {d.attempts > 0 ? ` · ${d.attempts} ${d.attempts === 1 ? "try" : "tries"}` : ""}
                    {(d.status === "FAILED" || d.status === "PENDING") && !blocked
                      ? ` · next try ${when(d.nextAttemptAt)}`
                      : ""}
                  </p>
                  {deliveryDetail(d) && (
                    <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                      {deliveryDetail(d)}
                    </p>
                  )}
                  {blocked && (
                    <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>
                      {EGRESS_BLOCKED_HINT}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge kind={status.kind}>{status.label}</Badge>
                  <button
                    type="button"
                    className="btn"
                    disabled={busyId === d.id}
                    onClick={() => void redeliver(d.id)}
                    aria-label={`Send ${d.subject ?? d.event} again`}
                  >
                    {busyId === d.id ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                    Send again
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <button type="button" className="btn" onClick={() => void load(next)}>
          Show older
        </button>
      )}
    </div>
  );
}

// ── the card ─────────────────────────────────────────────────────────────────

type Busy = null | "test" | "pause" | "rotate" | "delete";

interface Props {
  webhook: WorkWebhook;
  eventLabels: ReadonlyMap<string, string>;
  projectName: string | null;
  onUpdated: (w: WorkWebhook) => void;
  onDeleted: (id: string) => void;
  onSecret: (w: WorkWebhook, secret: string) => void;
  onEdit: (w: WorkWebhook) => void;
  /** Re-read the list: a test or a re-delivery changes its "last delivery". */
  onRefresh: () => void;
}

export function WebhookCard({ webhook, eventLabels, projectName, onUpdated, onDeleted, onSecret, onEdit, onRefresh }: Props) {
  const [busy, setBusy] = useState<Busy>(null);
  const [confirm, setConfirm] = useState<null | "rotate" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WorkWebhookDelivery | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  const status = WEBHOOK_STATUS_COPY[webhook.status];
  const format = FORMAT_OPTIONS.find((o) => o.value === webhook.format)?.label ?? webhook.format;

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "That didn’t work. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  }

  const test = () =>
    run("test", async () => {
      setResult(null);
      const { delivery } = await testWorkWebhook(webhook.id);
      setResult(delivery);
      onRefresh();
    });

  const togglePause = () =>
    run("pause", async () => {
      const { webhook: next } = await updateWorkWebhook(webhook.id, { enabled: !webhook.enabled });
      onUpdated(next);
    });

  const rotate = () =>
    run("rotate", async () => {
      const { webhook: next, secret } = await rotateWorkWebhookSecret(webhook.id);
      setConfirm(null);
      onUpdated(next);
      onSecret(next, secret);
    });

  const remove = () =>
    run("delete", async () => {
      await deleteWorkWebhook(webhook.id);
      onDeleted(webhook.id);
    });

  return (
    <div className="card space-y-3" data-testid={`webhook-${webhook.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="type-headline" style={{ color: "var(--text)" }}>
            {webhook.name}
          </p>
          <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
            {format} · {webhook.destination || "address on file"} · {projectName ?? "Every project"}
          </p>
        </div>
        <Badge kind={status.kind}>{status.label}</Badge>
      </div>

      <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
        {webhook.events.map((e) => eventLabels.get(e) ?? e).join(", ")}
      </p>

      {webhook.status === "DISABLED_FAILING" && (
        <p className="type-footnote text-system-red" role="status">
          Droplet couldn’t reach this address {webhook.consecutiveFailures} times in a row and stopped sending. Check the
          address, send a test, then resume.
        </p>
      )}

      {webhook.lastDelivery && (
        <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>
          Last send {when(webhook.lastDelivery.at)}
          {webhook.lastDelivery.statusCode ? ` · answered ${webhook.lastDelivery.statusCode}` : ""}
        </p>
      )}

      {result && (
        <p
          className={`type-footnote flex items-center gap-1 ${result.status === "DELIVERED" ? "text-system-green" : "text-system-red"}`}
          role="status"
        >
          {result.status === "DELIVERED" ? <Check size={14} /> : <AlertCircle size={14} />}
          {testResultLine(result)}
        </p>
      )}
      {result?.lastError === EGRESS_BLOCKED_ERROR && (
        <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>
          {EGRESS_BLOCKED_HINT}
        </p>
      )}

      {error && (
        <p className="type-footnote text-system-red" role="alert">
          {error}
        </p>
      )}

      {confirm === "delete" && (
        <div className="space-y-2" role="group" aria-label={`Delete ${webhook.name}`}>
          <p className="type-footnote" style={{ color: "var(--text)" }}>
            Delete {webhook.name}? Its delivery log goes with it, and anything still waiting to send is dropped.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn" disabled={busy === "delete"} onClick={() => void remove()}>
              {busy === "delete" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Delete
            </button>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Keep it
            </button>
          </div>
        </div>
      )}
      {confirm === "rotate" && (
        <div className="space-y-2" role="group" aria-label={`Rotate the secret for ${webhook.name}`}>
          <p className="type-footnote" style={{ color: "var(--text)" }}>
            Make a new secret? The old one stops working straight away, so update the receiver with the new one.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn" disabled={busy === "rotate"} onClick={() => void rotate()}>
              {busy === "rotate" ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              Make a new secret
            </button>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Keep the old one
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void test()}>
          {busy === "test" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Send test
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void togglePause()}>
          {busy === "pause" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : webhook.enabled ? (
            <Pause size={14} />
          ) : (
            <Play size={14} />
          )}
          {webhook.enabled ? "Pause" : "Resume"}
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => onEdit(webhook)}>
          <Pencil size={14} /> Edit
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => setConfirm("rotate")}>
          <RotateCcw size={14} /> New secret
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => setConfirm("delete")}>
          <Trash2 size={14} /> Delete
        </button>
        <button
          type="button"
          className="btn"
          aria-expanded={logOpen}
          onClick={() => setLogOpen((open) => !open)}
        >
          {logOpen ? "Hide log" : "Delivery log"}
        </button>
      </div>

      {logOpen && <DeliveryLog webhookId={webhook.id} eventLabels={eventLabels} />}
    </div>
  );
}
