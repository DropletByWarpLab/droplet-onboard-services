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
import {
  DEFAULT_SCOPE,
  NUMBER_STRIP_SCOPE_NOTE,
  SCOPE_OPTIONS,
  rangeFor,
  type DateRange,
  type ScopeId,
} from "./date-scope";

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

export default function ReportsPage() {
  const [scope, setScope] = useState<ScopeId>(DEFAULT_SCOPE);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [spinning, setSpinning] = useState(false);

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
            <TileShell key={t.id} spec={t} range={range} />
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

/**
 * The tile frame every sibling story fills. It owns the card, the header,
 * and the loading body — so a tile that gains real content cannot
 * accidentally drift from its neighbours.
 */
function TileShell({ spec, range }: { spec: TileSpec; range: DateRange | null }) {
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
      {isNumber ? (
        <div className="rp-num-label">
          <Icon size={16} aria-hidden="true" />
          <span id={headingId}>{spec.title}</span>
        </div>
      ) : (
        <div className="rp-tile-head">
          <span className="rp-tile-mark">
            <Icon size={16} aria-hidden="true" />
          </span>
          <h2 id={headingId}>{spec.title}</h2>
        </div>
      )}

      <div className="rp-tile-body">
        <TilePlaceholder isNumber={isNumber} />
      </div>
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
