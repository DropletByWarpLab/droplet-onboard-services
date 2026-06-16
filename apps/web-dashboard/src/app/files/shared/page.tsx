"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Share2,
  Globe,
  User,
  Users,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { useSharedWithMe } from "@/lib/hooks/useShares";
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

export default function SharedPage() {
  const [tab, setTab] = useState<Tab>("with-me");
  const { items, isLoading } = useSharedWithMe();
  const { toast } = useToast();

  // "Shared by me" (outbound shares) is blocked on a reverse-share endpoint
  // that does not exist yet: the orchestrator needs to expose the current
  // user's *outbound* shares (e.g. GET /api/files/shares?direction=outbound,
  // backed by a Nextcloud OCS shares query filtered to shares this user owns).
  // `useSharedWithMe` only returns inbound shares. Until that endpoint lands
  // the tab stays visible but empty. NOTE: building the endpoint is out of
  // scope here — this is the tracked gap, not a TODO to implement inline.
  const visibleShares: ShareDetail[] = useMemo(() => {
    if (tab === "with-me") return items;
    return [];
  }, [tab, items]);

  return (
    <ShellPage
      icon={<Share2 size={15} />}
      label="Shared"
      title="Shared"
      sub="Files other users on this Droplet have shared with you."
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
        >
          Shared with me
        </button>
        <button
          onClick={() => setTab("by-me")}
          className={"tab" + (tab === "by-me" ? " active" : "")}
          type="button"
        >
          Shared by me
        </button>
      </div>

      {tab === "by-me" && (
        <div className="card">
          <div className="empty">
            <span className="ei"><Share2 size={24} /></span>
            <span className="eh">Outbound shares coming soon</span>
            <span style={{ maxWidth: "44ch" }}>
              Open a file in <strong>Files</strong> and click the share icon to create a link.
            </span>
          </div>
        </div>
      )}

      {tab === "with-me" && isLoading && visibleShares.length === 0 && (
        <div className="card">
          <div className="empty">
            <span>Loading…</span>
          </div>
        </div>
      )}

      {tab === "with-me" && !isLoading && visibleShares.length === 0 && (
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

      {tab === "with-me" && visibleShares.length > 0 && (
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
                      {share.ownerDisplayName || share.uidOwner || "Unknown owner"}
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
