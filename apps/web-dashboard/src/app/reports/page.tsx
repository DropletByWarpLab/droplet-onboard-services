"use client";

/**
 * WARP-1992 — `/reports`, the shell.
 *
 * One bento page that answers: what happened today, what does it add up to,
 * where is the money, and what is Droplet connected to. This story ships the
 * route, the nav entry, the page chrome, and the grid with skeleton tiles;
 * the sibling stories (WARP-1993..1997) fill the bodies.
 *
 * The tile list below is the contract between those stories — id, span, and
 * header are fixed here, so filling a body never moves the layout. Source
 * order IS reading order and is preserved on mobile (brief §4).
 *
 * Tokens: surfaces and text come from the indigo shell scope, status colour
 * from the global `--color-system-*` ramp. See reports.css for why.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  Blocks,
  ChartColumn,
  Cpu,
  DollarSign,
  Download,
  FolderOpen,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useAuth } from "@/lib/auth";
import {
  DEFAULT_SCOPE,
  NUMBER_STRIP_SCOPE_NOTE,
  SCOPE_OPTIONS,
  rangeFor,
  type DateRange,
  type ScopeId,
} from "./date-scope";
import { fetchHome, type HomePayload } from "./api";
import { ActivityBody, ChainChip, FoldersBody, IntegrationsBody, NumberBody } from "./tiles";

import "./reports.css";

const SUB =
  "Your day, your numbers, and everything Droplet is connected to — computed on this box.";

type Span = "8x2" | "4x2" | "6x2" | "3x1";

interface TileSpec {
  id: string;
  span: Span;
  title: string;
  icon: LucideIcon;
  /** Ticket that fills this tile's body. Kept in the source as the handoff. */
  owner: string;
}

/**
 * Brief §4. Order is reading order — do not sort, and do not re-order for
 * mobile; the single-column stack is meant to follow exactly this sequence.
 */
const TILES: TileSpec[] = [
  { id: "a1", span: "8x2", title: "Daily report", icon: Sparkles, owner: "WARP-1996" },
  { id: "a2", span: "4x2", title: "Money", icon: DollarSign, owner: "WARP-1995" },
  { id: "b1", span: "3x1", title: "Files", icon: FolderOpen, owner: "WARP-1993" },
  { id: "b2", span: "3x1", title: "Cameras", icon: Video, owner: "WARP-1993" },
  { id: "b3", span: "3x1", title: "Devices", icon: Cpu, owner: "WARP-1993" },
  { id: "b4", span: "3x1", title: "Network", icon: Network, owner: "WARP-1993" },
  { id: "c1", span: "6x2", title: "Folders & storage", icon: FolderOpen, owner: "WARP-1993" },
  { id: "c2", span: "6x2", title: "Integrations", icon: Blocks, owner: "WARP-1994" },
  { id: "d1", span: "8x2", title: "Activity", icon: Activity, owner: "WARP-1993" },
  { id: "d2", span: "4x2", title: "Ask about this report", icon: Sparkles, owner: "WARP-1997" },
];

const NUMBER_TILE_IDS = new Set(["b1", "b2", "b3", "b4"]);

/** Tile id → the `/api/home` tile it renders. */
const NUMBER_TILE_KEY = {
  b1: "files",
  b2: "cameras",
  b3: "devices",
  b4: "network",
} as const;

/** Brief §7 — Folders and Activity are admin-tier. NOT `role === "owner"`:
 *  `admin` is a distinct role and must see both. */
const ADMIN_TIER = new Set(["owner", "admin"]);

