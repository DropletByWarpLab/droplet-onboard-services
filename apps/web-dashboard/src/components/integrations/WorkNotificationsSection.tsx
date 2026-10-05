"use client";

/**
 * WARP-3532 — Settings → Integrations → Work notifications: the owner/admin
 * surface for sending work updates out (ADR-069 §9).
 *
 * Mirrors the server's `requireRole("owner","admin")` on every `/api/pm/webhooks`
 * route. The gate precedes the fetch effects — `WorkNotificationsPanel` owns every
 * `useEffect` and is not mounted for anyone else — so a member who reaches the URL
 * gets the page chrome and issues no admin-only request on their own behalf (the
 * `SaasCredentialsSection` rule, and the reason the test asserts both "renders
 * nothing" and "fetched nothing").
 *
 * The signing secret is held in exactly one place: the `reveal` state below, for
 * as long as the "shown once" box is on screen. It is never put in a list, a log
 * line or storage, and dismissing the box drops it.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Plus } from "lucide-react";
import { Sect } from "@/components/shell/primitives";
import { useAuth } from "@/lib/auth";
import {
  createWorkWebhook,
  fetchWebhookScopeProjects,
  fetchWorkWebhooks,
  updateWorkWebhook,
  type WorkEventInfo,
  type WorkWebhook,
} from "@/lib/api.work-webhooks";
import { WebhookCard } from "./WebhookCard";
import { WebhookForm, type WebhookFormValue } from "./WebhookForm";
import { WorkIntegrationsSwitch } from "./WorkIntegrationsSwitch";
import { EMPTY_STATE, SECRET_ONCE_NOTE } from "./work-notifications-copy";

type Load = { kind: "loading" } | { kind: "ready" } | { kind: "failed" };
type FormState = null | { mode: "create" } | { mode: "edit"; webhook: WorkWebhook };

function SecretReveal({ name, secret, onDone }: { name: string; secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      // No clipboard permission: the secret is selectable in the box above.
    }
  }

  return (
    <div className="card space-y-3" role="status" aria-label={`Signing secret for ${name}`} data-testid="secret-reveal">
      <p className="type-headline" style={{ color: "var(--text)" }}>
        Signing secret for {name}
      </p>
      <input
        readOnly
        value={secret}
        aria-label="Signing secret"
        onFocus={(e) => e.currentTarget.select()}
        className="w-full px-3 py-2 type-footnote"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-input)",
          color: "var(--text)",
          fontFamily: "var(--font-mono, monospace)",
        }}
      />
      <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
        {SECRET_ONCE_NOTE}
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn" onClick={() => void copy()}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy secret"}
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          I’ve saved it
        </button>
      </div>
    </div>
  );
}

function WorkNotificationsPanel() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [webhooks, setWebhooks] = useState<WorkWebhook[]>([]);
  const [events, setEvents] = useState<WorkEventInfo[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string; identifier: string }>>([]);
  const [form, setForm] = useState<FormState>(null);
  const [reveal, setReveal] = useState<{ name: string; secret: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetchWorkWebhooks();
      setWebhooks(r.webhooks);
      setEvents(r.events);
      setLoad({ kind: "ready" });
    } catch {
      // An explicit failed state, never an empty list standing in for one: "no
      // webhooks" and "couldn't ask" must not look alike on a page whose job is
      // to say where work data is going.
      setLoad((cur) => (cur.kind === "ready" ? cur : { kind: "failed" }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The scope picker is a convenience: without it every webhook is
    // workspace-wide, which is still correct.
    fetchWebhookScopeProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [refresh]);

  /** A write returns the webhook without its latest delivery; keep what the list had. */
  const merge = (next: WorkWebhook) =>
    setWebhooks((cur) => cur.map((w) => (w.id === next.id ? { ...next, lastDelivery: w.lastDelivery } : w)));

  async function create(value: WebhookFormValue) {
    if (!value.url) throw new Error("Paste the address to send to.");
    const { webhook, secret } = await createWorkWebhook({
      name: value.name,
      url: value.url,
      format: value.format,
      events: value.events,
      projectId: value.projectId,
    });
    setWebhooks((cur) => [...cur, webhook]);
    setForm(null);
    setReveal({ name: webhook.name, secret });
  }

  async function edit(id: string, value: WebhookFormValue) {
    const { webhook } = await updateWorkWebhook(id, value);
    merge(webhook);
    setForm(null);
  }

  const eventLabels = new Map(events.map((e) => [e.name, e.label]));
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));

  return (
    <>
      <section className="mb-8">
        <Sect title="Sending outside your network" />
        <WorkIntegrationsSwitch />
      </section>

      <section className="mb-10 space-y-4" aria-busy={load.kind === "loading"}>
        <Sect title="Webhooks and chat apps" />

        {reveal && <SecretReveal name={reveal.name} secret={reveal.secret} onDone={() => setReveal(null)} />}

        {load.kind === "loading" && (
          <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
            Loading webhooks…
          </p>
        )}

        {load.kind === "failed" && (
          <div className="space-y-2">
            <p className="type-footnote text-system-red" role="alert">
              Couldn’t load your webhooks.
            </p>
            <button type="button" className="btn" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}

        {load.kind === "ready" && (
          <>
            {form?.mode === "create" ? (
              <WebhookForm
                mode="create"
                events={events}
                projects={projects}
                onSubmit={create}
                onCancel={() => setForm(null)}
              />
            ) : (
              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setReveal(null);
                    setForm({ mode: "create" });
                  }}
                >
                  <Plus size={14} /> Add a webhook
                </button>
              </div>
            )}

            {webhooks.length === 0 && form === null && (
              <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
                {EMPTY_STATE}
              </p>
            )}

            {webhooks.map((w) =>
              form?.mode === "edit" && form.webhook.id === w.id ? (
                <WebhookForm
                  key={w.id}
                  mode="edit"
                  initial={w}
                  events={events}
                  projects={projects}
                  onSubmit={(value) => edit(w.id, value)}
                  onCancel={() => setForm(null)}
                />
              ) : (
                <WebhookCard
                  key={w.id}
                  webhook={w}
                  eventLabels={eventLabels}
                  projectName={w.projectId ? (projectNames.get(w.projectId) ?? "One project") : null}
                  onUpdated={merge}
                  onDeleted={(id) => setWebhooks((cur) => cur.filter((x) => x.id !== id))}
                  onSecret={(webhook, secret) => setReveal({ name: webhook.name, secret })}
                  onEdit={(webhook) => {
                    setReveal(null);
                    setForm({ mode: "edit", webhook });
                  }}
                  onRefresh={() => void refresh()}
                />
              ),
            )}
          </>
        )}
      </section>
    </>
  );
}

export function WorkNotificationsSection() {
  const { user } = useAuth();
  const isAdmin = user?.role === "owner" || user?.role === "admin";

  // BEFORE the fetch effects — the panel owns every one of them and is not
  // mounted at all here. Mirrors the server's requireRole("owner","admin"); the
  // nav entry carries the same roles so the two cannot drift apart.
  if (!isAdmin) return null;

  return <WorkNotificationsPanel />;
}
