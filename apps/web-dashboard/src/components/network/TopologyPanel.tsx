"use client";

import { useMemo } from "react";
import { Cable, Globe, Monitor, Network, Router, Video, Wifi, type LucideIcon } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useRouterPorts } from "@/lib/hooks/useRouterPorts";
import { useSwitch } from "@/lib/hooks/useSwitch";
import { useApRadios, useCoverageAps } from "@/lib/hooks/useCoverageAps";
import type { DeploymentPosture } from "@/lib/api";
import type { WirelessRadioSummary } from "@/lib/types";
import {
  buildTopology,
  describeApWifi,
  toApRadioRead,
  type ApWifiHint,
  type TopologyKind,
  type TopologyNode,
  type TopologyTone,
} from "./topology-model";
import styles from "./topology.module.css";

const ICON: Record<TopologyKind, LucideIcon> = {
  internet: Globe,
  upstream: Router,
  router: Router,
  switch: Network,
  "access-point": Wifi,
  camera: Video,
  computer: Monitor,
  device: Cable,
};

/** The infrastructure the household owns reads brand-tinted; what plugs into
 *  it reads neutral — the same split the panels' header chips make. */
const INFRA: ReadonlySet<TopologyKind> = new Set(["upstream", "router", "switch", "access-point"]);

/** "1 Gb", "6.2 W": when a card wraps, never strand a unit on its own line. */
const tight = (text: string) => text.replace(/(\d) (?=Gb|Mb|W\b)/g, "$1\u00A0");

/** Same shell as the router and switch panels so the three stack as siblings. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="type-footnote font-semibold text-[color:var(--text-muted)]">Topology</h4>
      <div className="card relative">{children}</div>
    </div>
  );
}

function NodeCard({
  node,
  status = node.status,
  tone = node.tone,
}: {
  node: TopologyNode;
  status?: string;
  tone?: TopologyTone;
}) {
  const Icon = ICON[node.kind];
  return (
    <div className={styles.node} data-kind={node.kind}>
      <span className={[styles.chip, INFRA.has(node.kind) ? styles.chipInfra : ""].join(" ")}>
        <Icon size={15} aria-hidden="true" />
      </span>
      <span className={styles.text}>
        <span className={`${styles.name} type-footnote font-semibold text-[color:var(--text)]`} title={node.name}>
          {node.name}
        </span>
        {status && (
          <span className={`${styles.status} type-caption-1 text-[color:var(--text-muted)]`}>
            <span className={`${styles.dot} ${styles[tone]}`} aria-hidden="true" />
            <span className={styles.statusText}>{tight(status)}</span>
          </span>
        )}
        {node.meta && (
          <span className={`${styles.meta} type-caption-2 font-mono text-[color:var(--text-muted)]`}>
            {tight(node.meta)}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * An access point whose radios can be read: its status line is the live
 * radios, not the baseline the model drew it with. Its own component because
 * the read is a hook, and a tree has one of these per AP.
 */
function ApNodeCard({
  node,
  mac,
  hint,
  canReadRadios,
}: {
  node: TopologyNode;
  mac: string;
  hint: ApWifiHint;
  canReadRadios: boolean;
}) {
  const { detail, error } = useApRadios(mac, canReadRadios);
  const wifi = describeApWifi(toApRadioRead({ enabled: canReadRadios, detail, failed: Boolean(error) }), hint);
  return <NodeCard node={node} status={wifi.status} tone={wifi.tone} />;
}

function TopologyItem({
  node,
  hint,
  canReadRadios,
}: {
  node: TopologyNode;
  hint: ApWifiHint;
  canReadRadios: boolean;
}) {
  return (
    <li className={styles.item}>
      {node.ap?.readable ? (
        <ApNodeCard node={node} mac={node.ap.mac} hint={hint} canReadRadios={canReadRadios} />
      ) : (
        <NodeCard node={node} />
      )}
      {node.children.length > 0 && (
        <ul role="list" className={styles.children}>
          {node.children.map((child) => (
            <TopologyItem key={child.id} node={child} hint={hint} canReadRadios={canReadRadios} />
          ))}
        </ul>
      )}
    </li>
  );
}

const LEGEND: { tone: TopologyTone; label: string }[] = [
  { tone: "ok", label: "connected" },
  { tone: "warn", label: "needs a look" },
  { tone: "neutral", label: "no cable" },
  { tone: "err", label: "problem" },
];

