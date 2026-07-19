"use client";

/**
 * WARP-1270 (T18) — Surface D, zone 1: /admin/files "Company files" usage
 * roster (design brief §5). Business-gated + owner/admin, mirroring the
 * /admin/audit route-guard pattern (client check here, real enforcement
 * server-side: GET /api/admin/files/usage and GET /api/departments both
 * `requireRole`-gate their own data).
 *
 * Two tables: people usage (avatar, name, storage meter, largest-upload
 * override, last-active) and libraries (departments & teams — name, size/
 * quota, member count, "Open library" jump to /files with that space
 * active). A single Instrument Serif hero number sits above them — the
 * ONE display-face use in this feature (design brief §1).
 *
 * The personal-file oversight zone (WARP-1272, owner-only, D-1-gated) is
 * EXPLICITLY OUT OF SCOPE for this ticket — nothing renders for it, not
 * even a teaser or a lock icon. Do not add a placeholder here.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, FolderLock, ShieldOff, Users as UsersIcon } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { fetchAdminFilesUsage, listDepartments } from "@/lib/api";
import type { AdminFilesUsageResponse, Department } from "@/lib/types";
import { ShellPage } from "@/components/shell/ShellPage";

/** Bytes-decimal-string ("—" on read failure, passed straight through) →
 *  a short human size. Never fabricates a value on bad/unknown input. */
function formatBytes(value: string | null | undefined): string {
  if (value == null) return "—";
  if (value === "—") return "—";
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = n;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

/** Same formatter, GB-precision, for the serif hero (no unit suffix noise
 *  at that scale — always renders in GB/TB via formatBytes' own ladder). */
function formatBytesLoose(n: number): string {
  return formatBytes(String(Math.round(n)));
}

function initials(name: string): string {
  return (
    name
      .split(" ")
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

export default function AdminFilesPage() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const isAdminTier = !authLoading && (user?.role === "owner" || user?.role === "admin");

  const [usage, setUsage] = useState<AdminFilesUsageResponse | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdminTier) return;
    let alive = true;
    setLoading(true);
    Promise.all([fetchAdminFilesUsage(), listDepartments()])
      .then(([usageData, deptData]) => {
        if (!alive) return;
        setUsage(usageData);
        setDepartments(deptData.departments || []);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.message || "Failed to load company files usage");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [isAdminTier]);

  const memberCountById = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of departments) map.set(d.id, d.memberCount);
    return map;
  }, [departments]);

  const kindById = useMemo(() => {
    const map = new Map<string, Department["kind"]>();
    for (const d of departments) map.set(d.id, d.kind);
    return map;
  }, [departments]);

  // Total company storage: sum of every person's used bytes + every
  // library's used bytes. "—" (read failure) and unparseable rows are
  // skipped rather than treated as 0 — the hero is a best-effort total,
  // never a false precision claim.
  const totalBytes = useMemo(() => {
    if (!usage) return null;
    let sum = 0;
    let any = false;
    for (const u of usage.users) {
      const n = Number(u.used);
      if (Number.isFinite(n)) {
        sum += n;
        any = true;
      }
    }
    for (const d of usage.departments) {
      const n = Number(d.sizeBytes);
      if (Number.isFinite(n)) {
        sum += n;
        any = true;
      }
    }
    return any ? sum : null;
  }, [usage]);

  function openLibrary(departmentId: string) {
    router.push(`/files?space=${encodeURIComponent(`dept:${departmentId}`)}`);
  }

  if (!authLoading && !isAdminTier) {
    return (
      <ShellPage icon={<FolderLock size={15} />} label="Company files" title="Company files">
        <div className="card">
          <div className="empty">
            <span className="ei">
              <ShieldOff size={24} />
            </span>
            <span className="eh">Admin access required</span>
            <span style={{ maxWidth: "32ch" }}>
              Only owners and administrators can view company file usage.
            </span>
          </div>
        </div>
      </ShellPage>
    );
  }

  return (
    <ShellPage
      icon={<FolderLock size={15} />}
      label="Company files"
      title="Company files"
      sub="Storage usage across every person and library on this Droplet."
    >
      {error && (
        <div
          className="card"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px",
            borderColor: "color-mix(in srgb, var(--color-system-red) 25%, transparent)",
            background: "color-mix(in srgb, var(--color-system-red) 8%, transparent)",
            color: "var(--color-system-red)",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {loading && !usage ? (
        <div className="card empty">Loading usage…</div>
      ) : (
        <>
          {/* Serif hero — the ONE Instrument Serif use in this feature. */}
          {totalBytes !== null && (
            <div className="card" style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 26 }}>
              <span className="type-display" style={{ fontSize: 56 }}>
                {formatBytesLoose(totalBytes)}
              </span>
              <span style={{ fontSize: 14, color: "var(--text-muted)" }}>
                total company storage used
              </span>
            </div>
          )}

          {/* People usage table */}
          <div className="sect">
            <h2>People</h2>
          </div>
          <div className="card">
            {(usage?.users ?? []).length === 0 ? (
              <div className="empty">No people yet.</div>
            ) : (
              <div className="rows">
                {(usage?.users ?? []).map((row) => (
                  <div key={row.userId} className="lrow">
                    <span className="ava">{initials(row.displayName)}</span>
                    <span className="rt">
                      <span className="nm">{row.displayName}</span>
                      <span className="sub mono">
                        {formatBytes(row.used)} / {row.quota != null ? formatBytes(row.quota) : "No limit"}
                      </span>
                    </span>
                    <span className="rmeta mono" title="Largest single upload">
                      {row.largestUploadMb != null ? `${row.largestUploadMb} MB` : "Device default"}
                    </span>
                    <span className="rmeta mono">{row.lastActive ?? "—"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Libraries table */}
          <div className="sect">
            <h2>Libraries</h2>
          </div>
          <div className="card">
            {(usage?.departments ?? []).length === 0 ? (
              <div className="empty">No department libraries yet.</div>
            ) : (
              <div className="rows">
                {(usage?.departments ?? []).map((lib) => {
                  const kind = kindById.get(lib.id) ?? lib.kind;
                  const Icon = kind === "TEAM" ? UsersIcon : Building2;
                  const memberCount = memberCountById.get(lib.id);
                  return (
                    <div key={lib.id} className="lrow">
                      <span
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 9,
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          background: "var(--brand-subtle)",
                          color: "var(--brand)",
                        }}
                      >
                        <Icon size={15} />
                      </span>
                      <span className="rt">
                        <span className="nm">{lib.name}</span>
                        <span className="sub mono">
                          {formatBytes(lib.sizeBytes)} / {lib.quotaBytes != null ? formatBytes(lib.quotaBytes) : "No limit"}
                        </span>
                      </span>
                      <span className="rmeta mono">
                        {memberCount != null ? `${memberCount} ${memberCount === 1 ? "member" : "members"}` : "—"}
                      </span>
                      <button type="button" className="btn ghost sm" onClick={() => openLibrary(lib.id)}>
                        Open library
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </ShellPage>
  );
}
