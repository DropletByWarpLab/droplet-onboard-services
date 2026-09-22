"use client";

/**
 * WARP-2976 (ADR-059 §2.4) — the department home's widget registry.
 *
 * The rule this file exists to hold: EVERY WIDGET READS A REAL SOURCE, OR IT
 * IS NOT OFFERED. The home board once shipped a camera tile that was a CSS
 * mock with a hard-coded red dot, and a mock tile is a defect, not a
 * placeholder. So the P1 set is exactly the five widgets whose data already
 * exists:
 *
 *   quick-links  the department's nav destinations the viewer can reach
 *   members      GET /api/departments/:id → members
 *   work         GET /api/pm/work-items?department=<id> (WARP-2717)
 *   cameras      GET /api/cameras — online / total, module-gated
 *   files        the department's library link + `usedBytes` from its row
 *
 * A widget whose source module is off for the viewer is not rendered on the
 * board at all (`requiresModule`) — the home follows the nav, which hides a
 * switched-off surface rather than showing a dead one.
 *
 * Every body renders one of four states: loading (a skeleton, never a zero),
 * failed (says it could not read — never a zero), empty (an invitation in
 * words), or the real figure.
 */
import type { JSX, ReactNode } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  FolderKanban,
  FolderOpen,
  LayoutGrid,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";

import type { NavItem } from "@/components/nav-config";
import { getDepartment } from "@/lib/api";
import type { DepartmentWidgetId } from "@/lib/departments/templates";
import { buildFilesUrl } from "@/lib/space-attribution";
import { formatStorageBytes } from "@/lib/storage-units";
import type {
  Department,
  DepartmentDetail,
  DepartmentProfile,
  DepartmentRight,
  DepartmentWidgetSize,
} from "@/lib/types";

import { useCameraFleet, useDepartmentWork } from "./department-sources";

export interface DepartmentWidgetProps {
  department: Department;
  profile: DepartmentProfile;
  /** The profile's nav destinations that pass THIS viewer's gates, in order. */
  reachable: NavItem[];
  canEdit: boolean;
  onCustomize?: () => void;
  size: DepartmentWidgetSize;
}

export interface DepartmentWidgetDef {
  label: string;
  /** One line for the Customize list. */
  description: string;
  icon: LucideIcon;
  /** The module whose data the widget reads. Off for the viewer → not shown. */
  requiresModule?: string;
  Component: (props: DepartmentWidgetProps) => JSX.Element;
}

/* ── shared states ───────────────────────────────────────── */

function Skeleton(): JSX.Element {
  return <div className="dept-skel" aria-hidden="true" />;
}

function Failed({ what }: { what: string }): JSX.Element {
  return (
    <p className="dept-note" role="status">
      Couldn&rsquo;t read {what} just now.
    </p>
  );
}

function Invite({ children }: { children: ReactNode }): JSX.Element {
  return <p className="dept-note">{children}</p>;
}

/* ── quick-links ─────────────────────────────────────────── */

