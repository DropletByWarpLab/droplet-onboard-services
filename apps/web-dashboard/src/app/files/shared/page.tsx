"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  AlertTriangle,
  Share2,
  Globe,
  User,
  Users,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { useSharedWithMe, useSharedByMe } from "@/lib/hooks/useShares";
import { useToast } from "@/components/Toast";
import type { ShareDetail } from "@/lib/types";
import { ShellPage } from "@/components/shell/ShellPage";

type Tab = "with-me" | "by-me";

function formatShareType(t: number): { label: string; icon: LucideIcon } {
  if (t === 0) return { label: "User", icon: User };
  if (t === 1) return { label: "Group", icon: Users };
  if (t === 3) return { label: "Public link", icon: Globe };
  return { label: `Type ${t}`, icon: Share2 };
}

function formatStime(stime: number | null): string {
  if (!stime) return "";
  return new Date(stime * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * First segment of a row's sub line — who the share connects the user to.
 * Inbound rows name the OWNER (who shared it with me); outbound rows name
 * the RECIPIENT (who I shared it with), or the link audience for shareType 3
 * (WARP-941).
 */
function shareCounterparty(share: ShareDetail, tab: Tab): string {
  if (tab === "with-me") {
    return share.ownerDisplayName || share.uidOwner || "Unknown owner";
  }
  if (share.shareType === 3) return "Anyone with the link";
  return share.shareWithDisplayName || share.shareWith || "Unknown recipient";
}

export default function SharedPage() {
  const [tab, setTab] = useState<Tab>("with-me");
  const withMe = useSharedWithMe();
  // WARP-941 — real outbound listing (GET /api/files/shares-by-me) replaces
  // the old "Outbound shares coming soon" placeholder.
  const byMe = useSharedByMe();
  const { toast } = useToast();

  // WARP-1555: read every state off the tab's own hook — including `error`,
  // which both hooks always exposed and this page used to drop on the floor.
  const active = tab === "with-me" ? withMe : byMe;
  const visibleShares: ShareDetail[] = active.items;
  const isLoading = active.isLoading;
  const error = active.error;

  return (
    <ShellPage
      icon={<Share2 size={15} />}
      label="Shared"
      title="Shared"
      sub="Files shared with you, and files you've shared with others."
      actions={
        <Link href="/files" className="btn ghost" aria-label="Back to files">
          <ArrowLeft size={15} />
          Files
        </Link>
      }
    >
      {/* Tabs */}
      <div className="tabstrip">
        <button
          onClick={() => setTab("with-me")}
          className={"tab" + (tab === "with-me" ? " active" : "")}
          type="button"
          aria-pressed={tab === "with-me"}
        >
          Shared with me
        </button>
        <button
          onClick={() => setTab("by-me")}
          className={"tab" + (tab === "by-me" ? " active" : "")}
          type="button"
          aria-pressed={tab === "by-me"}
        >
          Shared by me
        </button>
      </div>

      {/* WARP-1555: a failed shares fetch is not "nothing shared with you".
          Checked ahead of the loading state because SWR re-raises `isLoading`
          on every backoff retry, and gated on an empty list so a failed
          background poll never wipes rows already on screen. */}
      {error && visibleShares.length === 0 && (
        <div className="card" role="alert">
          <div className="empty">
            <span className="ei"><AlertTriangle size={24} /></span>
            <span className="eh">
              {tab === "with-me"
                ? "We couldn't load what's been shared with you"
                : "We couldn't load what you've shared"}
            </span>
            <span style={{ maxWidth: "44ch" }}>
              The box didn&apos;t answer when we asked for your shares. Nothing
              has been unshared — try again in a moment.
            </span>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => active.refresh()}
              style={{ marginTop: 10 }}
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {!error && isLoading && visibleShares.length === 0 && (
        <div className="card">
          <div className="empty">
            <span>Loading…</span>
          </div>
        </div>
      )}

      {!error && tab === "with-me" && !isLoading && visibleShares.length === 0 && (
        <div className="card">
          <div className="empty">
            <span className="ei"><Share2 size={24} /></span>
            <span className="eh">Nothing shared with you yet</span>
            <span style={{ maxWidth: "44ch" }}>
              When other users on this Droplet share a file with you, it&apos;ll show up here.
            </span>
          </div>
        </div>
      )}

      {!error && tab === "by-me" && !isLoading && visibleShares.length === 0 && (
        <div className="card">
          <div className="empty">
            <span className="ei"><Share2 size={24} /></span>
            <span className="eh">You haven&apos;t shared anything yet</span>
            <span style={{ maxWidth: "44ch" }}>
              Share a file from <strong>Files</strong> — with a person or by link — and
              it&apos;ll show up here.
            </span>
          </div>
        </div>
      )}

      {visibleShares.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="rows">
            {visibleShares.map((share) => {
              const { label, icon: TypeIcon } = formatShareType(share.shareType);
              const fileName = (share.path || "").split("/").pop() || share.path;
              return (
                <div key={share.id} className="lrow" style={{ padding: "12px 16px" }}>
                  <span className="ri brand">
                    <TypeIcon size={15} />
                  </span>
                  <span className="rt">
                    <span className="nm">{fileName || "Shared item"}</span>
                    <span className="sub">
                      {shareCounterparty(share, tab)}
                      {" · "}
                      {label}
                      {share.stime ? ` · ${formatStime(share.stime)}` : ""}
                    </span>
                  </span>
                  {share.url && (
                    <a
                      href={share.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="icon-btn"
                      onClick={(e) => {
                        if (!share.url) {
                          e.preventDefault();
                          toast("No link available for this share");
                        }
                      }}
                      aria-label="Open link"
                      title="Open link"
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </ShellPage>
  );
}
