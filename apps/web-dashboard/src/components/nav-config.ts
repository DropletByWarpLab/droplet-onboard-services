/**
 * The dashboard's nav definition — the ONE source of truth for what the
 * product's sections are, who may see them, and which capability module owns
 * each route.
 *
 * Split out of Sidebar.tsx (WARP-1528) because it is DATA plus pure
 * predicates, and three things now read it: the Sidebar itself (all three of
 * its surfaces), the route-level module guard, and the tests that pin the
 * gates. Keeping it in the component module meant anything importing a
 * predicate also pulled in the whole component and its hooks — and made the
 * predicates unmockable independently of the chrome.
 */
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Blocks,
  BookOpen,
  Calendar as CalendarIcon,
  Cpu,
  Film,
  FlaskConical,
  FolderKanban,
  FolderLock,
  FolderOpen,
  Globe,
  HardDrive,
  HeartPulse,
  HelpCircle,
  Laptop,
  LayoutDashboard,
  Mail,
  MessageSquare,
  MessagesSquare,
  Mic,
  Network,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Trash2,
  Star,
  Clock,
  Share2,
  Users,
  Video,
  Wrench,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Restrict visibility by role. Default: visible to all. */
  roles?: Array<NonNullable<AuthRole>>;
  /**
   * Hide unless the named backend capability is wired (GET
   * /api/admin/capabilities). Used for optional admin surfaces whose backing
   * integration may be unconfigured. Default: no capability gate.
   */
  requiresCapability?: "claudeActivity" | "ragEval";
  /**
   * Hide unless the named user-facing module is EFFECTIVE for this viewer —
   * GET /api/modules, readable by every authenticated role. Since WARP-1528
   * that endpoint answers PER PERSON (workspace-effective ∩ the viewer's role
   * grants, ADR-032 §3), so one tag now covers both the box-wide Features
   * toggle and the per-person narrowing.
   *
   * WARP-1397: every toggleable module's nav entry carries its registry id
   * here, so flipping a feature off in Settings → Features removes its nav
   * entry (no dead, module-gated 404). The gate fails open, so an entry only
   * disappears on a positive "off". Core modules (chat) are never tagged.
   * The id must match the orchestrator module-registry id.
   *
   * WARP-1528: this applies to CHILDREN as well as top-level items — a child's
   * own `roles` / `requiresCapability` / `requiresModule` are honored, and a
   * child still disappears with its parent. (It used to be a documented no-op
   * on children, which meant a sub-destination could never be gated on its
   * own.)
   */
  requiresModule?:
    | "files"
    | "email"
    | "calendar"
    | "projects"
    | "knowledge"
    | "docs"
    | "cameras"
    | "network"
    | "smart_home"
    | "managed_switch"
    | "voice"
    | "team_chat";
  /**
   * WARP-1807 — a tucked destination: rendered by NO nav surface (desktop
   * aside, mobile tab bar, More drawer), but still part of the nav
   * definition so `moduleForPath` keeps claiming its route (the WARP-1528
   * gap-(c) gate must not regress) and the label/icon stay canonical.
   * Reachable from Settings instead.
   */
  hidden?: boolean;
  /**
   * WARP-1683 — named live-count badge rendered on the item (desktop
   * sidebar + mobile More drawer). The KEY lives here so nav-config stays
   * the one source of truth for what the nav shows; the VALUE is resolved
   * by the Sidebar (which owns the polling hooks) — pure data, no hook in
   * this module. Rendered only when the resolved count is > 0.
   */
  badgeKey?: "teamChatUnread";
  /**
   * Nested sub-navigation. When present, the desktop sidebar reveals these
   * children indented under the parent whenever the user is anywhere inside
   * the parent section (the parent's href OR any child's href). Mirrors the
   * Files sub-nav pattern, generalized so any section can nest (e.g. Events
   * under Cameras). Children are rendered flat in the mobile "More" drawer so
   * every destination stays reachable with a single tap.
   */
  children?: NavItem[];
  /**
   * Match this item's active state by exact path equality instead of the
   * default `startsWith` prefix match. Used by section-index sub-items (e.g.
   * the Cameras index sits at /cameras, but /events is a sibling child — the
   * index must not light up when a deeper child route is active).
   */
  exact?: boolean;
};

export type AuthRole = "owner" | "admin" | "family" | "guest";