function QuickLinksWidget({ reachable, canEdit, onCustomize }: DepartmentWidgetProps) {
  if (reachable.length === 0) {
    return canEdit ? (
      <div className="dept-invite">
        <Invite>Pick the pages this department uses and they&rsquo;ll appear here.</Invite>
        {onCustomize && (
          <button type="button" className="btn sm" onClick={onCustomize}>
            Choose pages
          </button>
        )}
      </div>
    ) : (
      <Invite>No pages have been picked for this department yet.</Invite>
    );
  }
  return (
    <ul className="dept-links">
      {reachable.map((item) => {
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <Link href={item.href} className="dept-link">
              <Icon size={16} aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/* ── members ─────────────────────────────────────────────── */

const RIGHT_LABEL: Record<DepartmentRight, string> = {
  reader: "Reader",
  contributor: "Contributor",
  manager: "Manager",
};

const MEMBER_ROWS: Record<DepartmentWidgetSize, number> = { s: 4, m: 8, l: 16 };

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

function MembersWidget({ department, size, canEdit }: DepartmentWidgetProps) {
  const { data, error, isLoading } = useSWR<DepartmentDetail>(
    `/api/departments/${department.id}`,
    () => getDepartment(department.id),
    { shouldRetryOnError: false },
  );
  if (error) return <Failed what="the member list" />;
  if (isLoading || !data) return <Skeleton />;
  if (data.members.length === 0) {
    return canEdit ? (
      <Invite>
        No one is in this department yet. Add people from{" "}
        <Link href="/users" className="dept-inline-link">
          People
        </Link>
        .
      </Invite>
    ) : (
      <Invite>No one is in this department yet.</Invite>
    );
  }
  const shown = data.members.slice(0, MEMBER_ROWS[size]);
  const more = data.members.length - shown.length;
  return (
    <ul className="dept-members">
      {shown.map((m) => (
        <li key={m.userId} className="dept-member">
          <span className="ava" aria-hidden="true">
            {initialsOf(m.displayName)}
          </span>
          <span className="dept-member-name">{m.displayName}</span>
          <span className="dept-member-right">{RIGHT_LABEL[m.right]}</span>
        </li>
      ))}
      {more > 0 && <li className="dept-note">and {more} more</li>}
    </ul>
  );
}

/* ── work ────────────────────────────────────────────────── */

const WORK_ROWS: Record<DepartmentWidgetSize, number> = { s: 3, m: 5, l: 10 };

function WorkWidget({ department, size }: DepartmentWidgetProps) {
  const { open, capped, error, isLoading } = useDepartmentWork(department.id, true);
  if (error) return <Failed what="this department's work" />;
  if (isLoading || !open) return <Skeleton />;
  if (open.length === 0) {
    return (
      <Invite>
        Nothing open. Route work to {department.name} from{" "}
        <Link href="/projects" className="dept-inline-link">
          Projects
        </Link>{" "}
        and it will show here.
      </Invite>
    );
  }
  const shown = open.slice(0, WORK_ROWS[size]);
  return (
    <div className="dept-work">
      <p className="dept-figure">
        <span className="dept-figure-n">
          {open.length}
          {capped ? "+" : ""}
        </span>
        <span className="dept-figure-l">open {open.length === 1 ? "item" : "items"}</span>
      </p>
      <ul className="dept-rows">
        {shown.map((item) => (
          <li key={item.id} className="dept-row">
            <span className="dept-row-k">{item.key}</span>
            <span className="dept-row-v">{item.name}</span>
          </li>
        ))}
      </ul>
      <Link href="/projects" className="dept-more">
        Open Projects
      </Link>
    </div>
  );
}

/* ── cameras ─────────────────────────────────────────────── */

function CamerasWidget(_props: DepartmentWidgetProps) {
  const { online, total, error, isLoading } = useCameraFleet(true);
  if (error) return <Failed what="the cameras" />;
  if (isLoading || online === undefined || total === undefined) return <Skeleton />;
  if (total === 0) {
    return (
      <Invite>
        No cameras yet.{" "}
        <Link href="/cameras" className="dept-inline-link">
          Add one from Cameras
        </Link>
        .
      </Invite>
    );
  }
  return (
    <div className="dept-work">
      <p className="dept-figure">
        <span className="dept-figure-n">
          {online} of {total}
        </span>
        <span className="dept-figure-l">{total === 1 ? "camera" : "cameras"} online</span>
      </p>
      <Link href="/cameras" className="dept-more">
        Open cameras
      </Link>
    </div>
  );
}

/* ── files ───────────────────────────────────────────────── */

function FilesWidget({ department }: DepartmentWidgetProps) {
  const href = buildFilesUrl(`dept:${department.id}`, "/");
  // `usedBytes` is null on any read failure or before discovery — never a
  // fabricated 0 — so the size line is simply absent then.
  const used = department.usedBytes != null ? formatStorageBytes(department.usedBytes, { zero: "0 B" }) : null;
  const quota = department.quotaBytes != null ? formatStorageBytes(department.quotaBytes) : null;
  return (
    <div className="dept-work">
      {used && (
        <p className="dept-figure">
          <span className="dept-figure-n">{used}</span>
          <span className="dept-figure-l">{quota ? `used of ${quota}` : "used"}</span>
        </p>
      )}
      <Link href={href} className="dept-more">
        Open the {department.name} library
      </Link>
    </div>
  );
}

/* ── the registry ────────────────────────────────────────── */

export const DEPARTMENT_WIDGETS: Record<DepartmentWidgetId, DepartmentWidgetDef> = {
  "quick-links": {
    label: "Quick links",
    description: "The pages this department uses.",
    icon: LayoutGrid,
    Component: QuickLinksWidget,
  },
  members: {
    label: "Members",
    description: "Who is in the department, and their access.",
    icon: Users,
    Component: MembersWidget,
  },
  work: {
    label: "Work",
    description: "Open work items this department owns.",
    icon: FolderKanban,
    requiresModule: "projects",
    Component: WorkWidget,
  },
  cameras: {
    label: "Cameras",
    description: "How many of your cameras are online.",
    icon: Video,
    requiresModule: "cameras",
    Component: CamerasWidget,
  },
  files: {
    label: "Files",
    description: "The department's file library.",
    icon: FolderOpen,
    requiresModule: "files",
    Component: FilesWidget,
  },
};

export function widgetDef(id: string): DepartmentWidgetDef | null {
  return (DEPARTMENT_WIDGETS as Record<string, DepartmentWidgetDef>)[id] ?? null;
}

/**
 * One tile on the board: the shell `.card` chrome with the widget's icon and
 * title, sized by `data-size`.
 */
export function DepartmentWidgetTile({
  id,
  props,
}: {
  id: string;
  props: DepartmentWidgetProps;
}): JSX.Element | null {
  const def = widgetDef(id);
  if (!def) return null;
  const Icon = def.icon;
  const headingId = `dept-w-${id}`;
  const Body = def.Component;
  return (
    <section className="card dept-widget" data-size={props.size} data-widget={id} aria-labelledby={headingId}>
      <div className="card-h">
        <span className="ci" aria-hidden="true">
          <Icon size={15} />
        </span>
        <h2 id={headingId} className="ct">
          {def.label}
        </h2>
      </div>
      <Body {...props} />
    </section>
  );
}
