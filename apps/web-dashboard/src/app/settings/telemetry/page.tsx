/**
 * WARP-3504 (ADR-068) — /settings/telemetry: "What this Droplet sends to Warp".
 *
 * Every enrolled Droplet sends Warp operational data (health, events, masked
 * warnings and errors) and no customer data. This page is the owner's proof:
 * it says in plain words what is sent and what never is, how long Warp keeps
 * it and why, whether sending is working, and shows the LAST payload of each
 * kind exactly as it left, next to the description of its fields.
 *
 * Owner and admin only. The gate here only decides what to render; the
 * boundary is `requireRole("owner", "admin")` on GET /api/telemetry/last, so a
 * person who edits their way past it gets a 403, not data.
 *
 * There is deliberately NO switch on this page: telemetry is part of the
 * managed lease and always on for an enrolled Droplet.
 *
 * Copy honesty (the recurring "fallback copy masks outages" defect class): a
 * failed load says so in red and shows no cards, and "nothing sent yet" is its
 * own state, never a blank that could read as "all fine".
 */
"use client";

import { AlertTriangle, RefreshCw, Radio, ShieldOff } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Sect, type BadgeKind } from "@/components/shell/primitives";
import { CodeBlock } from "@/components/CodeBlock";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/access";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  useTelemetryLast,
  type TelemetryKind,
  type TelemetryLast,
  type TelemetryLinkState,
} from "@/lib/hooks/useTelemetryLast";

const MUTED = { fontSize: 13, lineHeight: "18px", color: "var(--text-muted)" } as const;
const WRAP = { whiteSpace: "normal", wordBreak: "break-word" } as const;
const SUMMARY = "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]";
const TITLE = "What this Droplet sends to Warp";
const ICON = <Radio size={15} />;

/** The three kinds, in the order the owner reads them, with their plain names. */
const KINDS: ReadonlyArray<{ kind: TelemetryKind; schema: string; name: string }> = [
  { kind: "heartbeat", schema: "heartbeat.v1", name: "Health snapshot" },
  { kind: "events", schema: "events.v1", name: "Events" },
  { kind: "logs", schema: "logs.v1", name: "Warnings and errors" },
];