export type NavGroup = {
  /** Caption shown above the group (sentence case is intentional — the
   *  caption is rendered with `uppercase tracking-[0.18em] type-caption-1`
   *  so we let CSS handle the visual upper-casing instead of duplicating
   *  it in copy). */
  label: string;
  items: NavItem[];
};

/* ─────────── Nav definition (re-pointed 2026-05-18 from flat lists) ───────────
   Groups mirror the redesign's Workspace / Operations / Admin IA.
   Routes are unchanged — only labels and grouping are new. WARP-1341:
   business-only build, so the landing surface is labelled "Overview"
   (route stays "/"). */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/chat", label: "Ask AI", icon: MessageSquare },
      // WARP-1683: member-to-member team chat. Sits next to Ask AI (both
      // are conversation surfaces); gated by the team_chat module and
      // carrying the unread-count badge the Sidebar resolves.
      {
        href: "/messages",
        label: "Messages",
        icon: MessagesSquare,
        requiresModule: "team_chat",
        badgeKey: "teamChatUnread",
      },
      {
        href: "/files",
        label: "Files",
        icon: FolderOpen,
        requiresModule: "files",
        // Files sub-nav — the original nesting, now expressed via the
        // generalized `children` mechanism (was the standalone filesSubNav
        // const). Reveals on any /files/* route. "All files" is `exact` so
        // it doesn't stay lit while you're in a deeper Files view.
        children: [
          { href: "/files", label: "All files", icon: FolderOpen, exact: true },
          { href: "/files/drives", label: "Drives", icon: HardDrive },
          { href: "/files/recents", label: "Recents", icon: Clock },
          { href: "/files/favorites", label: "Favorites", icon: Star },
          { href: "/files/shared", label: "Shared", icon: Share2 },
          { href: "/files/trash", label: "Trash", icon: Trash2 },
          { href: "/files/devices", label: "Sync Devices", icon: Laptop },
        ],
      },
      // WARP-837: Email triage surface. Left unrestricted — the backend allows
      // owner/admin/family and RBAC-scopes accounts per user; the send tier is
      // gated to owner/admin in the UI + server. No unread-count badge (the
      // NavItem type has no count field; out of scope).
      { href: "/email", label: "Email", icon: Mail, requiresModule: "email" },
      { href: "/calendar", label: "Calendar", icon: CalendarIcon, requiresModule: "calendar" },
      // ADR-026: native PM surface — sits next to Calendar (both are
      // time/workflow-oriented) and ahead of Knowledge (the read-only search
      // index). Page at /projects renders natively off /api/pm/* under the
      // dashboard session — no embedded stack, no second login.
      // WARP-1154/1155: hidden when the orchestrator says the Projects module
      // is off, so the nav never advertises a surface the box won't serve.
      { href: "/projects", label: "Projects", icon: FolderKanban, requiresModule: "projects" },
      // WARP-1807: tucked — not daily operation; reachable from Settings → Advanced.
      {
        href: "/knowledge",
        label: "Knowledge",
        icon: BookOpen,
        requiresModule: "knowledge",
        hidden: true,
      },
      // WARP-225: per-user context-meter. Lives next to Knowledge so the
      // eye reads them paired — /knowledge is "what's indexed" by file,
      // /context is "what's indexed" by capability density.
      // WARP-1807: tucked — not daily operation; reachable from Settings → Advanced.
      { href: "/context", label: "Context", icon: Sparkles, hidden: true },
    ],
  },
  {
    label: "Operations",
    items: [
      // Cameras owns the surveillance section. Events nests beneath it
      // (Samantha QA #bugs) — they were flat siblings, which read as two
      // unrelated destinations. The sub-nav reveals on /cameras or /events
      // (mirrors the Files sub-nav). The Cameras parent link IS the section
      // index; its default prefix match keeps it lit on /cameras and the
      // /cameras/[name] detail pages, but NOT on the /events sibling (which
      // owns its own active state).
      {
        href: "/cameras",
        label: "Cameras",
        icon: Video,
        requiresModule: "cameras",
        children: [
          // Events replaces the old "Clips" entry — same icon, expanded UX.
          // The /clips route still resolves (kept as a redirect) so external
          // links and the LLM tool list_clips don't 404.
          { href: "/events", label: "Events", icon: Film },
        ],
      },
      { href: "/network", label: "Network", icon: Network, requiresModule: "network" },
      // WARP-302: "Devices" uses Cpu so it doesn't visually collide with
      // the Overview tab's LayoutDashboard glyph at thumb distance.
      { href: "/devices", label: "Devices", icon: Cpu, requiresModule: "smart_home" },
      // WARP-1055: mic health + guided calibration. A peer surface, not
      // a Settings subpage — calibration is living, health-bearing state
      // (design brief §2). Ordered Cameras · Network · Devices · Voice.
      { href: "/voice", label: "Voice", icon: Mic, requiresModule: "voice" },
      { href: "/remote-access", label: "Remote Access", icon: Globe, requiresModule: "network" },
      // WARP-1101: Integrations hub + per-provider ERP surfaces. Eaglesoft is
      // provider #1 (the Patterson dental PMS Droplet reads directly over its
      // SQL Anywhere DB, on the LAN). The child reveals on /integrations/*.
      // WARP-1528 (nav-gate gap b): this item shipped with NO gate at all
      // while the orchestrator's erp.ts + integrations.ts both require
      // owner/admin — so family/guest were shown a hub that 403s. Mirrors the
      // server guard, exactly like /admin/files does. There is no `integrations`
      // module in the registry (connector reach is ADR-032's §5.4 connectors
      // axis, not the feature axis), so `roles` — not `requiresModule` — is the
      // honest gate; the child carries it too, so a future role widening on one
      // can't silently widen the other.
      {
        href: "/integrations",
        label: "Integrations",
        icon: Blocks,
        roles: ["owner", "admin"],
        children: [
          {
            href: "/integrations/eaglesoft",
            label: "Eaglesoft",
            icon: Stethoscope,
            roles: ["owner", "admin"],
          },
        ],
      },
    ],
  },
  {
    label: "Admin",
    items: [
      // /users is the existing People surface. Label kept as "Users" in
      // Phase 1 so the WARP-290 a11y test contract (queries by /users/i)
      // doesn't regress; Phase 3 renames to "People" alongside test
      // updates and adds the full Roles / Groups / Sessions entries
      // with workspace:"business" set.
      { href: "/users", label: "Users", icon: Users },
      // WARP-1270 (T18): company-wide storage usage roster (people +
      // libraries). Owner/admin — mirrors the server-side
      // `requireRole("owner","admin")` gate on GET /api/admin/files/usage.
      {
        href: "/admin/files",
        label: "Company files",
        icon: FolderLock,
        roles: ["owner", "admin"],
      },
      // WARP-555: read-only catalog of the assistant's built-in tools.
      // No role restriction — the /api/llm/tools/catalog route filters
      // write tools out for non-privileged roles, so family/guest see a
      // safe read-only subset. Visible in both workspaces.
      { href: "/tools", label: "Tools", icon: Wrench },
      // WARP-836: read-only Models status surface (local LLMs + opt-in cloud).
      // Unrestricted — GET /api/models is open to any authenticated principal
      // (ADR-004 §3), so family/guest see the same status-only view. Reuses the
      // Cpu glyph already imported for /devices. Active-state is automatic.
      { href: "/models", label: "Models", icon: Cpu },
      { href: "/settings", label: "Settings", icon: Settings },
      // PR #382: appliance/service health status page. Reads the existing
      // WARP-43 aggregate; sits in the support/reference zone next to Help.
      { href: "/health", label: "Health", icon: HeartPulse },
      // WARP-174: customer-facing manual + "How Droplet works" replay
      // modal. Sits next to Settings — same "support / reference" zone.
      { href: "/help", label: "Help", icon: HelpCircle },
      // WARP-279: admin-only Activity log entry. Role-gated AND hidden unless
      // GitHub/Jira is configured (capabilities.claudeActivity) — #14.
      {
        href: "/admin/claude-activity",
        label: "Activity",
        icon: Activity,
        roles: ["owner", "admin"],
        requiresCapability: "claudeActivity",
      },
      // WARP-519: ad-hoc RAGAS run + baseline bootstrap trigger surface.
      // Hidden unless RAG_EVAL_URL is set (capabilities.ragEval) — #15.
      {
        href: "/admin/rag-eval",
        label: "RAG eval",
        icon: FlaskConical,
        roles: ["owner", "admin"],
        requiresCapability: "ragEval",
      },
      // WARP-246: signed activity log viewer. Role-gated to owner/admin
      // (mirrors the orchestrator's owner/admin gate on /api/activity);
      // no capability gate — the activity surface always exists.
      {
        href: "/admin/audit",
        label: "Audit log",
        icon: ScrollText,
        roles: ["owner", "admin"],
      },
      // WARP-246: Trust Center placeholder — visible to every signed-in
      // member (support/reference zone, next to Help).
      { href: "/trust", label: "Trust Center", icon: ShieldCheck },
    ],
  },
];

