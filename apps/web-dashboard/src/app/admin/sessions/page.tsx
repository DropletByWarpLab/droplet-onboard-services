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
 */

import { useCallback, useEffect, useState } from "react";
import { KeyRound, LogOut, ShieldOff } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Card, Row, Sect } from "@/components/shell/primitives";
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

export default function AdminSessionsPage() {
  const [people, setPeople] = useState<SessionsForUser[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  // Captured once per load rather than read per render, so every row on one
  // screen is measured against the same instant.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(() => {
    setLoading(true);
    void fetchSessions()
      .then(({ users }) => {
        setPeople(users);
        setNow(Math.floor(Date.now() / 1000));
        setFailed(false);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  // A person the box could not read is NOT counted as signed out, so they sit
  // with the signed-in group where an operator will actually look at them.
  const active = (people ?? []).filter((p) => p.sessions === null || p.sessions.length > 0);
  const rest = (people ?? []).filter((p) => p.sessions !== null && p.sessions.length === 0);

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
