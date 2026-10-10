"use client";

import { useState } from "react";
import { Ban, Check, ChevronDown, Hand } from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  setToolGroupPermission,
  setToolPermission,
  type DirectoryTool,
  type ToolPermission,
} from "@/lib/api";
import { DropMenu } from "./DropMenu";
import { PERMISSION_LABEL, isLoosening, legalPermissions } from "./directory-model";

/**
 * WARP-3965 — "Tool permissions" on a connected MCP server's detail page.
 *
 * The product contract is rendered, not just enforced: a read tool takes Always
 * allow, Ask first or Blocked; a write tool takes Ask first or Blocked (there is
 * no Always allow, ever); a destructive tool is Blocked by Droplet. Segments the
 * box would refuse are disabled, so a refusal is the exception, not a flow.
 * Owners edit everything legal; admins may only tighten (Always allow, then Ask
 * first, then Blocked); members read.
 */

const ICON: Record<ToolPermission, typeof Check> = { always: Check, ask: Hand, block: Ban };
const ORDER: readonly ToolPermission[] = ["always", "ask", "block"];

/** Fixed sentences for the box's refusal codes; the box's own message is never shown. */
const REFUSALS: Record<string, string> = {
  permission_not_allowed_for_grade: "Droplet doesn’t allow that setting for this kind of tool.",
  admin_can_only_tighten: "Only the owner can loosen a permission.",
  stale_review: "That tool changed since you opened this page. Reload and review it again.",
};
const REFUSAL_FALLBACK = "Droplet didn’t accept that. Nothing changed.";

function reasonDisabled(
  tool: DirectoryTool,
  target: ToolPermission,
  canEdit: boolean,
  isOwner: boolean,
): string | null {
  if (!canEdit) return "Only an owner or admin can change this.";
  if (!legalPermissions(tool.grade).includes(target)) {
    return tool.grade === "destructive"
      ? "Blocked by Droplet"
      : "Writes always ask for a thumbs-up first.";
  }
  if (!isOwner && isLoosening(tool.permission, target)) return "Only the owner can loosen this.";
  return null;
}

function ToolRow({
  tool,
  busy,
  canEdit,
  isOwner,
  onPick,
}: {
  tool: DirectoryTool;
  busy: boolean;
  canEdit: boolean;
  isOwner: boolean;
  onPick: (p: ToolPermission) => void;
}) {
  return (
    <li
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--border)" }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="type-footnote text-[color:var(--text)]" style={{ display: "block", fontFamily: "var(--font-mono)" }}>
          {tool.name}
        </span>
        <span className="type-caption-1 text-[color:var(--text-faint)]" style={{ display: "block" }}>
          {tool.description}
        </span>
        {tool.changed && (
          <span className="type-caption-1" style={{ color: "var(--warn-ink, inherit)" }}>
            The vendor changed this tool. Review its permission.
          </span>
        )}
        {tool.grade === "destructive" && (
          <span className="type-caption-1 text-[color:var(--text-faint)]" style={{ display: "block" }}>
            Blocked by Droplet
          </span>
        )}
        {tool.grade === "write" && !canEdit && (
          <span className="type-caption-1 text-[color:var(--text-faint)]" style={{ display: "block" }}>
            Members need a role with write access to this connector.
          </span>
        )}
      </span>
      <span className="pills" role="radiogroup" aria-label={`Permission for ${tool.name}`}>
        {ORDER.map((p) => {
          const Icon = ICON[p];
          const why = reasonDisabled(tool, p, canEdit, isOwner);
          const selected = tool.permission === p;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={selected}
              className={selected ? "active" : undefined}
              disabled={busy || tool.grade === "destructive" || (why !== null && !selected)}
              title={why ?? undefined}
              onClick={() => {
                if (!selected) onPick(p);
              }}
              style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              <Icon size={13} aria-hidden />
              {PERMISSION_LABEL[p]}
            </button>
          );
        })}
      </span>
    </li>
  );
}

