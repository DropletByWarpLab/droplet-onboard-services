"use client";

/**
 * /admin/sessions - who is signed in, and how to cut them off (WARP-2820).
 *
 * Revocation has existed since WARP-116. Nothing in the product could tell an
 * operator whether there was anything to revoke, so the one question an IT
 * person actually asks on somebody's last day - "is that account still live?"
 * - had no answer short of reading Redis by hand.
 *
 * "COULD NOT READ" IS NOT "SIGNED OUT". A person whose sessions the box could
 * not enumerate renders as Unknown, never as zero, and is offered no Sign out
 * button. Telling an operator that a departing employee has been cut off when
 * nobody checked is the one failure this page must not have, and it is the
 * same rule the console overview tiles follow when a probe fails.
 *
 * The deadlines come from the box, not from arithmetic here: the idle and
 * absolute limits are policy the orchestrator owns, and a second copy would
 * drift the moment they become configurable.
 *
 * A REFUSAL IS NOT AN OUTAGE. The role gate below mirrors /admin/audit and
 * /admin/files: client check here, real enforcement in the orchestrator's
 * `requireRole("owner","admin")` on GET /api/auth/sessions. Without it a
 * `family` account fired the read, took the 403 the route correctly returns,
 * and landed in the generic failure branch - so "you may not see this" was
 * reported as "the box did not answer", on the one page whose whole premise
 * is that it never overstates what it knows. Both the client-side refusal and
 * a 403 off the wire now render as permissions; only a genuine failure to
 * reach the store keeps the outage copy and its retry.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { KeyRound, LogOut, ShieldOff } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Card, Row, Sect } from "@/components/shell/primitives";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/access";
import { fetchSessions, revokeUserSessions, type SessionsForUser } from "@/lib/api";
import { ago, untilPhrase } from "./format";

const ICON = <KeyRound size={15} />;
const SUB = "Everyone signed in to this box right now, and how to sign them out.";

function SessionsCard({
  person,
  now,
  onRevoked,
}: {
  person: SessionsForUser;
  now: number;
  onRevoked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const revoke = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // The identifier the list itself carried. Nothing else on this row names
      // the person to the box, and the route now resolves this exact field —
      // see WARP-2820 on revoke-sessions, where trying only the Nextcloud
      // mapping key silently 404'd every SSO-provisioned account.
      await revokeUserSessions(person.username);
      setConfirming(false);
      onRevoked();
    } catch {
      setError("Could not sign this person out. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }, [person.username, onRevoked]);

  const unknown = person.sessions === null;
  const sessions = person.sessions ?? [];
  const count = sessions.length;
  const name = person.displayName || person.username;

  const badge = unknown ? (
    <Badge kind="muted">Unknown</Badge>
  ) : count === 0 ? (
    <Badge kind="muted">Signed out</Badge>
  ) : (
    <Badge kind="ok">
      {count} {count === 1 ? "session" : "sessions"}
    </Badge>
  );

  return (
    <Card title={name} meta={person.role} icon={<LogOut size={15} />}>
      <div className="rows">
        <Row title={person.username} subMono sub="Sign-in name" right={badge} />

        {unknown ? (
          <Row
            title="Could not read this person's sessions"
            sub="The session store did not answer. That is not the same as being signed out - try again before acting on it."
          />
        ) : count === 0 ? (
          <Row title="No live sessions" sub="Nothing to sign out." />
        ) : (
          sessions.map((s, i) => (
            <Row
              key={`${s.createdAt}-${i}`}
              title={`Signed in ${ago(s.createdAt, now)}`}
              sub={`Last active ${ago(s.lastSeenAt, now)}`}
              meta={`${untilPhrase(s.idleDeadline, now)} if idle, ${untilPhrase(
                s.absoluteDeadline,
                now,
              )} regardless`}
            />
          ))
        )}

        {error ? <Row icon={<ShieldOff size={15} />} title={error} /> : null}

        {/* Offered only where there is something to revoke AND the box could
            actually see it. On Unknown, a Sign out button would let an
            operator believe an outage-blind action had taken effect. */}
        {!unknown && count > 0 ? (
          confirming ? (
            <Row
              title={`Sign ${name} out of every session?`}
              sub="They will have to sign in again. Access already granted expires within 15 minutes."
              right={
                <>
                  <button type="button" disabled={busy} onClick={() => void revoke()}>
                    {busy ? "Signing out..." : "Sign out everywhere"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </>
              }
            />
          ) : (
            <Row
              title="Sign out everywhere"
              sub="Ends every session this person has open."
              right={
                <button type="button" onClick={() => setConfirming(true)}>
                  Sign out
                </button>
              }
            />
          )
        ) : null}
      </div>
    </Card>
  );
}

