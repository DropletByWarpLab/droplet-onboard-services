"use client";

/**
 * WARP-2900 (ADR-056 slice H4) — workshop proposals that could be promoted.
 *
 * Each row is named by the slug this box derives from the workspace id (the
 * name the extension will run under) and the proposed version, with either a
 * "Review" action or the orchestrator's reason it cannot be promoted.
 *
 * The workspace's `name` is deliberately NOT rendered, anywhere — not as the
 * title, not in the button's label. POST /api/workspace is reachable by the
 * workshop's own tool, so a session that read untrusted content can name a
 * workspace "Read-only safe helper (reviewed)", and that sentence would sit
 * directly above the Review button. Same rule as InstalledList and the
 * readback: at decision time, only words this box wrote. Nothing from the
 * extension's manifest text is shown either: what it would get is read back
 * only after "Review", from `provides`. Why a proposal cannot be promoted is
 * said by the reason's code, never its detail (a manifest error quotes the
 * manifest; a sandbox error, the sandbox), and a version's pre-release only
 * as the fact of one (review #2326).
 */
import { Hammer } from "lucide-react";
import { Badge, Card, Row } from "@/components/shell/primitives";
import type { ExtensionProposal } from "@/lib/types";
import { displayVersion, explainExtensionError, explainProposalReason } from "./copy";

export interface ProposalsListProps {
  proposals: ExtensionProposal[];
  loading: boolean;
  error: Error | undefined;
  canPromote: boolean;
  /** The proposal whose readback is being fetched (cleared once it lands). */
  reviewing: string | null;
  onReview: (workspaceId: string) => void;
}

export function ProposalsList({ proposals, loading, error, canPromote, reviewing, onReview }: ProposalsListProps) {
  if (error) {
    return (
      <Card>
        <p className="sub" role="alert">
          Could not read the workshop proposals. {explainExtensionError(error)}
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
            title={p.slug}
            sub={p.promotable ? `version ${displayVersion(p.version)}` : explainProposalReason(p.reason)}
            meta={displayVersion(p.version)}
            metaMono
            right={
              p.promotable ? (
                canPromote ? (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={reviewing !== null}
                    aria-label={`Review ${p.slug} ${displayVersion(p.version)}`}
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
