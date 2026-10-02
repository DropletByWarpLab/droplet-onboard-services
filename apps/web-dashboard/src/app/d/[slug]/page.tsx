"use client";

/**
 * WARP-2976 (ADR-059 §2.4) — `/d/<slug>`, a department's home.
 *
 * `/d/<slug>` is the department's front page and nothing more: it is not a
 * route tree. Everything it links to is an ordinary surface (`/cameras`,
 * `/projects`, …), which is what keeps deep links working (§2.3).
 *
 * States, in the order they are decided:
 *   · the department does not exist for this viewer → says so, with a way out
 *   · the profile read fails → 403 says "not a member", anything else offers
 *     a retry; never a blank board
 *   · no profile yet → the set-up state. An owner/admin or the department's
 *     manager (`canEdit`, decided by the server) picks a template; everyone
 *     else is told who can. A template is NEVER inferred from the name.
 *   · a profile → the board of its widgets, and "Customize" for `canEdit`.
 *
 * Nothing on this page grants access. The quick links run the viewer's own
 * nav gates (`visibleItems`), and a widget whose module is off for the viewer
 * is not rendered.
 */

import { useMemo, useState, type JSX } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { Building2, SlidersHorizontal } from "lucide-react";

import {
  DepartmentEditor,
  profileSaveErrorCopy as saveErrorCopy,
} from "@/components/Departments/DepartmentEditor";
import {
  DepartmentWidgetTile,
  widgetDef,
  type DepartmentWidgetProps,
} from "@/components/Departments/department-widgets";
import { useNavGates } from "@/components/Departments/useNavGates";
import { NAV_GROUPS, visibleItems } from "@/components/nav-config";
import { ShellPage } from "@/components/shell/ShellPage";
import { getDepartmentProfile, listDepartments, putDepartmentProfile } from "@/lib/api";
import {
  DEPARTMENTS_KEY,
  departmentProfileKey,
} from "@/lib/departments/active-department";
import {
  departmentHomeHref,
  departmentNavGroups,
  navChoices,
} from "@/lib/departments/department-nav";
import {
  DEPARTMENT_TEMPLATES,
  departmentIcon,
  templateDefaults,
  templateFor,
  type DepartmentTemplateDef,
} from "@/lib/departments/templates";
import type {
  Department,
  DepartmentProfile,
  DepartmentProfileResponse,
  PutDepartmentProfilePayload,
} from "@/lib/types";

import "@/components/Departments/departments.css";

type CodedError = Error & { status?: number; code?: string };

function decodeSlug(raw: string | string[] | undefined): string {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s) return "";
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export default function DepartmentHomePage(): JSX.Element {
  const params = useParams<{ slug: string }>();
  const slug = decodeSlug(params?.slug);

  const { data: list, error: listError, mutate: reloadList } = useSWR<{ departments: Department[] }>(
    DEPARTMENTS_KEY,
    () => listDepartments(),
    { shouldRetryOnError: false },
  );
  const dept =
    list?.departments.find((d) => d.slug === slug && d.kind !== "HOUSEHOLD") ?? null;

  if (listError) {
    return (
      <Frame label="Department">
        <div className="card">
          <p className="dept-note" role="status">
            Couldn&rsquo;t load departments just now.
          </p>
          <button type="button" className="btn sm" onClick={() => void reloadList()}>
            Try again
          </button>
        </div>
      </Frame>
    );
  }
  if (!list) {
    return (
      <Frame label="Department">
        <div className="card" aria-busy="true">
          <div className="dept-skel" aria-hidden="true" />
        </div>
      </Frame>
    );
  }
  if (!dept) {
    return (
      <Frame label="Department">
        <div className="card empty">
          <span className="ei" aria-hidden="true">
            <Building2 size={22} />
          </span>
          <span className="eh">We couldn&rsquo;t find that department</span>
          <p className="dept-note">
            It may have been renamed or archived, or you may not be one of its members.
          </p>
          <Link href="/" className="btn">
            Go to Overview
          </Link>
        </div>
      </Frame>
    );
  }
  return <DepartmentHome department={dept} allDepartments={list.departments} />;
}

function Frame({
  label,
  title,
  sub,
  icon,
  actions,
  children,
}: {
  label: string;
  title?: string;
  sub?: string;
  icon?: JSX.Element;
  actions?: JSX.Element | null;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <ShellPage
      icon={icon ?? <Building2 size={15} />}
      label={label}
      title={title}
      sub={sub}
      actions={actions ?? undefined}
    >
      <div className="droplet-departments">{children}</div>
    </ShellPage>
  );
}

