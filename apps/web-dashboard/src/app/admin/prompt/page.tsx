"use client";

/**
 * /admin/prompt — what one person's assistant is actually handed.
 *
 * ── Why this page exists ───────────────────────────────────────────────────
 *
 * The AI on this box runs as the person asking, and can only ever narrow what
 * they could already do themselves. That has been true and enforced for a
 * while — narrowed when the tool shelf is built, re-checked immediately before
 * every call, and refused outright for a scheduled run nobody can be
 * attributed to. What has never existed is any way to LOOK at it.
 *
 * So an admin asking "what can the assistant do for Sam?" had three numbers
 * available and no reason attached to any of them. This page answers the
 * question with the actual prompt and the actual tool list, and names the gate
 * behind every absence.
 *
 * ── Read-only, and it renders what the box says ────────────────────────────
 *
 * Nothing here decides anything. Every verdict, count and sentence comes from
 * the orchestrator, which produced it by calling the same predicates a chat
 * turn calls. This file must never compute a verdict of its own — a second
 * opinion about a security boundary is the whole defect class the slice was
 * written to end.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Lock,
  ScrollText,
  ShieldCheck,
  Wrench,
} from "lucide-react";

import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Card, Kpi, Row, Sect } from "@/components/shell/primitives";
import { fetchUsers } from "@/lib/api";
import type {
  InspectGate,
  PromptBlockView,
  RosterUser,
  ToolInspectRow,
} from "@/lib/types";
import { useAssistantInspect } from "@/lib/hooks/useAssistantInspect";

const ICON = <Bot size={15} />;
const SUB = "The prompt and the tools each person's assistant actually receives.";
const UNKNOWN = "—";

/**
 * How each gate reads on screen.
 *
 * Ordered as the server orders them, which is the order a turn applies them.
 * The copy is deliberately about the PERSON and not the mechanism: an admin
 * reading "role_grant" learns nothing they could act on.
 */
const GATE_LABEL: Record<InspectGate, string> = {
  write_tier: "Not owner or admin",
  role_grant: "Their role doesn't reach it",
  interview_strip: "Setup conversation",
  off_lan_withhold: "Off the home network",
  chat_policy: "Not available by asking",
  turn_relevance: "Not relevant to this message",
};

const GATE_ORDER: InspectGate[] = [
  "write_tier",
  "role_grant",
  "interview_strip",
  "off_lan_withhold",
  "chat_policy",
  "turn_relevance",
];

/** Why an identity could not be established, in a sentence. */
const UNRESOLVED_COPY: Record<string, string> = {
  no_principal: "No account was named.",
  user_missing: "There is no account with that id on this box.",
  user_deactivated:
    "This account is deactivated. Nothing runs as a deactivated person — including anything they scheduled before they left.",
  read_failed: "The account could not be read. This is a fault, not a permissions answer.",
};

function statusBadge(status: PromptBlockView["status"]) {
  switch (status) {
    case "present":
      return <Badge kind="ok">In the prompt</Badge>;
    case "absent":
      return <Badge kind="muted">Not set</Badge>;
    case "errored":
      return <Badge kind="danger">Broken</Badge>;
    case "dropped":
      return <Badge kind="warn">Dropped — too long</Badge>;
    default:
      return <Badge kind="muted">Not shown here</Badge>;
  }
}