export default function ReportsPage() {
  const { user } = useAuth();
  const isAdminTier = ADMIN_TIER.has(user?.role ?? "");

  const [scope, setScope] = useState<ScopeId>(DEFAULT_SCOPE);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [spinning, setSpinning] = useState(false);

  // One round-trip for all four number tiles. Deliberately NOT keyed on the
  // date scope — /api/home is point-in-time (WARP-1999).
  const [home, setHome] = useState<HomePayload | null>(null);
  const [homeFailed, setHomeFailed] = useState(false);

  // Stamped on the client only. Rendering a clock during SSR would hydrate
  // against a different second and warn on every load.
  useEffect(() => {
    setRefreshedAt(new Date());
  }, []);

  const range: DateRange | null = useMemo(
    // Gated on the client stamp rather than falling back to `new Date()`:
    // the server and the first client render would otherwise read two
    // different clocks, and across a midnight boundary that hydrates
    // mismatched range attributes. Unknown-until-stamped is also honest —
    // the same reason the provenance strip skeletons its timestamp.
    //
    // `custom` additionally resolves to null until a picker exists
    // (WARP-1997), so tiles carry no range rather than silently showing
    // today's data under a label the user changed.
    () => (refreshedAt ? rangeFor(scope, refreshedAt) : null),
    [scope, refreshedAt],
  );

  // Re-runs on refresh: `refreshedAt` is the page's one refetch key, so a
  // press of Refresh re-reads every tile without each owning a timer.
  useEffect(() => {
    if (!refreshedAt) return;
    let live = true;
    setHomeFailed(false);
    fetchHome()
      .then((h) => live && setHome(h))
      .catch(() => live && setHomeFailed(true));
    return () => {
      live = false;
    };
  }, [refreshedAt]);

  const onRefresh = useCallback(() => {
    setSpinning(true);
    setRefreshedAt(new Date());
    window.setTimeout(() => setSpinning(false), 250);
  }, []);

  return (
    <ShellPage
      icon={<ChartColumn size={15} />}
      label="Reports"
      title="Reports"
      sub={SUB}
      actions={
        <ReportsActions
          scope={scope}
          onScope={setScope}
          onRefresh={onRefresh}
          spinning={spinning}
        />
      }
    >
      <div className="droplet-reports">
        <ProvenanceStrip at={refreshedAt} />

        <div className="rp-bento">
          {TILES.map((t) => (
            <TileShell
              key={t.id}
              spec={t}
              range={range}
              body={tileBody(t.id, {
                home,
                homeFailed,
                homeLoading: home === null && !homeFailed,
                isAdminTier,
                range,
                now: refreshedAt,
              })}
              trail={t.id === "d1" ? <ChainChip canRead={isAdminTier} /> : trailLink(t.id)}
            />
          ))}
        </div>
      </div>
    </ShellPage>
  );
}

