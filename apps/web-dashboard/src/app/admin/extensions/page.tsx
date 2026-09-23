"use client";

/**
 * /admin/extensions — WARP-2900 (ADR-056 slice H4).
 *
 * The owner's place to turn a workshop proposal into a running extension, and
 * to disable, re-enable or uninstall one. Three things on one page:
 *
 *   - Proposals: what the workshop has proposed, and whether it can be
 *     promoted. "Review" asks the orchestrator for the readback (phase 1),
 *     which signs nothing.
 *   - The readback + confirm: rendered ONLY from the readback object and the
 *     preflight (components/admin/extensions/PromoteReadback.tsx). Confirming
 *     (phase 2) echoes the token and the digest that was read back, so bytes
 *     that moved in between are refused rather than signed.
 *   - Installed: every promoted extension, its status, and the owner's
 *     actions.
 *
 * Read-only for an admin: promote, disable and uninstall are the OWNER's
 * (`requireRole("owner")` on the orchestrator, which is the boundary — the
 * buttons simply are not offered to anyone else).
 *
 * The copy says plainly that an extension's tools start blocked for the
 * assistant: until an owner reviews a tool as read-only, or the
 * confirm-before-change step for runtime tools exists (WARP-2321), every
 * call is refused at dispatch.
 */
import { useState } from "react";
import { Puzzle } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Card, Row, Sect } from "@/components/shell/primitives";
import { InstalledList } from "@/components/admin/extensions/InstalledList";
import { ProposalsList } from "@/components/admin/extensions/ProposalsList";
import { PromoteReadback } from "@/components/admin/extensions/PromoteReadback";
import {
  EXTENSIONS_SUB,
  OWNER_ONLY,
  TOOLS_START_BLOCKED,
  WHAT_PROMOTING_DOES,
  explainExtensionError,
  explainLifecycleFailure,
} from "@/components/admin/extensions/copy";
import { ExtensionRequestError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useExtensions } from "@/lib/hooks/useExtensions";
import { useToolCatalog } from "@/lib/hooks/useToolCatalog";
import type {
  ExtensionPreflight,
  ExtensionPromotePhase1,
  ExtensionReadback,
} from "@/lib/types";

const ICON = <Puzzle size={15} />;

/** A readback on screen: confirmable (phase 1 answered) or refused (preflight blocked). */
type Review =
  | { kind: "ready"; phase1: ExtensionPromotePhase1 }
  | {
      kind: "blocked";
      workspaceId: string;
      slug: string;
      version: string;
      readback: ExtensionReadback;
      preflight: ExtensionPreflight;
    };

function isReadback(v: unknown): v is ExtensionReadback {
  return typeof v === "object" && v !== null && Array.isArray((v as ExtensionReadback).lines);
}

function isPreflight(v: unknown): v is ExtensionPreflight {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as ExtensionPreflight).blocking) &&
    Array.isArray((v as ExtensionPreflight).advisory)
  );
}

export default function ExtensionsAdminPage() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const ext = useExtensions();
  const { domains } = useToolCatalog();

  const [reviewing, setReviewing] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const closeReview = () => {
    setReview(null);
    setReviewing(null);
    setConfirmError(null);
  };

  const onReview = async (workspaceId: string) => {
    setReviewing(workspaceId);
    setReview(null);
    setReviewError(null);
    setConfirmError(null);
    setNotice(null);
    try {
      const phase1 = await ext.preparePromotion(workspaceId);
      setReview({ kind: "ready", phase1 });
    } catch (err) {
      // A blocked preflight is a readback the owner should still see — with
      // the reason — just not one they can confirm.
      if (
        err instanceof ExtensionRequestError &&
        err.code === "preflight_blocked" &&
        isReadback(err.body.readback) &&
        isPreflight(err.body.preflight)
      ) {
        const p = ext.proposals.find((x) => x.workspaceId === workspaceId);
        setReview({
          kind: "blocked",
          workspaceId,
          slug: p?.slug ?? workspaceId,
          version: p?.version ?? "",
          readback: err.body.readback,
          preflight: err.body.preflight,
        });
      } else {
        setReviewing(null);
        setReviewError(explainExtensionError(err));
      }
    }
  };

  const onConfirm = async (operatorDomain: string) => {
    if (review?.kind !== "ready") return;
    const { phase1 } = review;
    setConfirming(true);
    setConfirmError(null);
    try {
      const result = await ext.confirmPromotion(phase1, operatorDomain);
      closeReview();
      // The install error by its code only: its message can carry the
      // extension's build output and error text (review #2326).
      const promoted = `Promoted ${phase1.slug} ${phase1.version}`;
      setNotice(
        result.installed
          ? `${promoted}. It is signed and starting in the sandbox.`
          : `${promoted}, but it is not running. ${explainLifecycleFailure(result.installError?.code ?? null)}`,
      );
    } catch (err) {
      setConfirmError(explainExtensionError(err));
    } finally {
      setConfirming(false);
    }
  };

  const runAction = async (slug: string, action: () => Promise<void>) => {
    setBusySlug(slug);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(explainExtensionError(err));
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <ShellPage icon={ICON} label="Extensions" title="Extensions" sub={EXTENSIONS_SUB}>
      <Card>
        <div className="rows">
          <Row icon={ICON} iconBrand title="What promoting does" sub={WHAT_PROMOTING_DOES} />
          <Row title="What the assistant can use" sub={TOOLS_START_BLOCKED} />
          {!isOwner ? <Row title="Who can change this" sub={OWNER_ONLY} /> : null}
        </div>
      </Card>

      {notice ? (
        <Card>
          <p className="sub" role="status" style={{ margin: 0 }}>
            {notice}
          </p>
        </Card>
      ) : null}

      <Sect title="Proposals" extra={ext.proposals.length ? String(ext.proposals.length) : undefined} />
      <ProposalsList
        proposals={ext.proposals}
        loading={ext.proposalsLoading}
        error={ext.proposalsError}
        canPromote={isOwner}
        reviewing={reviewing}
        onReview={(id) => void onReview(id)}
      />
      {reviewError ? (
        <Card>
          <p className="sub" role="alert" style={{ margin: 0 }}>
            {reviewError}
          </p>
        </Card>
      ) : null}

      {review?.kind === "ready" ? (
        <PromoteReadback
          slug={review.phase1.slug}
          version={review.phase1.version}
          commit={review.phase1.commit}
          manifestSha256={review.phase1.manifestSha256}
          readback={review.phase1.readback}
          preflight={review.phase1.preflight}
          confirmable
          domains={domains}
          busy={confirming}
          error={confirmError}
          onConfirm={(d) => void onConfirm(d)}
          onCancel={closeReview}
        />
      ) : review?.kind === "blocked" ? (
        <PromoteReadback
          slug={review.slug}
          version={review.version}
          readback={review.readback}
          preflight={review.preflight}
          confirmable={false}
          domains={domains}
          busy={false}
          error={null}
          onConfirm={() => undefined}
          onCancel={closeReview}
        />
      ) : null}

      <Sect title="Installed" />
      <InstalledList
        extensions={ext.extensions}
        loading={ext.extensionsLoading}
        error={ext.extensionsError}
        canManage={isOwner}
        busy={busySlug}
        onSetEnabled={(slug, enabled) => void runAction(slug, () => ext.setEnabled(slug, enabled))}
        onUninstall={(slug) => void runAction(slug, () => ext.uninstall(slug))}
      />
      {actionError ? (
        <Card>
          <p className="sub" role="alert" style={{ margin: 0 }}>
            {actionError}
          </p>
        </Card>
      ) : null}
    </ShellPage>
  );
}