export default function AssistantInspectorPage() {
  const [people, setPeople] = useState<RosterUser[] | null>(null);
  const [rosterFailed, setRosterFailed] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [offLan, setOffLan] = useState(false);
  const [interview, setInterview] = useState(false);
  const [showWithheld, setShowWithheld] = useState(true);

  useEffect(() => {
    void fetchUsers()
      .then(({ users }) => setPeople(users))
      .catch(() => setRosterFailed(true));
  }, []);

  const turn = useMemo(
    () => ({ message, offLan, interview }),
    [message, offLan, interview],
  );
  const { tools, prompt } = useAssistantInspect(userId, turn);

  const rows: ToolInspectRow[] =
    tools.state === "ok"
      ? tools.value.rows.filter((r) => showWithheld || r.advertised)
      : [];

  const grouped = useMemo(() => {
    const advertised = rows.filter((r) => r.advertised);
    const byGate = new Map<InspectGate, ToolInspectRow[]>();
    for (const r of rows) {
      if (r.advertised || !r.gate) continue;
      const list = byGate.get(r.gate) ?? [];
      list.push(r);
      byGate.set(r.gate, list);
    }
    return { advertised, byGate };
  }, [rows]);

  const unresolved =
    tools.state === "ok" ? tools.value.unresolved : null;

  return (
    <ShellPage icon={ICON} label="Assistant" title="Assistant" sub={SUB}>
      <Sect title="Who" />
      <Card>
        <div className="rows">
          <Row
            icon={<ShieldCheck size={15} />}
            iconBrand
            title="Person"
            sub="The assistant runs as this person and can only ever do less than they can."
            right={
              <select
                aria-label="Person"
                value={userId ?? ""}
                onChange={(e) => setUserId(e.target.value || null)}
              >
                <option value="">Choose someone…</option>
                {(people ?? []).map((p) => (
                  <option key={p.userId ?? p.username} value={p.userId ?? ""}>
                    {p.displayName || p.username}
                  </option>
                ))}
              </select>
            }
          />
          <Row
            icon={<ScrollText size={15} />}
            title="A message they might send"
            sub="Tools are chosen per message. Leave this empty to see the baseline."
            right={
              <input
                aria-label="A message they might send"
                value={message}
                placeholder="find the Acme contract"
                onChange={(e) => setMessage(e.target.value)}
              />
            }
          />
          <Row
            icon={<Lock size={15} />}
            title="Away from home"
            sub="Off the home network, tools that read stored files and memory are withheld."
            right={
              <input
                type="checkbox"
                aria-label="Away from home"
                checked={offLan}
                onChange={(e) => setOffLan(e.target.checked)}
              />
            }
          />
          <Row
            icon={<Wrench size={15} />}
            title="During setup"
            sub="In a setup conversation nothing that changes anything runs."
            right={
              <input
                type="checkbox"
                aria-label="During setup"
                checked={interview}
                onChange={(e) => setInterview(e.target.checked)}
              />
            }
          />
        </div>
        {rosterFailed ? (
          <p className="sub">Could not load the list of people.</p>
        ) : null}
      </Card>

      {userId === null ? null : (
        <>
          {unresolved ? (
            <>
              <Sect title="This account" />
              <Card>
                <Row
                  icon={<AlertTriangle size={15} />}
                  title="No assistant runs for this person"
                  sub={UNRESOLVED_COPY[unresolved] ?? unresolved}
                />
              </Card>
            </>
          ) : null}

          <Sect
            title="Tools"
            extra={
              tools.state === "ok"
                ? `${tools.value.counts.advertised} of ${tools.value.counts.registered}`
                : undefined
            }
          />
          <div className="grid c3">
            <Card>
              <Kpi
                icon={<Wrench size={15} />}
                label="Reach the assistant"
                value={tools.state === "ok" ? tools.value.counts.advertised : UNKNOWN}
                note={tools.state === "failed" ? "Unknown" : undefined}
              />
            </Card>
            <Card>
              <Kpi
                icon={<ShieldCheck size={15} />}
                label="Withheld"
                value={tools.state === "ok" ? tools.value.counts.withheld : UNKNOWN}
                note={tools.state === "failed" ? "Unknown" : undefined}
              />
            </Card>
            <Card>
              <Kpi
                icon={<Bot size={15} />}
                label="Acting as"
                value={tools.state === "ok" ? (tools.value.tier ?? UNKNOWN) : UNKNOWN}
                note={
                  // The trap, said out loud. "No role narrowing" reads as
                  // "unrestricted" to everybody who has not read the access
                  // model, and for a person with no role it is the opposite:
                  // they still lose every tool that changes anything.
                  tools.state === "ok" && tools.value.noRoleNarrowing
                    ? tools.value.tier === "owner"
                      ? "Owner — no role limits apply"
                      : "No custom role assigned. Tools that change things are still withheld."
                    : undefined
                }
              />
            </Card>
          </div>

          <Card
            title="What the assistant can use"
            meta={
              <label>
                <input
                  type="checkbox"
                  aria-label="Show withheld tools"
                  checked={showWithheld}
                  onChange={(e) => setShowWithheld(e.target.checked)}
                />{" "}
                Show withheld
              </label>
            }
          >
            {tools.state === "failed" ? (
              <p className="sub">Could not read the tool list. {tools.error}</p>
            ) : tools.state !== "ok" ? (
              <p className="sub">Loading…</p>
            ) : (
              <div className="rows">
                {grouped.advertised.map((r) => (
                  <Row
                    key={r.name}
                    title={r.homeDescription}
                    sub={r.lockCaveat ?? r.name}
                    subMono={!r.lockCaveat}
                    meta={r.domain}
                    right={
                      r.lockCaveat ? (
                        <Badge kind="warn">Locks refused</Badge>
                      ) : (
                        <Badge kind="ok">Available</Badge>
                      )
                    }
                  />
                ))}
              </div>
            )}
          </Card>

          {showWithheld && tools.state === "ok"
            ? GATE_ORDER.filter((g) => (grouped.byGate.get(g)?.length ?? 0) > 0).map(
                (gate) => {
                  const list = grouped.byGate.get(gate)!;
                  return (
                    <Card
                      key={gate}
                      title={GATE_LABEL[gate]}
                      meta={`${list.length} withheld`}
                    >
                      {/* One reason per group, taken from the server. Every row
                          in the group was withheld by the same gate, so
                          repeating the sentence per row would be noise. */}
                      <p className="sub">{list[0].reason}</p>
                      <div className="rows">
                        {list.map((r) => (
                          <Row
                            key={r.name}
                            title={r.homeDescription}
                            sub={r.name}
                            subMono
                            meta={r.domain}
                            right={
                              r.alsoWithheldBy.length > 0 ? (
                                // The fact that makes this actionable: a tool
                                // held back by one gate is one grant away, and
                                // a tool held back by four is not.
                                <Badge kind="muted">
                                  {`+${r.alsoWithheldBy.length} other ${
                                    r.alsoWithheldBy.length === 1 ? "reason" : "reasons"
                                  }`}
                                </Badge>
                              ) : undefined
                            }
                          />
                        ))}
                      </div>
                    </Card>
                  );
                },
              )
            : null}

          <Sect
            title="Prompt"
            extra={
              prompt.state === "ok"
                ? `${prompt.value.assembledChars.toLocaleString()} characters`
                : undefined
            }
          />
          {prompt.state === "failed" ? (
            <Card>
              <p className="sub">Could not read the prompt. {prompt.error}</p>
            </Card>
          ) : prompt.state !== "ok" ? (
            <Card>
              <p className="sub">Loading…</p>
            </Card>
          ) : (
            <>
              <Card title="What it is told, in order">
                <div className="rows">
                  {prompt.value.blocks.map((b) => (
                    <Row
                      key={b.key}
                      title={b.label}
                      sub={
                        b.note ??
                        (b.cap !== null
                          ? `${b.chars.toLocaleString()} of ${b.cap.toLocaleString()} characters`
                          : `${b.chars.toLocaleString()} characters`)
                      }
                      meta={b.neverDropped ? "always kept" : "dropped first if too long"}
                      right={statusBadge(b.status)}
                    />
                  ))}
                </div>
              </Card>
              {prompt.value.erroredBlocks.length > 0 ? (
                <Card>
                  <Row
                    icon={<AlertTriangle size={15} />}
                    title="Some of the prompt could not be built"
                    sub={
                      "In a real conversation these are silently missing and nobody is told. " +
                      "That is what this page is for."
                    }
                    right={<Badge kind="danger">{prompt.value.erroredBlocks.length}</Badge>}
                  />
                </Card>
              ) : null}
              <Card title="The prompt itself">
                {/* The literal string the model receives. A summary of a prompt
                    is somebody's opinion about a prompt. */}
                <pre className="mono">{prompt.value.assembled}</pre>
              </Card>
            </>
          )}
        </>
      )}
    </ShellPage>
  );
}