function Group({
  title,
  tools,
  group,
  busy,
  canEdit,
  isOwner,
  onPick,
  onPickGroup,
}: {
  title: string;
  tools: DirectoryTool[];
  /** Which grade the bulk PATCH names; destructive tools are never part of it. */
  group: "read" | "write";
  busy: boolean;
  canEdit: boolean;
  isOwner: boolean;
  onPick: (t: DirectoryTool, p: ToolPermission) => void;
  onPickGroup: (p: ToolPermission) => void;
}) {
  if (tools.length === 0) return null;
  const options = ORDER.filter((p) => group === "read" || p !== "always");
  return (
    <section aria-label={title} style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h3 className="type-headline" style={{ flex: 1, margin: 0 }}>
          {title} <span className="text-[color:var(--text-faint)]">{tools.length}</span>
        </h3>
        <DropMenu
          label={`Set all ${title.toLowerCase()}`}
          className="btn sm"
          trigger={
            <>
              Set all <ChevronDown size={13} aria-hidden />
            </>
          }
          items={options.map((p) => {
            const loosens = !isOwner && tools.some((t) => t.grade === group && isLoosening(t.permission, p));
            return {
              id: p,
              label: PERMISSION_LABEL[p],
              disabled: !canEdit || busy || loosens,
              reason: !canEdit ? "Only an owner or admin can change this." : "Only the owner can loosen this.",
              onSelect: () => onPickGroup(p),
            };
          })}
        />
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
        {tools.map((t) => (
          <ToolRow key={t.name} tool={t} busy={busy} canEdit={canEdit} isOwner={isOwner} onPick={(p) => onPick(t, p)} />
        ))}
      </ul>
    </section>
  );
}

export function ToolPermissions({
  serverId,
  tools,
  canEdit,
  onChanged,
}: {
  serverId: string;
  tools: DirectoryTool[];
  canEdit: boolean;
  /** Re-read the directory after the box accepted a change. */
  onChanged: () => void | Promise<unknown>;
}) {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (change: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await change();
      await onChanged();
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      setError(Object.hasOwn(REFUSALS, code) ? REFUSALS[code]! : REFUSAL_FALLBACK);
    }
    setBusy(false);
  };

  if (tools.length === 0) {
    return (
      <section aria-label="Tool permissions">
        <h2 className="type-title-3">Tool permissions</h2>
        <p className="type-footnote text-[color:var(--text-muted)]">
          Droplet lists this connector&rsquo;s tools after the first sign-in.
        </p>
      </section>
    );
  }

  const interactive = tools.filter((t) => t.grade !== "read");
  const readOnly = tools.filter((t) => t.grade === "read");

  return (
    <section aria-label="Tool permissions" data-testid="tool-permissions">
      <h2 className="type-title-3" style={{ marginBottom: 4 }}>Tool permissions</h2>
      <p className="type-footnote text-[color:var(--text-muted)]" style={{ margin: 0 }}>
        Choose when Droplet may use these tools. Reads run automatically, writes ask for a thumbs-up,
        destructive actions are blocked.
      </p>
      {error && (
        <p role="alert" className="type-footnote text-system-red" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
      <Group
        title="Interactive tools"
        group="write"
        tools={interactive}
        busy={busy}
        canEdit={canEdit}
        isOwner={isOwner}
        onPick={(t, p) => void run(() => setToolPermission(serverId, t.name, p, t.inputSchemaHash))}
        onPickGroup={(p) => void run(() => setToolGroupPermission(serverId, "write", p))}
      />
      <Group
        title="Read-only tools"
        group="read"
        tools={readOnly}
        busy={busy}
        canEdit={canEdit}
        isOwner={isOwner}
        onPick={(t, p) => void run(() => setToolPermission(serverId, t.name, p, t.inputSchemaHash))}
        onPickGroup={(p) => void run(() => setToolGroupPermission(serverId, "read", p))}
      />
    </section>
  );
}
