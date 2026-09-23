"use client";

/**
 * WARP-2900 (ADR-056 slice H4) — workshop proposals that could be promoted.
 *
 * Each row names the workshop workspace (the owner's own label for it), the
 * proposed version, and either a "Review" action or the orchestrator's reason
 * it cannot be promoted. Nothing from the extension's manifest text is shown
 * here: what it would get is read back only after "Review", from `provides`.
 */
import { Hammer } from "lucide-react";
import { Badge, Card, Row } from "@/components/shell/primitives";
import type { ExtensionProposal } from "@/lib/types";

export interface ProposalsListProps {
  proposals: ExtensionProposal[];
  loading: boolean;
  error: Error | undefined;
  canPromote: boolean;
  /** The proposal whose readback is being fetched or shown. */
  reviewing: string | null;
  onReview: (workspaceId: string) => void;
}

export function ProposalsList({ proposals, loading, error, canPromote, reviewing, onReview }: ProposalsListProps) {
  if (error) {
    return (
      <Card>
        <p className="sub" role="alert">
          Could not read the workshop proposals. {error.message}
        </p>
      </Card>
    );
  }
  if (loading) {
    return (
      <Card>
        <p className="sub">Loading…</p>
      </Card>
    );
  }
  if (proposals.length === 0) {
    return (
      <Card>
        <div className="empty">
          <span className="ei">
            <Hammer size={24} />
          </span>
          <span className="eh">Nothing proposed</span>
          <span>When a workshop proposes a version of a tool, it appears here for an owner to review.</span>
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <div className="rows">
        {proposals.map((p) => (
          <Row
            key={`${p.workspaceId}:${p.tag}`}
            icon={<Hammer size={15} />}
            title={p.name}
            sub={p.promotable ? `version ${p.version} · becomes ${p.slug}` : (p.reason ?? "Cannot be promoted")}
            meta={p.version}
            metaMono
            right={
              p.promotable ? (
                canPromote ? (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={reviewing !== null}
                    aria-label={`Review ${p.name} ${p.version}`}
                    onClick={() => onReview(p.workspaceId)}
                  >
                    {reviewing === p.workspaceId ? "Reading…" : "Review"}
                  </button>
                ) : (
                  <Badge kind="info">Ready for the owner</Badge>
                )
              ) : (
                <Badge kind="muted">Not promotable</Badge>
              )
            }
          />
        ))}
      </div>
    </Card>
  );
}