function DepartmentHome({
  department: dept,
  allDepartments,
}: {
  department: Department;
  allDepartments: Department[];
}): JSX.Element {
  const gates = useNavGates();
  const { mutate: globalMutate } = useSWRConfig();
  const key = departmentProfileKey(dept.id);
  const { data, error, isLoading, mutate } = useSWR<DepartmentProfileResponse, CodedError>(
    key,
    () => getDepartmentProfile(dept.id),
    { shouldRetryOnError: false },
  );

  const [editing, setEditing] = useState<PutDepartmentProfilePayload | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [picking, setPicking] = useState<DepartmentTemplateDef["id"] | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const profile = data?.profile ?? null;
  const archived = dept.state === "archived" || dept.state === "archiving";
  const isTeam = dept.kind === "TEAM";
  // The server decides `canEdit`; the page only removes affordances the
  // server would refuse anyway (a team's own profile, an archived row).
  const canEdit = Boolean(data?.canEdit) && !archived && !isTeam;
  const parent = isTeam ? allDepartments.find((d) => d.id === dept.parentId) ?? null : null;

  const Icon = departmentIcon(profile?.icon ?? dept.profile?.icon);
  const template = templateFor(profile?.template);
  const members = `${dept.memberCount} ${dept.memberCount === 1 ? "member" : "members"}`;
  const sub = [template?.label, members].filter(Boolean).join(" · ");

  // The profile's destinations this viewer can reach: the same intersection
  // the sidebar renders (profile filter first, then every gate).
  const reachable = useMemo(() => {
    if (!profile) return [];
    const [deptGroup] = departmentNavGroups(NAV_GROUPS, dept, profile);
    return visibleItems(
      deptGroup.items.slice(1), // drop the synthetic home entry — we are on it
      gates.role,
      gates.capabilities,
      gates.isModuleOn,
    );
  }, [profile, dept, gates.role, gates.capabilities, gates.isModuleOn]);

  const choices = useMemo(
    () => navChoices(NAV_GROUPS, gates.role, gates.capabilities, gates.isModuleOn),
    [gates.role, gates.capabilities, gates.isModuleOn],
  );

  async function pickTemplate(t: DepartmentTemplateDef) {
    setPicking(t.id);
    setPickError(null);
    try {
      const { profile: saved } = await putDepartmentProfile(dept.id, templateDefaults(t));
      await mutate(
        { profile: saved, inheritedFrom: null, canEdit: data?.canEdit ?? true },
        { revalidate: false },
      );
      // The list row's `profile` summary labels the switcher and the overview.
      void globalMutate(DEPARTMENTS_KEY);
    } catch (err) {
      setPickError(saveErrorCopy(err));
    } finally {
      setPicking(null);
    }
  }

  async function save(payload: PutDepartmentProfilePayload) {
    if (!data || !profile) return;
    const previous = data;
    const optimistic: DepartmentProfileResponse = {
      ...previous,
      profile: { ...profile, ...payload } as DepartmentProfile,
    };
    setEditing(null);
    setSaveError(null);
    try {
      await mutate(
        async () => {
          const { profile: saved } = await putDepartmentProfile(dept.id, payload);
          return { ...previous, profile: saved };
        },
        { optimisticData: optimistic, rollbackOnError: true, revalidate: false },
      );
      void globalMutate(DEPARTMENTS_KEY);
    } catch (err) {
      // Rolled back; reopen the editor with what they had, and say why.
      setSaveError(saveErrorCopy(err));
      setEditing(payload);
    }
  }

  const customize =
    canEdit && profile && !editing ? (
      <button
        type="button"
        className="btn"
        onClick={() => {
          setSaveError(null);
          setEditing({
            template: profile.template,
            icon: profile.icon,
            navHrefs: profile.navHrefs,
            homeWidgets: profile.homeWidgets,
          });
        }}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        Customize
      </button>
    ) : null;

  const frame = (children: React.ReactNode) => (
    <Frame
      label={dept.name}
      title={dept.name}
      sub={sub}
      icon={<Icon size={15} />}
      actions={customize}
    >
      {children}
    </Frame>
  );

  if (error) {
    if (error.status === 403) {
      return frame(
        <div className="card">
          <p className="dept-note" role="status">
            You&rsquo;re not a member of this department, so its home isn&rsquo;t available to you.
          </p>
        </div>,
      );
    }
    return frame(
      <div className="card">
        <p className="dept-note" role="status">
          Couldn&rsquo;t load this department just now.
        </p>
        <button type="button" className="btn sm" onClick={() => void mutate()}>
          Try again
        </button>
      </div>,
    );
  }

  if (isLoading || !data) {
    return frame(
      <div className="card" aria-busy="true">
        <div className="dept-skel" aria-hidden="true" />
      </div>,
    );
  }

  const notices = (
    <>
      {archived && (
        <p className="dept-note" role="status">
          This department is archived, so its home can&rsquo;t be changed.
        </p>
      )}
      {isTeam && (
        <p className="dept-note">
          Teams use their department&rsquo;s setup
          {parent ? (
            <>
              {" — "}
              <Link href={departmentHomeHref(parent.slug)} className="dept-inline-link">
                open {parent.name}
              </Link>
            </>
          ) : null}
          .
        </p>
      )}
    </>
  );

  if (!profile) {
    return frame(
      <>
        {notices}
        {canEdit ? (
          <section className="card" aria-labelledby="dept-setup-h">
            <div className="card-h">
              <h2 id="dept-setup-h" className="ct">
                Set up {dept.name}
              </h2>
            </div>
            <p className="dept-note">
              Pick a template to start from. It chooses the pages in this department&rsquo;s
              menu and the widgets on its home, and you can change both afterwards.
            </p>
            <ul className="dept-templates" aria-label="Templates">
              {DEPARTMENT_TEMPLATES.map((t) => {
                const TIcon = departmentIcon(t.icon);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="dept-template"
                      disabled={picking !== null}
                      aria-busy={picking === t.id}
                      onClick={() => void pickTemplate(t)}
                    >
                      <span className="dept-template-ic" aria-hidden="true">
                        <TIcon size={16} />
                      </span>
                      <span className="dept-template-name">{t.label}</span>
                      <span className="dept-template-desc">{t.description}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {pickError && (
              <p className="dept-error" role="alert">
                {pickError}
              </p>
            )}
          </section>
        ) : !isTeam ? (
          <div className="card empty">
            <span className="ei" aria-hidden="true">
              <Icon size={22} />
            </span>
            <span className="eh">Not set up yet</span>
            <p className="dept-note">
              This department isn&rsquo;t set up yet. Ask an owner or its manager.
            </p>
          </div>
        ) : null}
      </>,
    );
  }

  if (editing) {
    return frame(
      <DepartmentEditor
        initial={editing}
        choices={choices}
        isModuleOn={gates.isModuleOn}
        saving={false}
        error={saveError}
        onSave={(payload) => void save(payload)}
        onCancel={() => {
          setEditing(null);
          setSaveError(null);
        }}
      />,
    );
  }

  const widgetProps = (size: DepartmentWidgetProps["size"]): DepartmentWidgetProps => ({
    department: dept,
    profile,
    reachable,
    canEdit,
    size,
    onCustomize: canEdit
      ? () =>
          setEditing({
            template: profile.template,
            icon: profile.icon,
            navHrefs: profile.navHrefs,
            homeWidgets: profile.homeWidgets,
          })
      : undefined,
  });

  // Unknown ids (a newer dashboard's widget) and widgets whose module is off
  // for this viewer are skipped — never rendered as an empty or dead tile.
  const shown = profile.homeWidgets.filter((w) => {
    const def = widgetDef(w.widget);
    if (!def) return false;
    return !def.requiresModule || gates.isModuleOn(def.requiresModule);
  });

  return frame(
    <>
      {notices}
      {saveError && (
        <p className="dept-error" role="alert">
          {saveError}
        </p>
      )}
      {shown.length === 0 ? (
        <div className="card empty">
          <span className="ei" aria-hidden="true">
            <Icon size={22} />
          </span>
          <span className="eh">Nothing on this home yet</span>
          <p className="dept-note">
            {canEdit
              ? "Customize it to add widgets for the things this department keeps an eye on."
              : "An owner or this department’s manager can add widgets here."}
          </p>
        </div>
      ) : (
        <div className="dept-board">
          {shown.map((w) => (
            <DepartmentWidgetTile key={w.widget} id={w.widget} props={widgetProps(w.size)} />
          ))}
        </div>
      )}
    </>,
  );
}