/** The refusal card. One shape for both refusals - the client already knowing
 *  the role is too low, and the box saying so - because to the person reading
 *  it they are the same answer. Deliberately NOT the outage card: no retry,
 *  because retrying a permissions decision only fails again. Matches the empty
 *  state /admin/audit, /admin/files and the console gate all render. */
function NotAuthorized({ detail }: { detail: ReactNode }) {
  return (
    <div className="card">
      <div className="empty">
        <span className="ei">
          <ShieldOff size={24} />
        </span>
        <span className="eh">Admin access required</span>
        <span style={{ maxWidth: "38ch" }}>{detail}</span>
      </div>
    </div>
  );
}

export default function AdminSessionsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const isAdmin = !authLoading && isAdminRole(user?.role);

  const [people, setPeople] = useState<SessionsForUser[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Distinct from `failed` on purpose: the box refusing to answer this person
  // and the box being unable to answer at all are different sentences.
  const [refused, setRefused] = useState(false);
  const [loading, setLoading] = useState(true);
  // Captured once per load rather than read per render, so every row on one
  // screen is measured against the same instant.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(() => {
    // Nothing is asked of the box until the auth probe has settled AND the
    // answer is owner/admin. A non-admin never generates the 403 that used to
    // be mistranslated downstream.
    if (!isAdmin) return;
    setLoading(true);
    void fetchSessions()
      .then(({ users }) => {
        setPeople(users);
        setNow(Math.floor(Date.now() / 1000));
        setFailed(false);
        setRefused(false);
      })
      .catch((err: unknown) => {
        // 403 is `requireRole` answering, not Redis failing.
        if ((err as { status?: number } | null)?.status === 403) {
          setRefused(true);
          setFailed(false);
        } else {
          setFailed(true);
          setRefused(false);
        }
      })
      .finally(() => setLoading(false));
  }, [isAdmin]);

  useEffect(load, [load]);

  // A person the box could not read is NOT counted as signed out, so they sit
  // with the signed-in group where an operator will actually look at them.
  const active = (people ?? []).filter((p) => p.sessions === null || p.sessions.length > 0);
  const rest = (people ?? []).filter((p) => p.sessions !== null && p.sessions.length === 0);

  // Hydrating. Neutral chrome rather than the page, the same branch the other
  // /admin surfaces render while the auth probe is in flight.
  if (authLoading) {
    return (
      <ShellPage icon={ICON} label="Sessions" title="Sessions">
        <div
          className="card"
          aria-busy="true"
          style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}
        >
          Loading...
        </div>
      </ShellPage>
    );
  }

  // Refused - by this check, or by the box. No subtitle: the page's own
  // strapline describes a capability this person does not have.
  if (!isAdmin || refused) {
    return (
      <ShellPage icon={ICON} label="Sessions" title="Sessions">
        <NotAuthorized
          detail={
            isAdmin ? (
              // The client thought this was allowed and the box disagreed - a
              // role changed under a live token, or the route tightened. Say
              // that, rather than blaming a store that answered fine.
              <>
                The box refused this request because of your role, not because
                anything is down. Nobody has been signed out. Sign in again, or
                ask an <code>owner</code> to check your access.
              </>
            ) : (
              <>
                Sessions shows who is signed in to this box and can sign them
                out, so it is limited to <code>owner</code> and{" "}
                <code>admin</code>. Ask an admin if you need access.
              </>
            )
          }
        />
      </ShellPage>
    );
  }

  return (
    <ShellPage icon={ICON} label="Sessions" title="Sessions" sub={SUB}>
      {loading ? (
        <p>Loading...</p>
      ) : failed ? (
        <Card>
          <Row
            icon={<ShieldOff size={15} />}
            title="Could not read sessions"
            sub="The box did not answer. Nobody has been signed out, and this page is not evidence that nobody is signed in."
            right={
              <button type="button" onClick={load}>
                Try again
              </button>
            }
          />
        </Card>
      ) : (
        <>
          <Sect
            title="Signed in now"
            extra={people ? `${active.length} of ${people.length}` : undefined}
          />
          {active.length === 0 ? (
            <Card>
              <Row title="Nobody is signed in" sub="No live sessions on this box." />
            </Card>
          ) : (
            active.map((p) => (
              <SessionsCard key={p.username} person={p} now={now} onRevoked={load} />
            ))
          )}

          {rest.length > 0 ? (
            <>
              <Sect title="Everyone else" />
              {rest.map((p) => (
                <SessionsCard key={p.username} person={p} now={now} onRevoked={load} />
              ))}
            </>
          ) : null}
        </>
      )}
    </ShellPage>
  );
}
