"use client";

import Link from "next/link";
import { BadgeCheck, Check, Plus } from "lucide-react";
import type { ConnectorDirectoryEntry } from "@/lib/api";
import { connectorIcon } from "./connector-visuals";
import { stateBadge } from "./directory-model";

/**
 * WARP-3965 — the one icon tile, card and list row both kinds of connector
 * share. The directory carries no artwork, so the tile is the connector's
 * glyph on the brand tint (the same treatment the old hub tile used).
 */
export function IconTile({ id, size = 44 }: { id: string; size?: number }) {
  const Icon = connectorIcon(id);
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--brand-subtle)",
        color: "var(--brand)",
      }}
    >
      <Icon size={Math.round(size * 0.45)} strokeWidth={1.75} />
    </span>
  );
}

export function VerifiedMark({ verified }: { verified: boolean }) {
  if (!verified) return null;
  return (
    <span title="Verified by Droplet" style={{ color: "var(--brand)", display: "inline-flex" }}>
      <BadgeCheck size={14} aria-label="Verified" role="img" />
    </span>
  );
}

/** `+` when it can be added, `✓` when the viewer already has it. */
function Trailing({ yours }: { yours: boolean }) {
  return yours ? (
    <span aria-label="Connected" role="img" style={{ color: "var(--ok-ink, var(--brand))" }}>
      <Check size={16} />
    </span>
  ) : (
    <span aria-hidden className="text-[color:var(--text-faint)]">
      <Plus size={16} />
    </span>
  );
}

export function DirectoryCard({ entry, yours }: { entry: ConnectorDirectoryEntry; yours: boolean }) {
  const badge = stateBadge(entry);
  return (
    <Link
      href={`/connectors/${encodeURIComponent(entry.id)}`}
      className="card"
      data-testid={`connector-card-${entry.id}`}
      style={{ display: "flex", gap: 12, alignItems: "flex-start", textDecoration: "none", color: "inherit" }}
    >
      <IconTile id={entry.id} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="type-headline text-[color:var(--text)]">{entry.name}</span>
          <VerifiedMark verified={entry.verified} />
        </span>
        <span className="type-footnote text-[color:var(--text-muted)]" style={{ display: "block", margin: "2px 0 4px" }}>
          {entry.tagline}
        </span>
        <span className="type-caption-1 text-[color:var(--text-faint)]">
          by {entry.madeBy.name}
          {badge ? ` · ${badge.label}` : ""}
        </span>
      </span>
      <Trailing yours={yours} />
    </Link>
  );
}

/** Search results: one dense row per connector, both kinds mixed. */
export function DirectoryRow({ entry, yours }: { entry: ConnectorDirectoryEntry; yours: boolean }) {
  return (
    <Link
      href={`/connectors/${encodeURIComponent(entry.id)}`}
      className="lrow ev-row"
      data-testid={`connector-row-${entry.id}`}
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <IconTile id={entry.id} size={36} />
      <span className="rt">
        <span className="nm" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {entry.name}
          <VerifiedMark verified={entry.verified} />
        </span>
        <span className="sub">
          Connector · by {entry.madeBy.name} · {entry.tagline}
        </span>
      </span>
      <Trailing yours={yours} />
    </Link>
  );
}
