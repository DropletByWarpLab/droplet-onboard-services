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

import type { AccessModuleId } from "@/lib/types";
import {
  Activity,
  Blocks,
  BookOpen,
  Building2,
  Calendar as CalendarIcon,
  ChartColumn,
  Repeat,
  Cpu,
  Download,
  Film,
  FlaskConical,
  FolderKanban,
  Receipt,
  FolderLock,
  FolderOpen,
  Globe,
  Hammer,
  HeartPulse,
  HelpCircle,
  Laptop,
  Lightbulb,
  LayoutDashboard,
  Mail,
  MessageSquare,
  MessagesSquare,
  Mic,
  Network,
  KeyRound,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Trash2,
  Clock,
  Share2,
  Bot,
  ServerCog,
  Users,
  Video,
  Wrench,
} from "lucide-react";

/**
 * WARP-2967 — the sections of the Settings front door, in render order.
 *
 * Five, from the sidebar-UX reference's contextual-panel practice
 * (`shared_brain/research/design/sidebar-ux-reference`, rule 4): who can sign
 * in, what the business shares, what runs by itself, what the box is, and the
 * diagnostics you only open when something is wrong. A section with nothing
 * visible in it is dropped rather than captioned empty.
 */
export const SETTINGS_SECTIONS = [
  "Account",
  "Workspace",
  "Automation",
  "System",
  "Advanced",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

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
   *
   * WARP-2880: `medicalConnector` is resolved by the Sidebar from GET
   * /api/integrations (a connected practice-management system — see
   * `isMedicalConnector`), not from /api/admin/capabilities. Same gate, same
   * fail-closed posture: hidden until positively known.
   */
  requiresCapability?: "claudeActivity" | "ragEval" | "medicalConnector";
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
   *
   * WARP-2577: this was a hand-listed union, and it drifted exactly as a
   * parallel list does. It named twelve ids while `AccessModuleId` carried
   * fifteen; WARP-2558 then added `crm` to it by hand, because the CRM had
   * just earned a route to gate — leaving `contacts` still missing and the
   * next module still owing someone a second edit.
   *
   * It is now DERIVED from `AccessModuleId`, the vocabulary that describes
   * itself as having no parallel list to drift. This union was that list, so
   * a module id reaches this field the day it is declared and nobody has to
   * remember.
   *
   * `chat` is excluded rather than omitted. It is a core module — the comment
   * above says core modules are never tagged — and `Exclude` states that rule
   * where the type is, instead of leaving it as an absence a reader has to
   * notice. Adding a module id now reaches this field automatically; making a
   * module core is the only edit that ever needs to touch it again.
   */
  requiresModule?: Exclude<AccessModuleId, "chat">;
  /**
   * WARP-1807 — a tucked destination: rendered by NO nav surface (desktop
   * aside, mobile tab bar, More drawer), but still part of the nav
   * definition so `moduleForPath` keeps claiming its route (the WARP-1528
   * gap-(c) gate must not regress) and the label/icon stay canonical.
   * Reachable from Settings instead.
   */
  hidden?: boolean;
  /**
   * WARP-2967 — which section of the Settings front door carries this item.
   *
   * REQUIRED on every `hidden` item and forbidden on every visible one, both
   * pinned in `nav-config.four-groups.test.ts`. The tuck and the way back in
   * are one decision, and splitting them across two files is how WARP-1807's
   * Knowledge row nearly shipped without its Settings link: nothing breaks,
   * builds or type-checks when a tucked surface has no door — it simply
   * becomes unreachable.
   *
   * The contextual sidebar panel and the Settings page's link rows are BOTH
   * derived from this, so there is one list and it cannot disagree with
   * itself.
   */
  settingsSection?: SettingsSection;
  /**
   * WARP-2967 — the one-line "what is this" shown beside a tucked item's row
   * on the Settings page. Ships WITH `settingsSection` (pinned together) so a
   * row can never read as a bare noun the reader has to click to understand.
   *
   * Period-free noun-phrase fragments, matching the neighbouring hand-written
   * rows (Voice, Software updates, Storage) — the WARP-1807 review's call.
   *
   * The sidebar panel does NOT render it: the rail has no room for a second
   * line, and the panel is a list you already know your way around.
   */
  settingsBlurb?: string;
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

/* ─────────── Nav definition ───────────────────────────────────────────────
   WARP-2967 — four groups and a Settings front door:

     WORK      Overview · Ask AI · Files · Messages · Email · Calendar
     BUSINESS  Insights [Brief, Reports] · Customers · Projects [Money] · Practice
     SYSTEMS   Cameras [Events] · Network [Voice, Remote access] · Devices
     ADMIN     Settings

   ~14 rows all-on, ~11 on a typical box. Everything else keeps its route and
   moves behind Settings as the WARP-1807 tuck — `hidden: true` plus a
   `settingsSection`, which is what `settingsGroups()` below renders from.

   ROUTES ARE UNCHANGED. Nothing here redirects, renames a path or 404s; the
   only things that moved are captions, nesting and which surface shows what.
   WARP-1341: business-only build, so the landing surface is "Overview"
   (route stays "/"). */
export const NAV_GROUPS: NavGroup[] = [
  // WARP-2967 — WORK. The things a person opens to do their job. Six rows,
  // ordered by how often a working day touches them, and every one of them is
  // somewhere you *go*, never something you *configure*.
  {
    label: "Work",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/chat", label: "Ask AI", icon: MessageSquare },
      {
        href: "/files",
        label: "Files",
        icon: FolderOpen,
        requiresModule: "files",
        // Files sub-nav. WARP-2966 cut it from six rows to three, because six
        // was not one idea: an "All files" row whose href WAS the parent's,
        // four places inside the tree, and a device-pairing screen.
        //
        // What is left is the one thing the caption can honestly name — the
        // places a file can be that are not a folder. Reveals on any /files/*
        // route; the Libraries rail (FilesLibrariesNav) is appended beneath.
        //
        // Three rows are gone and each went somewhere:
        //  · "All files" was `{ href: "/files", exact: true }` — a child whose
        //    href is its own parent's. The parent link IS Browse, so the row
        //    said the same word twice and the section read as a container of
        //    itself.
        //  · Favorites is not a place, it is a FILTER over the places below.
        //    It lives on /files' own toolbar now; the route is untouched and
        //    still claimed by this item's `files` module through the /files
        //    prefix (see the WARP-2966 pin in Sidebar.files-section.test.tsx).
        //  · Sync Devices left Files entirely — see the tucked entry below.
        children: [
          { href: "/files/recents", label: "Recent", icon: Clock },
          { href: "/files/shared", label: "Shared", icon: Share2 },
          { href: "/files/trash", label: "Trash", icon: Trash2 },
        ],
      },
      // WARP-1683: member-to-member team chat. Sits next to Ask AI and Files
      // (the three surfaces a working day actually lives in); gated by the
      // team_chat module and carrying the unread-count badge the Sidebar
      // resolves.
      {
        href: "/messages",
        label: "Messages",
        icon: MessagesSquare,
        requiresModule: "team_chat",
        badgeKey: "teamChatUnread",
      },
      // WARP-837: Email triage surface. Left unrestricted — the backend allows
      // owner/admin/family and RBAC-scopes accounts per user; the send tier is
      // gated to owner/admin in the UI + server. No unread-count badge (the
      // NavItem type has no count field; out of scope).
      { href: "/email", label: "Email", icon: Mail, requiresModule: "email" },
      { href: "/calendar", label: "Calendar", icon: CalendarIcon, requiresModule: "calendar" },

      /* ── tucked out of Work (WARP-1807 / WARP-2966 / WARP-2967) ────────
         Rendered by no nav surface; Settings owns the way in. Each keeps its
         route, its gates and its glyph, and names the Settings section that
         carries it — see `settingsGroups` below. */

      // WARP-1807: not daily operation. Reachable from Settings → Advanced.
      {
        href: "/knowledge",
        label: "Knowledge",
        icon: BookOpen,
        requiresModule: "knowledge",
        hidden: true,
        settingsSection: "Advanced",
        settingsBlurb: "What's indexed for retrieval",
      },
      // WARP-225: per-user context-meter. Lives next to Knowledge so the
      // eye reads them paired — /knowledge is "what's indexed" by file,
      // /context is "what's indexed" by capability density.
      {
        href: "/context",
        label: "Context",
        icon: Sparkles,
        hidden: true,
        settingsSection: "Advanced",
        settingsBlurb: "Indexing coverage and pipeline health",
      },
      // WARP-2966 (files-surface addendum §2.3) — Sync Devices manages
      // sync-client pairing. It has no path, no listing and no library, so it
      // cannot answer "where am I"; keeping it in a rail of locations made the
      // rail mean two things.
      //
      // `requiresModule: "files"` is stated rather than inherited: it was a
      // child of Files and took the parent's gate, so promoting it to top
      // level without this would turn the files module off and leave the
      // pairing screen reachable from Settings.
      {
        href: "/files/devices",
        label: "Sync devices",
        icon: Laptop,
        requiresModule: "files",
        hidden: true,
        settingsSection: "Workspace",
        settingsBlurb: "Computers mirroring a folder with this Droplet",
      },
      // WARP-2671 / WARP-2925 — Routines and Workshop. Both are a person's own
      // work, not admin artefacts, which is why WARP-2671 fought to keep
      // Routines out of Admin and away from /tools. WARP-2967 does not undo
      // that argument: they are tucked because they are not DAILY, and they
      // land under Settings → **Automation**, their own section — not folded
      // under Ask AI, which would make a composed sequence look like a mode of
      // the chat box.
      //
      // Role-gated rather than module-gated: both compose tools from every
      // surface, so there is no single module whose absence should hide them.
      {
        href: "/routines",
        label: "Routines",
        icon: Repeat,
        roles: ["owner", "admin", "family"],
        hidden: true,
        settingsSection: "Automation",
        settingsBlurb: "Sequences the box runs on a schedule or a trigger",
      },
      // owner/admin only — mirrors RUN_STARTER_ROLES on the agent-runs routes,
      // the guard that actually decides; this only keeps the nav from offering
      // a page that would 403.
      {
        href: "/workshop",
        label: "Workshop",
        icon: Hammer,
        roles: ["owner", "admin"],
        hidden: true,
        settingsSection: "Automation",
        settingsBlurb: "Give the box a goal and watch the run that pursues it",
      },
    ],
  },
  // WARP-2558 (ADR-044) — the Business group.
  //
  // Three systems describe the same business: who you sell to (CRM), the work
  // you deliver (PM), and the practice you run day to day (the ERP surface).
  // Grouping them says they are one subject without merging them into one
  // page — the rejected shape, which only pushes the container-is-its-own-child
  // problem down a level.
  //
  // Two rules this group holds:
  //
  //  1. A tab never renames itself. Each entry's `label` is constant; turning
  //     a module on may ADD an entry, never rebrand one.
  //  2. Every entry survives its neighbours being off. `visibleItems` already
  //     filters per item and Sidebar drops empty groups, so a CRM-only box
  //     shows Customers alone and a Projects-only box shows Projects alone.
  {
    label: "Business",
    items: [
      // WARP-2561 (ADR-044) / WARP-2967 — Insights: the group's front door.
      //
      // Relabelled from "Planning" because it now carries Brief and Reports
      // beneath it, and those three answer the same question at three tenses —
      // what is coming, what the box noticed, how it went. "Planning" named
      // only the first of them, so the parent would have been one of its own
      // children. Rule 1 above is about a label changing with a MODULE; this
      // is a deliberate rename shipped with the re-grouping, and the page
      // header moves with it.
      //
      // Role-gated and NOT module-gated: it composes tiles from separately
      // gated sources and each degrades on its own, so a module gate here
      // would delete the whole page because one tile's module is off. There is
      // deliberately no `business` module — a ModuleId value costs a Prisma
      // enum migration plus six mirrored sites, to buy a gate this page must
      // not have.
      {
        href: "/business",
        label: "Insights",
        icon: Sparkles,
        roles: ["owner", "admin", "family"],
        children: [
          // WARP-2752 (ADR-051) — Brief: what the box NOTICED.
          //
          // owner/admin only, and narrower than its parent on purpose: a
          // finding can be derived from the whole-company corpus, and ADR-051
          // §9 puts that scope behind those two roles. Kept verbatim through
          // the move — `visibleItems` runs a child's own gates as well as its
          // parent's (WARP-1528).
          //
          // NOT capability-gated on the brain either (WARP-2838): /brief's off
          // state is the only place in the product that can turn the brain ON,
          // so gating the entry on the brain being on would make the switch
          // reachable only once it no longer needed pressing.
          {
            href: "/brief",
            label: "Brief",
            icon: Lightbulb,
            roles: ["owner", "admin"],
          },
          // WARP-1992 → WARP-2967. Reports was pinned as a PEER of Overview
          // ("the how-did-it-go view next to the what's-happening-now view").
          // That argument put it in the wrong group: it is a business report,
          // and it now sits beside Brief under Insights, where the three
          // tenses read together. Same role gate, still no module gate — it
          // composes ten separately-gated tiles and each degrades on its own.
          {
            href: "/reports",
            label: "Reports",
            icon: ChartColumn,
            roles: ["owner", "admin", "family"],
          },
        ],
      },
      // The CRM's own door. Before ADR-044 it had `navHrefs: []` and rendered
      // as sub-tabs on /projects, which made CRM-without-PM unrepresentable —
      // and that is the shape of most dental boxes.
      {
        href: "/customers",
        label: "Customers",
        icon: Building2,
        requiresModule: "crm",
      },
      // ADR-026: native PM surface, rendered off /api/pm/* under the dashboard
      // session — no embedded stack, no second login. WARP-1154/1155: hidden
      // when the orchestrator says the Projects module is off.
      {
        href: "/projects",
        label: "Projects",
        icon: FolderKanban,
        requiresModule: "projects",
        children: [
          // WARP-2581 / WARP-2967 — what the business is owed and what it owes,
          // landed from a connected ledger. Keeps its own `money` module gate.
          //
          // Nesting DOES add its parent's gate on top: `visibleItems` drops a
          // parent before its children are considered, so a box with a ledger
          // but no PM module now shows no Money row. That is a real narrowing,
          // taken knowingly — the alternative is a top-level Money row that
          // reads as a peer of Customers, which is the flatness this ticket
          // exists to remove. Money without Projects is reachable from its
          // route and from the Workspace tabs layout.
          { href: "/money", label: "Money", icon: Receipt, requiresModule: "money" },
        ],
      },
      // WARP-2560 (ADR-044) — the practice's day: schedule, KPIs, patient
      // lookup. Gated by `roles` and NOT by `requiresModule`, because there is
      // no `erp` module and connector reach is ADR-032 §5.4's connectors axis,
      // not the feature axis. The label is a fixed word on purpose (ADR-044
      // records the per-connector `partyNoun` as a later slice).
      //
      // WARP-2880: shown only while a MEDICAL integration is connected. Rule 1
      // above holds — the entry is ADDED or REMOVED with the connection, never
      // relabelled.
      {
        href: "/practice",
        label: "Practice",
        icon: Stethoscope,
        roles: ["owner", "admin"],
        requiresCapability: "medicalConnector",
      },
    ],
  },
  // WARP-2967 — SYSTEMS, renamed from "Operations". Three rows: the hardware
  // the box watches, the network it runs, and the things on it. "Operations"
  // had come to mean "everything that is not a document", which is how it
  // collected the integrations hub and a credentials configurator — plumbing
  // you set up once, not a place you operate from. Those moved to Settings.
  {
    label: "Systems",
    items: [
      // Cameras owns the surveillance section. Events nests beneath it
      // (Samantha QA #bugs) — they were flat siblings, which read as two
      // unrelated destinations. The Cameras parent link IS the section index;
      // its default prefix match keeps it lit on /cameras and the
      // /cameras/[name] detail pages, but NOT on the /events sibling.
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
      {
        href: "/network",
        label: "Network",
        icon: Network,
        requiresModule: "network",
        children: [
          // WARP-1055 / WARP-2967 — mic health + guided calibration. It was a
          // peer surface ("calibration is living, health-bearing state", design
          // brief §2) and it stays one — it is simply filed under the subsystem
          // it belongs to instead of beside it.
          //
          // As with Money above, nesting adds the parent's gate: `voice` now
          // also needs `network` on. Voice hardware on a box with networking
          // switched off is not a state this product ships.
          { href: "/voice", label: "Voice", icon: Mic, requiresModule: "voice" },
          // Already carried `requiresModule: "network"` — the same gate as its
          // new parent, so nesting changes nothing for it.
          {
            href: "/remote-access",
            label: "Remote access",
            icon: Globe,
            requiresModule: "network",
          },
        ],
      },
      // WARP-302: "Devices" uses Cpu so it doesn't visually collide with
      // the Overview tab's LayoutDashboard glyph at thumb distance. Stays
      // top-level: it owns a mobile bottom tab (MOBILE_PRIMARY_HREFS), which
      // is resolved against top-level items only.
      { href: "/devices", label: "Devices", icon: Cpu, requiresModule: "smart_home" },

      /* ── tucked out of Systems (WARP-2967) ──────────────────────────── */

      // WARP-1101 — the Integrations hub: connecting, credentials, connection
      // status. Connecting a connector is something you do once per connector,
      // which is configuration, not operation.
      //
      // WARP-1528 (nav-gate gap b): this item shipped with NO gate at all
      // while the orchestrator's erp.ts + integrations.ts both require
      // owner/admin. There is no `integrations` module in the registry
      // (connector reach is ADR-032 §5.4's connectors axis), so `roles` — not
      // `requiresModule` — is the honest gate.
      {
        href: "/integrations",
        label: "Integrations",
        icon: Blocks,
        roles: ["owner", "admin"],
        hidden: true,
        settingsSection: "Workspace",
        settingsBlurb: "Connect the services this business already uses",
      },
      // WARP-2275 — the SaaS credential configurator. WARP-2968 made it a
      // SIBLING rather than a child of Integrations, because `isSectionOpen`
      // reveals children only once the section is open and a destination you
      // can only reach by guessing what it is behind is not in the nav. It
      // stays a sibling here: both are rows of the same Settings section, so
      // neither hides behind the other.
      //
      // `roles` on both entries, for the same reason it was on both before —
      // a future widening of one must not silently widen the other.
      {
        href: "/integrations/credentials",
        label: "Credentials",
        icon: KeyRound,
        roles: ["owner", "admin"],
        hidden: true,
        settingsSection: "Workspace",
        settingsBlurb: "API keys and sign-ins for connected services",
      },
    ],
  },
  // WARP-2967 — ADMIN is one row now: the front door.
  //
  // It held thirteen. Every one of them keeps its route and its gates and
  // moves behind Settings, which renders them as a contextual panel in the
  // sidebar (see `settingsGroups`) and as link rows on the Settings page. The
  // reference practice this implements: "Settings gets its own contextual
  // panel with a back link rather than 14 admin rows in the main tree"
  // (shared_brain/research/design/sidebar-ux-reference, rule 4).
  {
    label: "Admin",
    items: [
      { href: "/settings", label: "Settings", icon: Settings },

      /* ── tucked behind Settings (WARP-2967) ─────────────────────────── */

      // The console's front door. /admin used to 404 and the pages beneath it
      // were reachable only by typing their URLs.
      //
      // `exact: true` on purpose: the default startsWith match would keep this
      // entry lit while the operator is on /admin/audit or /admin/files.
      //
      // Carries no `requiresModule` — deliberately. moduleForPath() picks the
      // longest matching href, so an /admin entry with a module would start
      // claiming every /admin/* route and ModuleRouteGuard would blank all of
      // them on a positive denial.
      {
        href: "/admin",
        label: "Console",
        icon: ServerCog,
        exact: true,
        roles: ["owner", "admin"],
        hidden: true,
        settingsSection: "System",
        settingsBlurb: "The operator console for this appliance",
      },
      // WARP-2823 — the prompt + tool inspector. No `requiresModule`, because
      // a page whose whole job is explaining why the assistant cannot reach
      // something must not itself disappear when a module is switched off.
      // Filed under Automation: it explains what the automated surfaces can do.
      {
        href: "/admin/prompt",
        label: "Assistant",
        icon: Bot,
        roles: ["owner", "admin"],
        hidden: true,
        settingsSection: "Automation",
        settingsBlurb: "What the assistant is told, and which tools it can reach",
      },
      // /users is the existing People surface. Label kept as "Users" so the
      // WARP-290 a11y test contract (queries by /users/i) doesn't regress.
      {
        href: "/users",
        label: "Users",
        icon: Users,
        hidden: true,
        settingsSection: "Account",
        settingsBlurb: "People who can sign in, and what each of them may do",
      },
      // WARP-1270 (T18): company-wide storage usage roster (people +
      // libraries). Owner/admin — mirrors the server-side
      // `requireRole("owner","admin")` gate on GET /api/admin/files/usage.
      {
        href: "/admin/files",
        label: "Company files",
        icon: FolderLock,
        roles: ["owner", "admin"],
        hidden: true,
        settingsSection: "Workspace",
        settingsBlurb: "Storage used per person and per library",
      },
      // WARP-555: read-only catalog of the assistant's built-in tools. No role
      // restriction — the /api/llm/tools/catalog route filters write tools out
      // for non-privileged roles, so family/guest see a safe read-only subset.
      {
        href: "/tools",
        label: "Tools",
        icon: Wrench,
        hidden: true,
        settingsSection: "System",
        settingsBlurb: "The assistant's built-in tools, read-only",
      },
      // WARP-836: read-only Models status surface (local LLMs + opt-in cloud).
      // Unrestricted — GET /api/models is open to any authenticated principal
      // (ADR-004 §3), so family/guest see the same status-only view.
      {
        href: "/models",
        label: "Models",
        icon: Cpu,
        hidden: true,
        settingsSection: "System",
        settingsBlurb: "Local models and any cloud provider you opted into",
      },
      // PR #382: appliance/service health status page. Reads the existing
      // WARP-43 aggregate.
      {
        href: "/health",
        label: "Health",
        icon: HeartPulse,
        hidden: true,
        settingsSection: "System",
        settingsBlurb: "Live status of every service on the box",
      },
      // Client-app downloads. No `roles` gate and no `requiresModule` — every
      // authenticated member needs the app for the box they were invited to,
      // and GET /api/app-downloads makes the same call.
      {
        href: "/downloads",
        label: "Get the app",
        icon: Download,
        hidden: true,
        settingsSection: "System",
        settingsBlurb: "Desktop and mobile apps for this Droplet",
      },
      // WARP-246: Trust Center placeholder — visible to every signed-in member.
      {
        href: "/trust",
        label: "Trust Center",
        icon: ShieldCheck,
        hidden: true,
        settingsSection: "System",
        settingsBlurb: "How this box handles your data, in plain terms",
      },
      // WARP-174: customer-facing manual + "How Droplet works" replay modal.
      {
        href: "/help",
        label: "Help",
        icon: HelpCircle,
        hidden: true,
        settingsSection: "System",
        settingsBlurb: "The manual, and a replay of how Droplet works",
      },
      // WARP-246: signed activity log viewer. Role-gated to owner/admin
      // (mirrors the orchestrator's owner/admin gate on /api/activity); no
      // capability gate — the activity surface always exists.
      {
        href: "/admin/audit",
        label: "Audit log",
        icon: ScrollText,
        roles: ["owner", "admin"],
        hidden: true,
        settingsSection: "Advanced",
        settingsBlurb: "The signed record of everything the box did",
      },
      // WARP-279: admin-only Activity log entry. Role-gated AND hidden unless
      // GitHub/Jira is configured (capabilities.claudeActivity) — #14.
      {
        href: "/admin/claude-activity",
        label: "Activity",
        icon: Activity,
        roles: ["owner", "admin"],
        requiresCapability: "claudeActivity",
        hidden: true,
        settingsSection: "Advanced",
        settingsBlurb: "What the assistant has been working on",
      },
      // WARP-519: ad-hoc RAGAS run + baseline bootstrap trigger surface.
      // Hidden unless RAG_EVAL_URL is set (capabilities.ragEval) — #15.
      {
        href: "/admin/rag-eval",
        label: "RAG eval",
        icon: FlaskConical,
        roles: ["owner", "admin"],
        requiresCapability: "ragEval",
        hidden: true,
        settingsSection: "Advanced",
        settingsBlurb: "Retrieval-quality runs against a baseline",
      },
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
  capabilities: NavCapabilities,
  isModuleOn: (moduleId: string) => boolean,
): NavItem[] {
  const allowed = (item: NavItem): boolean =>
    // WARP-1807: a tucked item renders on no surface regardless of what its
    // other gates would say — Settings owns the way in. Children run this
    // same predicate, so a hidden child drops too.
    !item.hidden && passesGates(item, role, capabilities, isModuleOn);
  return items.filter(allowed).map((item) =>
    item.children ? { ...item, children: item.children.filter(allowed) } : item,
  );
}

/** The resolved capability flags a nav gate reads — the admin capabilities
 *  endpoint's two plus the WARP-2880 `medicalConnector` the Sidebar derives
 *  from /api/integrations. Named so a second nav surface can take the same
 *  shape without restating the union. */
export type NavCapabilities = Record<
  NonNullable<NavItem["requiresCapability"]>,
  boolean
>;

/**
 * WARP-2971 — the three ACCESS gates on a nav item (role, capability, module),
 * WITHOUT the WARP-1807 `hidden` tuck. Split out of `visibleItems` because the
 * Workspace layout (`workspace/workspace-nav-config.ts`) renders Knowledge and
 * Context as first-class destinations — the handoff lists them under
 * Intelligence — while every access rule must still hold there exactly as it
 * does in the sidebar. `hidden` is a SURFACE decision (which nav shows the
 * item); these three are PERMISSION decisions (whether the viewer may see it
 * at all), and only the surface is allowed to differ between layouts.
 *
 * `visibleItems` above is unchanged in behaviour: tuck, then these gates.
 */
export function passesGates(
  item: NavItem,
  role: AuthRole | undefined,
  capabilities: NavCapabilities,
  isModuleOn: (moduleId: string) => boolean,
): boolean {
  if (item.roles && (!role || !item.roles.includes(role))) return false;
  if (item.requiresCapability && !capabilities[item.requiresCapability])
    return false;
  // WARP-1397: hide a switched-off feature's nav entry (module not effective).
  // WARP-1528: "effective" is now per person, not just per box.
  if (item.requiresModule && !isModuleOn(item.requiresModule)) return false;
  return true;
}

/**
 * WARP-2967 — the Settings front door, derived from the one nav definition.
 *
 * Every tucked item (`hidden: true`) names a `settingsSection`; this buckets
 * them in `SETTINGS_SECTIONS` order and applies the viewer's gates. Two
 * surfaces render it: the sidebar's contextual Settings panel and the Settings
 * page's link rows. Deriving both from `NAV_GROUPS` is what keeps
 * `moduleForPath`, the panel and the page from ever disagreeing about which
 * destinations exist — the alternative is a second hand-kept list, which is
 * the drift `workspace-nav-config.ts` rule 1 already exists to prevent.
 *
 * The `hidden` tuck is the ONE predicate deliberately not applied: it is what
 * put these rows here. Everything else — role, capability, module — runs
 * exactly as the sidebar runs it, via the shared `passesGates`. That inherits
 * the WARP-1807 fail-open posture for free: `useModuleGate` answers true for
 * anything not positively reported off, so a probe blip can never hide the
 * last path in to a surface.
 *
 * Sections with nothing visible are dropped rather than captioned empty.
 */
export function settingsGroups(
  role: AuthRole | undefined,
  capabilities: NavCapabilities,
  isModuleOn: (moduleId: string) => boolean,
): NavGroup[] {
  const buckets = new Map<SettingsSection, NavItem[]>();
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (!item.hidden || !item.settingsSection) continue;
      if (!passesGates(item, role, capabilities, isModuleOn)) continue;
      const bucket = buckets.get(item.settingsSection) ?? [];
      bucket.push(item);
      buckets.set(item.settingsSection, bucket);
    }
  }
  return SETTINGS_SECTIONS.filter((s) => buckets.get(s)?.length).map((s) => ({
    label: s,
    items: buckets.get(s)!,
  }));
}

/**
 * WARP-2967 — is this route inside Settings, for sidebar purposes?
 *
 * True for /settings and its sub-pages, and for every TUCKED destination:
 * Settings is the only way in to those, so the panel that led you there is
 * the nav that should still be on screen when you arrive. Arriving on
 * /admin/audit with the main tree showing would leave the sidebar pointing at
 * nothing you are near.
 *
 * Segment-aware through `pathMatches`, so /settingsomething is not Settings.
 */
export function isSettingsContext(pathname: string): boolean {
  if (pathMatches(pathname, "/settings")) return true;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (!item.hidden) continue;
      if (item.exact ? pathname === item.href : pathMatches(pathname, item.href))
        return true;
    }
  }
  return false;
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

// Exported (WARP-2971) so the Workspace layout derives the active space with
// the SAME segment-aware rule `moduleForPath` uses, not a second prefix test.
export function pathMatches(pathname: string, href: string): boolean {
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