/**
 * TopologyPanel — how the household's network is physically wired: Internet →
 * router → managed switch → the access point, cameras and computers on it.
 *
 * Until now the access point was invisible on this page apart from the Wi-Fi
 * tile's "Unknown — your access point isn't reporting its radios", and the two
 * port maps below say what each jack is doing but not what it is connected to.
 * This is the one place the pieces are drawn as a chain.
 *
 * Its reads are the page's reads. The router and switch come off the same
 * hooks, and SWR keys, as the two port maps below, so those cost nothing
 * extra. The AP list and each AP's live radios are the Wi-Fi tab's keys
 * (CoverageExtendersPanel, ApRadioDetail); on this tab the panel is what keeps
 * them polling — 10 s for the list, 30 s per readable AP, and the radios only
 * for owner/admin — and `paused` stops both while the page hides the panel
 * (Simple mode keeps it mounted under `hidden`), so the default view never
 * dials the access points.
 *   - the router's jacks        useRouterPorts   (GET /api/network/ports)
 *   - the switch and its ports  useSwitch        (GET /api/switch/*)
 *   - the access points         useCoverageAps   (GET /api/aps)
 *   - each AP's live radios     useApRadios      (GET /api/aps/:mac/wireless,
 *                                                 owner/admin only)
 *   - `posture`                 the Overview's existing getNetworkTopology()
 *   - `radios`                  the whole-fabric rollup on /network/status,
 *                               readable by every role — the fallback for
 *                               viewers who can't read per-AP radios
 * `buildTopology` (topology-model.ts) turns those into the tree; this file
 * only draws it.
 *
 * Neither the router nor the switch reports what is on the other end of a
 * cable, so the model attributes a cable to a jack only when the evidence
 * leaves one candidate, and says "port not identified" or names the candidates
 * otherwise. An access point whose radios don't answer is drawn as exactly
 * that, never with a made-up client count.
 *
 * Render paths:
 *   - loading            → skeleton
 *   - router unreadable  → one quiet line (we can't draw what we can't read)
 *   - otherwise          → the tree. No switch means router → devices only;
 *                          an unreachable switch, a switch whose ports can't
 *                          be read, or an unreadable AP list says so below it,
 *                          as does a switch whose ports carry no labels.
 *
 * The tree is a nested <ul>; its connector lines are CSS pseudo-elements, so
 * none of them reach the accessibility tree. Colour is never the only cue —
 * every state is also in the status text.
 */
export function TopologyPanel({
  posture,
  radios,
  paused = false,
}: {
  posture?: DeploymentPosture | null;
  radios?: WirelessRadioSummary;
  /** The page is hiding the panel (Simple mode): keep drawing, stop the AP reads. */
  paused?: boolean;
}) {
  const { map, isLoading: routerLoading, error: routerError } = useRouterPorts();
  const sw = useSwitch();
  const coverage = useCoverageAps({ paused });
  const { user } = useAuth();
  const canReadRadios = !paused && (user?.role === "owner" || user?.role === "admin");

  const router = !routerError && map && map.supported && map.ports.length > 0 ? map : null;
  const { connected, status: switchStatus, ports: switchPorts, portsLoading, portsError } = sw;
  // SWR keeps the last good port list through a failed poll, so an empty list
  // with an error means the ports read has never answered at all.
  const portsUnread = Boolean(portsError) && switchPorts.length === 0;
  const aps = coverage.aps;
  const model = useMemo(
    () =>
      router
        ? buildTopology({
            router,
            switch:
              connected && switchStatus
                ? { status: switchStatus, ports: portsUnread ? null : switchPorts }
                : null,
            aps,
            posture,
            radios,
          })
        : null,
    [router, connected, switchStatus, switchPorts, portsUnread, aps, posture, radios],
  );

  if (routerLoading && !map) {
    return (
      <Shell>
        <div data-testid="topology-skeleton" className="h-40 animate-pulse bg-[var(--inset)] rounded-[10px]" />
      </Shell>
    );
  }

  if (!model) {
    return (
      <Shell>
        <div role="status" className="py-2 space-y-1">
          <p className="type-footnote text-[color:var(--text-muted)]">
            Topology unavailable — router not reporting its ports
          </p>
          {map && !map.supported && map.detail && (
            <p className="type-caption-1 text-[color:var(--text-muted)]">{map.detail}</p>
          )}
        </div>
      </Shell>
    );
  }

  // The rest of the tree can't be drawn until the switch — its status AND its
  // ports, two separate reads — and the AP list have each answered once:
  // filling them in later would redraw the router's cables. A read that
  // failed has answered; its footnote is below.
  const portsPending = connected && portsLoading && switchPorts.length === 0 && !portsError;
  if ((sw.isLoading && !switchStatus) || portsPending || coverage.isLoading) {
    return (
      <Shell>
        <div data-testid="topology-skeleton" className="h-40 animate-pulse bg-[var(--inset)] rounded-[10px]" />
      </Shell>
    );
  }

  const notes = [
    sw.error && !connected ? "We can't reach the switch, so its ports aren't shown." : null,
    coverage.error ? "We couldn't read your access points, so they may be missing." : null,
    ...model.notes,
  ].filter((n): n is string => n !== null);

  return (
    <Shell>
      <div className={styles.scroller}>
        <ul role="list" className={styles.tree} aria-label="Network topology">
          <TopologyItem node={model.root} hint={model.hint} canReadRadios={canReadRadios} />
        </ul>
      </div>
      <div className={`${styles.legend} type-caption-2 text-[color:var(--text-muted)]`}>
        {LEGEND.map(({ tone, label }) => (
          <span key={tone} className={styles.legendItem}>
            <span className={`${styles.dot} ${styles[tone]}`} aria-hidden="true" />
            {label}
          </span>
        ))}
      </div>
      {notes.map((note) => (
        <p key={note} className="type-caption-1 text-[color:var(--text-muted)] mt-2">
          {note}
        </p>
      ))}
    </Shell>
  );
}
