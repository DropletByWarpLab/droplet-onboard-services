"use client";

/**
 * WARP-2976 (ADR-059 §2.4) — `/d`, the Business overview.
 *
 * One tile per department: its icon, name, member count and the ONE headline
 * figure its template names. Each tile is the door into `/d/<slug>`.
 *
 * Owner/admin only — they are the viewers who see every department and the
 * "Whole business" choice. Anyone else is sent to the department their shell
 * is showing, or to Overview. (The department list endpoint scopes rows for
 * them anyway; this is wayfinding, not the gate.)
 *
 * The rules for the figures live in `HeadlineFigure.tsx`: every figure reads
 * an existing source, a switched-off module says so in words, and a
 * department with no profile says "Not set up" instead of guessing a
 * template from its name.
 */

import { useEffect, type JSX } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PanelsTopLeft } from "lucide-react";

import { HeadlineFigure } from "@/components/Departments/HeadlineFigure";
import { NOT_SET_UP_CAPTION } from "@/components/Departments/DepartmentSwitcher";
import { ShellPage } from "@/components/shell/ShellPage";
import { useAuth } from "@/lib/auth";
import { useActiveDepartment } from "@/lib/departments/active-department";
import { departmentHomeHref } from "@/lib/departments/department-nav";
import { departmentIcon, templateFor } from "@/lib/departments/templates";
import { useModuleGate } from "@/lib/hooks/useModuleGate";
import type { Department } from "@/lib/types";

import "@/components/Departments/departments.css";

const SUB = "Every department at a glance. Open one to see its home.";

export default function BusinessOverviewPage(): JSX.Element | null {
  const { user } = useAuth();
  const router = useRouter();
  const { choices, active, isLoaded } = useActiveDepartment();
  const isModuleOn = useModuleGate();
  const isAdminTier = user?.role === "owner" || user?.role === "admin";

  useEffect(() => {
    if (!user || isAdminTier || !isLoaded) return;
    router.replace(active ? departmentHomeHref(active.slug) : "/");
  }, [user, isAdminTier, isLoaded, active, router]);

  if (!user || !isAdminTier) return null;

  return (
    <ShellPage
      icon={<PanelsTopLeft size={15} />}
      label="Business overview"
      title="Business overview"
      sub={SUB}
    >
      <div className="droplet-departments">
        {!isLoaded ? (
          <div className="dept-tiles" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card">
                <div className="dept-skel" aria-hidden="true" />
              </div>
            ))}
          </div>
        ) : choices.length === 0 ? (
          <div className="card empty">
            <span className="ei" aria-hidden="true">
              <PanelsTopLeft size={22} />
            </span>
            <span className="eh">No departments yet</span>
            <p className="dept-note">
              Create one from People to give a group its own home, pages and file library.
            </p>
            <Link href="/users" className="btn primary">
              Go to People
            </Link>
          </div>
        ) : (
          <ul className="dept-tiles" aria-label="Departments">
            {choices.map((d) => (
              <li key={d.id}>
                <DepartmentTile department={d} isModuleOn={isModuleOn} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </ShellPage>
  );
}

function DepartmentTile({
  department: d,
  isModuleOn,
}: {
  department: Department;
  isModuleOn: (moduleId: string) => boolean;
}): JSX.Element {
  const Icon = departmentIcon(d.profile?.icon);
  const template = templateFor(d.profile?.template);
  return (
    <Link href={departmentHomeHref(d.slug)} className="card hover dept-tile">
      <div className="card-h">
        <span className="ci" aria-hidden="true">
          <Icon size={15} />
        </span>
        <span className="ct">{d.name}</span>
      </div>
      <span className="dept-tile-meta">
        {d.memberCount} {d.memberCount === 1 ? "member" : "members"}
        {template ? ` · ${template.label}` : ""}
      </span>
      {d.profile === null ? (
        <span className="dept-caption">{NOT_SET_UP_CAPTION}</span>
      ) : template ? (
        <HeadlineFigure figure={template.headline} departmentId={d.id} isModuleOn={isModuleOn} />
      ) : null}
    </Link>
  );
}