// Mobile bottom tab bar — capped at 4 + a "More" trigger. Per WARP-290
// the cap is iOS convention (7 tabs at 360px crowded each label to
// ~51px). The four hrefs below win a tab spot; the fifth slot is the
// "More" trigger that opens the drawer (see below). Everything else
// from NAV_GROUPS routes through the drawer.
export const MOBILE_PRIMARY_HREFS = ["/", "/chat", "/files", "/devices"] as const;

/** Filter a group's items by role + capabilities. Returns the same
 *  shape with items shaped to render order; empty groups are caller's
 *  responsibility to skip.
 *
 *  WARP-1528: the same predicate is now applied to `children` too, so a child's
 *  own gate is real. Children are filtered rather than inherited-wholesale,
 *  which closes nav-gate gap (a); a hidden parent still takes its whole subtree
 *  with it (the parent is dropped before its children are ever considered).
 *  Every rendered surface derives from this one function — the desktop aside,
 *  the mobile bottom tab bar, and the More drawer — so all three inherit any
 *  gate exactly once. Exported for the gap-(a) unit pins. */
export function visibleItems(
  items: NavItem[],
  role: AuthRole | undefined,
  capabilities: { claudeActivity: boolean; ragEval: boolean },
  isModuleOn: (moduleId: string) => boolean,
): NavItem[] {
  const allowed = (item: NavItem): boolean => {
    // WARP-1807: a tucked item renders on no surface regardless of what its
    // other gates would say — Settings owns the way in. Children run this
    // same predicate, so a hidden child drops too.
    if (item.hidden) return false;
    if (item.roles && (!role || !item.roles.includes(role))) return false;
    if (item.requiresCapability && !capabilities[item.requiresCapability])
      return false;
    // WARP-1397: hide a switched-off feature's nav entry (module not effective).
    // WARP-1528: "effective" is now per person, not just per box.
    if (item.requiresModule && !isModuleOn(item.requiresModule)) return false;
    return true;
  };
  return items.filter(allowed).map((item) =>
    item.children ? { ...item, children: item.children.filter(allowed) } : item,
  );
}

