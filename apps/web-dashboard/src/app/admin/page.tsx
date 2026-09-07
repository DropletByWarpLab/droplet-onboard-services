"use client";

/**
 * /admin — the console's front door.
 *
 * This route used to 404. The four pages under /admin were reachable only if
 * you already knew their URLs, and nothing in the product linked to them.
 *
 * Deliberately built from endpoints that already exist and helpers the
 * dashboard already has: no new orchestrator routes, no roll-up endpoint.
 * Each tile degrades on its own — a failed probe renders "unknown", never a
 * zero and never a negative, because a console that quietly reports "0
 * problems" when it could not reach the box is worse than one that says so.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity as ActivityIcon,
  Bot,
  HardDrive,
  ScrollText,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  Users as UsersIcon,
} from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Card, Kpi, Row, Sect } from "@/components/shell/primitives";
import { fetchSystemHealth, fetchUsers, type SystemHealth } from "@/lib/api";

const ICON = <ServerCog size={15} />;
const SUB =
  "Everything about how this Droplet is set up, and who can use it.";

/** A probe that has not answered yet, or could not. Rendered as "—". */
type Probe<T> = { state: "loading" | "failed"; value?: undefined } | { state: "ok"; value: T };

const UNKNOWN = "—";

const AREAS = [
  {
    href: "/users",
    icon: <UsersIcon size={15} />,
    title: "People",
    sub: "Accounts, invites, departments, and the roles that decide what each person can reach.",
  },
  {
    href: "/admin/audit",
    icon: <ScrollText size={15} />,
    title: "Audit log",
    sub: "Every important action, signed and chained so the history cannot be quietly rewritten.",
  },
  {
    href: "/admin/files",
    icon: <HardDrive size={15} />,
    title: "Company files",
    sub: "Storage used by each person and library on this box.",
  },
  {
    href: "/admin/prompt",
    icon: <Bot size={15} />,
    title: "Assistant",
    sub: "The prompt and the tools each person's assistant actually gets, and what is holding the rest back.",
  },
  {
    href: "/settings",
    icon: <SlidersHorizontal size={15} />,
    title: "Settings",
    sub: "Features, personality, sign-in, mail, and the danger zone.",
  },
];

export default function AdminOverviewPage() {
  const [health, setHealth] = useState<Probe<SystemHealth>>({ state: "loading" });
  const [people, setPeople] = useState<Probe<number>>({ state: "loading" });

  const load = useCallback(() => {
    // Independent probes, deliberately not Promise.all'd into one failure:
    // an unreachable roster must not blank the health tile.
    void fetchSystemHealth()
      .then((value) => setHealth({ state: "ok", value }))
      .catch(() => setHealth({ state: "failed" }));
    void fetchUsers()
      .then(({ users }) => setPeople({ state: "ok", value: users.length }))
      .catch(() => setPeople({ state: "failed" }));
  }, []);

  useEffect(load, [load]);

  const healthy =
    health.state === "ok"
      ? health.value.components.filter((c) => c.status === "ok").length
      : null;
  const total = health.state === "ok" ? health.value.components.length : null;

  const statusBadge =
    health.state !== "ok" ? (
      <Badge kind="muted">Unknown</Badge>
    ) : health.value.status === "ok" ? (
      <Badge kind="ok">Healthy</Badge>
    ) : health.value.status === "degraded" ? (
      <Badge kind="warn">Degraded</Badge>
    ) : (
      <Badge kind="danger">Down</Badge>
    );

  return (
    <ShellPage icon={ICON} label="Console" title="Console" sub={SUB}>
      <Sect
        title="This box"
        extra={health.state === "ok" ? health.value.version : undefined}
      />
      <div className="grid c3">
        <Card>
          <Kpi
            icon={<ShieldCheck size={15} />}
            label="Status"
            value={statusBadge}
            note={
              health.state === "failed"
                ? "Could not reach the box"
                : undefined
            }
          />
        </Card>
        <Card>
          <Kpi
            icon={<ActivityIcon size={15} />}
            label="Services responding"
            value={total === null ? UNKNOWN : `${healthy} / ${total}`}
            note={health.state === "failed" ? "Unknown" : undefined}
          />
        </Card>
        <Card>
          <Kpi
            icon={<UsersIcon size={15} />}
            label="People"
            value={people.state === "ok" ? people.value : UNKNOWN}
            note={people.state === "failed" ? "Unknown" : undefined}
          />
        </Card>
      </div>

      <Sect title="Configure" />
      <Card>
        <div className="rows">
          {AREAS.map((area) => (
            <Link key={area.href} href={area.href} style={{ display: "block", color: "inherit", textDecoration: "none" }}>
              <Row icon={area.icon} iconBrand title={area.title} sub={area.sub} />
            </Link>
          ))}
        </div>
      </Card>
    </ShellPage>
  );
}