const STATE: Record<TelemetryLinkState, { kind: BadgeKind; label: string; text: string }> = {
  ok: {
    kind: "ok",
    label: "Sending",
    text: "This Droplet is reporting to Warp as described below.",
  },
  starting: {
    kind: "info",
    label: "Starting",
    text: "Waiting for the first report to go out.",
  },
  retrying: {
    kind: "warn",
    label: "Can't reach Warp right now",
    text: "Reports are held on this Droplet and sent as soon as the connection is back. Nothing is lost while it waits, except the oldest reports if the wait is very long.",
  },
  not_enrolled: {
    kind: "muted",
    label: "Not connected to Warp",
    text: "This Droplet isn't registered with Warp yet, so nothing is sent.",
  },
  revoked: {
    kind: "danger",
    label: "Warp access ended",
    text: "Warp has ended this Droplet's access, so nothing is sent.",
  },
  disabled: {
    kind: "muted",
    label: "Off on this Droplet",
    text: "Nothing is sent from this Droplet.",
  },
  unconfigured: {
    kind: "muted",
    label: "No Warp connection set up",
    text: "This Droplet has no connection to Warp configured, so nothing is sent.",
  },
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function TelemetryPage() {
  const { user, isLoading: authLoading } = useAuth();
  const isAdmin = !authLoading && isAdminRole(user?.role);
  const { last, error, isLoading, mutate } = useTelemetryLast(!isAdmin);

  if (authLoading) {
    return (
      <ShellPage icon={ICON} label="What we send" title={TITLE}>
        <div className="card" aria-busy="true" style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>
          Loading…
        </div>
      </ShellPage>
    );
  }

  if (!isAdmin) {
    return (
      <ShellPage icon={ICON} label="What we send" title={TITLE}>
        <div className="card" style={{ padding: 0, maxWidth: 880 }}>
          <div className="empty">
            <span className="ei">
              <ShieldOff size={24} />
            </span>
            <span className="eh">Owner or admin access required</span>
            <span>
              What this Droplet reports to Warp is shown to the <code>owner</code> and <code>admin</code> of the
              business. Ask them if you want to see it.
            </span>
          </div>
        </div>
      </ShellPage>
    );
  }

  return (
    <ShellPage
      icon={ICON}
      label="What we send"
      title={TITLE}
      sub="Your Droplet reports its own health to Warp so problems are caught early. This page shows exactly what leaves, and what never does."
    >
      <div style={{ maxWidth: 880 }}>
        {error && !last && (
          <div role="alert" className="card border border-system-red/40 bg-system-red/5" style={{ padding: 16, marginBottom: 16 }}>
            <p className="text-system-red flex items-center gap-2" style={{ fontSize: 15 }}>
              <AlertTriangle size={16} /> Couldn&rsquo;t load this page
            </p>
            <p className="mt-1" style={MUTED}>
              The Droplet didn&rsquo;t answer. This is a connection problem, not a report that nothing is being sent.
            </p>
            <button onClick={() => void mutate()} className="btn ghost sm" style={{ marginTop: 10 }} type="button">
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        )}

        {isLoading && !last && !error && (
          <p className="px-1" style={MUTED}>
            Loading…
          </p>
        )}

        {last && (
          <>
            <Status last={last} />
            <Summary last={last} />
            <LastSent last={last} />
            <p style={{ ...MUTED, marginTop: 8 }}>
              Sending is part of your Droplet lease. There is no switch for it here, and nothing on this page can
              change what is sent.
            </p>
          </>
        )}
      </div>
    </ShellPage>
  );
}

function Status({ last }: { last: TelemetryLast }) {
  const s = STATE[last.state];
  const every = Math.round(last.heartbeatIntervalSec / 60);
  const waiting = last.queued.heartbeat + last.queued.events + last.queued.logs;
  return (
    <>
      <Sect title="Status" />
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div className="rows">
          <div className="lrow" style={{ padding: "12px 16px" }}>
            <span className="rt">
              <span className="nm">
                <Badge kind={s.kind}>{s.label}</Badge>
              </span>
              <span className="sub" style={WRAP}>
                {s.text}
              </span>
              {last.state !== "disabled" && last.state !== "unconfigured" && (
                <span className="sub" style={WRAP}>
                  {last.portalHost ? `Reports go to ${last.portalHost}. ` : ""}
                  A health snapshot is sent every {every} minutes; events and warnings go within a minute.
                </span>
              )}
              {last.lastSuccessAt && (
                <span className="sub" style={WRAP} title={fmtDateTime(last.lastSuccessAt)}>
                  Last report accepted {formatRelativeTime(last.lastSuccessAt)}.
                </span>
              )}
              {waiting > 0 && (
                <span className="sub" style={WRAP}>
                  {waiting} {waiting === 1 ? "report is" : "reports are"} waiting to be sent.
                </span>
              )}
              {last.dropped > 0 && (
                <span className="sub" style={WRAP}>
                  {last.dropped} older {last.dropped === 1 ? "report was" : "reports were"} dropped while Warp could
                  not be reached.
                </span>
              )}
              {last.lastErrorCode && (
                <span className="sub mono" style={WRAP}>
                  Reason: {last.lastErrorCode}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

function Summary({ last }: { last: TelemetryLast }) {
  return (
    <>
      <Sect title="What is sent" />
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div className="rows">
          {KINDS.map(({ schema, name }) => {
            const doc = last.schemas.find((d) => d.schema === schema);
            if (!doc) return null;
            return (
              <div key={schema} className="lrow" style={{ padding: "12px 16px" }}>
                <span className="rt">
                  <span className="nm">{name}</span>
                  <span className="sub" style={WRAP}>
                    {doc.summary}
                  </span>
                  <details style={{ marginTop: 6 }}>
                    <summary className={SUMMARY} style={MUTED}>Every field in the {name.toLowerCase()}</summary>
                    <dl style={{ margin: "8px 0 0", display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: "6px 16px" }}>
                      {doc.fields.map((f) => (
                        <div key={f.path} style={{ display: "contents" }}>
                          <dt className="mono" style={{ fontSize: 12, ...WRAP }}>
                            {f.path}
                          </dt>
                          <dd style={{ margin: 0, ...MUTED, ...WRAP }}>{f.meaning}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <Sect title="What is never sent" />
      <div className="card" style={{ padding: "12px 16px", marginBottom: 16 }}>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 14, lineHeight: "20px" }}>
          {last.neverSent.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p style={{ ...MUTED, marginTop: 10 }}>
          Anything that could carry one of these is masked or left out on this Droplet before it is sent: email
          addresses, network addresses, hardware addresses, file paths, web addresses and long tokens never appear in
          the messages. Warp masks them again when it receives them.
        </p>
      </div>

      <Sect title="How long Warp keeps it, and why" />
      <div className="card" style={{ padding: "12px 16px", marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: 14, lineHeight: "20px" }}>
          Warp keeps the reports themselves for {last.retention.rawDays} days, and a daily summary per Droplet for{" "}
          {last.retention.dailySummaryMonths} months.
        </p>
        <p style={{ ...MUTED, marginTop: 8 }}>
          It exists to know that your Droplet is up, to catch a failing service or a full disk before you notice,
          to plan and check software updates, and to help you faster when you call for support. It is not used to
          look at what your business does.
        </p>
        <p style={{ ...MUTED, marginTop: 8 }}>
          Once a day this Droplet also adds a line to your audit log saying how much it sent.
        </p>
      </div>
    </>
  );
}

function LastSent({ last }: { last: TelemetryLast }) {
  return (
    <>
      <Sect title="The last thing sent" />
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div className="rows">
          {KINDS.map(({ kind, name }) => {
            const sent = last.last[kind];
            return (
              <div key={kind} className="lrow" style={{ padding: "12px 16px", alignItems: "flex-start" }}>
                <span className="rt" style={{ minWidth: 0 }}>
                  <span className="nm">{name}</span>
                  {sent ? (
                    <details>
                      <summary className={SUMMARY} style={MUTED} title={fmtDateTime(sent.sentAt)}>
                        Sent {formatRelativeTime(sent.sentAt)}. Show exactly what was sent
                      </summary>
                      <div className="mt-2">
                        <CodeBlock
                          tabIndex={0}
                          aria-label={`${name}, as sent`}
                          className="font-mono"
                          style={{
                            fontSize: 12,
                            lineHeight: "18px",
                            padding: 12,
                            borderRadius: 8,
                            background: "var(--inset)",
                            color: "var(--text)",
                            maxHeight: 360,
                            overflow: "auto",
                          }}
                        >
                          <code>{JSON.stringify(sent.payload, null, 2)}</code>
                        </CodeBlock>
                      </div>
                    </details>
                  ) : (
                    <span className="sub" style={WRAP}>
                      Nothing of this kind has been accepted by Warp yet.
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