/**
 * WARP-1528 (nav-gate gap c) — which module, if any, OWNS a dashboard path.
 *
 * Derived from the one nav definition above rather than a second table, so a
 * route can never drift out of sync with the entry that leads to it. Children
 * inherit their parent's module unless they name their own; the longest
 * matching href wins, and matching is SEGMENT-aware (`/network` must not claim
 * `/networking-guide`).
 *
 * Returns `null` for the always-on surfaces and for any route no module claims
 * — those are never blockable. Design §9 note (c): `chat`, `home` and personal
 * `settings` refuse full gating (self-integrity + self-lockout). They carry no
 * `requiresModule` today; the explicit list below makes that a guarantee
 * instead of an accident.
 */
const ALWAYS_ON_PATHS = ["/", "/chat", "/settings"] as const;

function pathMatches(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface GatedRoute {
  moduleId: string;
  /** The nav label of the section that owns the route — used for honest copy. */
  label: string;
  /** That section's own glyph, so the blocked state can identify the surface
   *  without a padlock. A lock would assert a REASON ("you're not allowed"),
   *  and the server deliberately makes a per-person denial indistinguishable
   *  from a box-wide toggle — the UI must not undo that. */
  icon: LucideIcon;
}

export function moduleForPath(pathname: string): GatedRoute | null {
  for (const p of ALWAYS_ON_PATHS) {
    if (pathMatches(pathname, p)) return null;
  }
  let bestHref = "";
  let best: GatedRoute | null = null;
  const consider = (
    href: string,
    moduleId: string | undefined,
    owner: NavItem,
  ) => {
    if (!moduleId) return;
    if (!pathMatches(pathname, href)) return;
    if (best !== null && href.length <= bestHref.length) return;
    bestHref = href;
    best = { moduleId, label: owner.label, icon: owner.icon };
  };
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      consider(item.href, item.requiresModule, item);
      for (const child of item.children ?? []) {
        // A child with no module of its own is part of its parent's section,
        // so it inherits the gate, the name AND the glyph from the parent.
        consider(
          child.href,
          child.requiresModule ?? item.requiresModule,
          child.requiresModule ? child : item,
        );
      }
    }
  }
  return best;
}

