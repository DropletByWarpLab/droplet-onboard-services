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

  // "Shared by me" is a future enhancement — it would need a GET /shares
  // endpoint with a reverse filter. For now the tab is visible but empty with
  // a helpful message, so the UX structure is in place for Phase 3+.
  const visibleShares: ShareDetail[] = useMemo(() => {
    if (tab === "with-me") return items;
    return [];
  }, [tab, items]);

  return (
    <div className="p-6 lg:p-8 max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/files"
          className="p-1.5 rounded-full text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
          aria-label="Back to files"
        >
          <ArrowLeft size={18} />
        </Link>
        <h1 className="type-large-title text-label-primary">Shared</h1>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-separator">
        <button
          onClick={() => setTab("with-me")}
          className={`px-4 py-2 type-subheadline transition-colors relative ${
            tab === "with-me"
              ? "text-accent font-medium"
              : "text-label-tertiary hover:text-label-primary"
          }`}
        >
          Shared with me
          {tab === "with-me" && (
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />
          )}
        </button>
        <button
          onClick={() => setTab("by-me")}
          className={`px-4 py-2 type-subheadline transition-colors relative ${
            tab === "by-me"
              ? "text-accent font-medium"
              : "text-label-tertiary hover:text-label-primary"
          }`}
        >
          Shared by me
          {tab === "by-me" && (
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />
          )}
        </button>
      </div>

      {tab === "by-me" && (
        <div className="dp-card py-16 flex flex-col items-center justify-center text-label-tertiary">
          <Share2 size={32} className="mb-3 text-label-quaternary" />
          <p className="type-subheadline">Outbound shares coming soon</p>
          <p className="type-caption-1 mt-1 text-label-quaternary text-center max-w-sm">
            Open a file in <strong>Files</strong> and click the share icon to create a link.
          </p>
        </div>
      )}

      {tab === "with-me" && isLoading && visibleShares.length === 0 && (
        <div className="dp-group min-h-[240px] flex items-center justify-center text-label-tertiary type-subheadline">
          Loading…
        </div>
      )}

      {tab === "with-me" && !isLoading && visibleShares.length === 0 && (
        <div className="dp-card py-16 flex flex-col items-center justify-center text-label-tertiary">
          <Share2 size={32} className="mb-3 text-label-quaternary" />
          <p className="type-subheadline">Nothing shared with you yet</p>
          <p className="type-caption-1 mt-1 text-label-quaternary text-center max-w-sm">
            When other users on this Droplet share a file with you, it&apos;ll show up here.
          </p>
        </div>
      )}

      {tab === "with-me" && visibleShares.length > 0 && (
        <div className="dp-group">
          {visibleShares.map((share) => {
            const { label, icon: TypeIcon } = formatShareType(share.shareType);
            const fileName = (share.path || "").split("/").pop() || share.path;
            return (
              <div
                key={share.id}
                className="flex items-center gap-3 px-4 py-3 min-h-[56px] group"
              >
                <div className="w-9 h-9 rounded bg-accent-subtle flex items-center justify-center flex-shrink-0">
                  <TypeIcon size={16} className="text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="type-callout text-label-primary truncate">
                    {fileName || "Shared item"}
                  </p>
                  <p className="type-caption-2 text-label-tertiary truncate">
                    {share.ownerDisplayName || share.uidOwner || "Unknown owner"}
                    {" · "}
                    {label}
                    {share.stime ? ` · ${formatStime(share.stime)}` : ""}
                  </p>
                </div>
                {share.url && (
                  <a
                    href={share.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1.5 rounded-full text-label-tertiary hover:text-accent hover:bg-accent-subtle transition-colors"
                    onClick={(e) => {
                      if (!share.url) {
                        e.preventDefault();
                        toast("No link available for this share");
                      }
                    }}
                    title="Open link"
                  >
                    <ExternalLink size={14} />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