function ReportsActions({
  scope,
  onScope,
  onRefresh,
  spinning,
}: {
  scope: ScopeId;
  onScope: (s: ScopeId) => void;
  onRefresh: () => void;
  spinning: boolean;
}) {
  return (
    <>
      <div className="rp-scope" role="group" aria-label="Date range">
        {SCOPE_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            className="rp-scope-chip"
            aria-pressed={scope === o.id}
            onClick={() => onScope(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="rp-scope-chip"
        onClick={onRefresh}
        aria-label="Refresh"
        title="Refresh"
      >
        <RefreshCw size={16} aria-hidden="true" className={spinning ? "rp-spin" : undefined} />
      </button>
      {/* Export lands in WARP-1997. Rendered disabled rather than omitted so
          the chrome is complete and the layout doesn't shift when it wires
          up — but the tooltip stays user-facing; a ticket id is not copy. */}
      <button type="button" className="rp-scope-chip" disabled title="Export isn't ready yet">
        <Download size={16} aria-hidden="true" /> Export
      </button>
    </>
  );
}

/**
 * Brief §3 — persistent, never scrolls away with the tiles. The claim it
 * makes is a capability, not a promise: the page's data really is computed
 * on the box, so it is stated plainly.
 *
 * The scope caveat lives here rather than on a tile. WARP-1999: the number
 * strip can't follow the date chip, and this is the page's own scope
 * furniture — the one place the note can't be misread as belonging to a
 * single tile. On four tiles it would be noise; on one, ambiguous.
 */
function ProvenanceStrip({ at }: { at: Date | null }) {
  return (
    <div className="rp-provenance">
      <ShieldCheck size={14} aria-hidden="true" />
      <span>
        Computed on this box · nothing left your network · last updated{" "}
        {at ? (
          <time dateTime={at.toISOString()}>
            {at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </time>
        ) : (
          <span className="rp-skel" style={{ display: "inline-block", width: 38, height: 12 }} />
        )}
        {" · counts are "}
        {NUMBER_STRIP_SCOPE_NOTE.toLowerCase()}
      </span>
    </div>
  );
}

/** Header link out to the surface that owns each tile's data. */
function trailLink(id: string): ReactNode {
  const to: Record<string, [string, string]> = {
    c1: ["/admin/files", "Manage"],
    c2: ["/integrations", "All connectors"],
  };
  const hit = to[id];
  if (!hit) return null;
  return (
    <a href={hit[0]} className="rp-tile-trail">
      {hit[1]} →
    </a>
  );
}

interface BodyDeps {
  home: HomePayload | null;
  homeFailed: boolean;
  homeLoading: boolean;
  isAdminTier: boolean;
  range: DateRange | null;
  /** The page's client clock. Relative times ("2 min ago") are rendered
   *  against it rather than each row calling `new Date()`, so every row on
   *  one paint agrees — and so SSR never renders a time at all. */
  now: Date | null;
}

/**
 * Route a tile id to its body. Tiles whose story hasn't landed yet fall
 * through to the skeleton, so the grid stays whole while the epic fills in.
 */
function tileBody(id: string, d: BodyDeps): ReactNode {
  const numberKey = NUMBER_TILE_KEY[id as keyof typeof NUMBER_TILE_KEY];
  if (numberKey) {
    return (
      <NumberBody
        which={numberKey}
        tile={d.home ? d.home.tiles[numberKey] : null}
        loading={d.homeLoading}
        failed={d.homeFailed}
      />
    );
  }
  if (id === "c1") return <FoldersBody canRead={d.isAdminTier} />;
  if (id === "c2") return <IntegrationsBody now={d.now} />;
  if (id === "d1") return <ActivityBody range={d.range} canRead={d.isAdminTier} />;
  return null;
}

/**
 * The tile frame every story fills. It owns the card, the header, and the
 * fallback skeleton — so a tile that gains real content cannot accidentally
 * drift from its neighbours.
 */
function TileShell({
  spec,
  range,
  body,
  trail,
}: {
  spec: TileSpec;
  range: DateRange | null;
  body?: ReactNode;
  trail?: ReactNode;
}) {
  const Icon = spec.icon;
  const headingId = `rp-t-${spec.id}`;
  const isNumber = NUMBER_TILE_IDS.has(spec.id);

  return (
    <section
      className="rp-tile"
      data-span={spec.span}
      data-tile={spec.id}
      data-range-from={range?.from ?? undefined}
      data-range-to={range?.to ?? undefined}
      aria-labelledby={headingId}
    >
      {/* A number tile's label IS its heading; the others get the mark +
          title header. Both paths must label the section — an unlabelled
          <section> is invisible structure to a screen reader. */}
      {isNumber ? (
        <span id={headingId} className="rp-sr">
          {spec.title}
        </span>
      ) : (
        <div className="rp-tile-head">
          <span className="rp-tile-mark">
            <Icon size={16} aria-hidden="true" />
          </span>
          <h2 id={headingId}>{spec.title}</h2>
          {trail ? <span className="rp-tile-trail-slot">{trail}</span> : null}
        </div>
      )}

      {body ?? (
        <div className="rp-tile-body">
          <TilePlaceholder isNumber={isNumber} />
        </div>
      )}
    </section>
  );
}

function TilePlaceholder({ isNumber }: { isNumber: boolean }): ReactNode {
  const widths = isNumber ? ["64%", "82%"] : ["92%", "86%", "78%", "54%"];
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: isNumber ? 8 : 0 }}
      aria-hidden="true"
    >
      {widths.map((w, i) => (
        <span
          key={i}
          className="rp-skel"
          style={{ width: w, height: isNumber && i === 0 ? 26 : 12 }}
        />
      ))}
    </div>
  );
}
