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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, FolderLock, FolderPlus, ShieldOff, Users as UsersIcon } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { fetchAdminFilesUsage, listDepartments } from "@/lib/api";
import type { AdminFilesUsageResponse, Department } from "@/lib/types";
import { ShellPage } from "@/components/shell/ShellPage";
import { UploadButton } from "@/components/UploadZone";
import { CreateLibraryDialog } from "@/components/Departments/CreateLibraryDialog";
import type { DroppedSelection } from "@/components/FileManager/dropped-entries";
import { requiredDirectories } from "@/components/FileManager/dropped-entries";
import { runUpload } from "@/lib/run-upload";
import { uploadOutcomeMessage, uploadProgressLabel } from "@/lib/upload-feedback";
import { useSpaces } from "@/lib/hooks/useSpaces";
import { useToast } from "@/components/Toast";

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

  const reload = useCallback(async () => {
    const [usageData, deptData] = await Promise.all([
      fetchAdminFilesUsage(),
      listDepartments(),
    ]);
    setUsage(usageData);
    setDepartments(deptData.departments || []);
    setError(null);
  }, []);

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

  // ── WARP-1506: adding a file, and creating a library ──
  //
  // Company storage is SHARED, multi-user storage: this is a different write
  // from a personal upload, and the enforcement is the server's, not this
  // page's. `POST /api/files/upload?space=shared` is already gated by
  // `requireRoleOrMcpService("owner","admin","family")` +
  // `requireSpaceAccess(prisma, "contributor")`, which resolves `shared` to
  // the seeded HOUSEHOLD department. `POST /api/departments` is already
  // `requireRole("owner","admin")`. No endpoint was added for this ticket —
  // everything below is the courtesy layer on top of gates that exist.
  const { toast } = useToast();
  const { spaces } = useSpaces();
  const companySpace = useMemo(
    () => spaces.find((s) => s.id === "shared") ?? null,
    [spaces],
  );
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [newLibraryOpen, setNewLibraryOpen] = useState(false);
  const newLibraryTriggerRef = useRef<HTMLButtonElement | null>(null);

  const handleUpload = useCallback(
    async (selection: DroppedSelection) => {
      const { uploads, directories } = selection;
      // This surface only has the header pickers — a `<input type="file">`
      // never yields an empty folder or an unreadable file, so there is no
      // zero-file drop to give a voice to here (unlike /files).
      if (uploads.length === 0 || !companySpace) return;
      setUploadPercent(0);
      setUploadStatus(
        uploadProgressLabel(
          uploads.length,
          requiredDirectories(uploads, directories).length,
        ),
      );
      try {
        const { uploaded, total, skipped, cause } = await runUpload(selection, {
          // The company space's own root — `rootForSpace` applies the mount
          // prefix server-side, so "/" here is the top of the shared library.
          basePath: "/",
          space: companySpace.id,
          onProgress: setUploadPercent,
        });
        if (uploaded > 0) await reload().catch(() => undefined);
        const failure = uploadOutcomeMessage(uploaded, total, cause, skipped);
        toast(
          failure ??
            `Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"} to ${companySpace.name}.`,
        );
      } finally {
        setUploadStatus(null);
        setUploadPercent(0);
      }
    },
    [companySpace, reload, toast],
  );

  const handleLibraryCreated = useCallback(
    async (created: Department) => {
      // The server returns state=pending and a reconciler provisions the
      // groupfolder — re-read rather than fabricating an active row.
      await reload().catch(() => undefined);
      toast(`${created.name} is setting up…`);
    },
    [reload, toast],
  );

  const memberCountById = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of departments) map.set(d.id, d.memberCount);
    return map;
  }, [departments]);

  const librariesExist = (usage?.departments ?? []).length > 0;

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
      actions={
        <UploadButton
          onUpload={handleUpload}
          disabled={!companySpace}
          title={
            companySpace
              ? `Adds to ${companySpace.name} — everyone with access can see it.`
              : "Company storage isn't set up on this Droplet yet."
          }
        />
      }
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

      {/* WARP-1506 — upload progress. Same shape as the Files page's bar so
          the two upload surfaces read as one behaviour. */}
      {uploadStatus && (
        <div
          role="status"
          className="mb-4 p-3 rounded type-footnote"
          style={{
            background: "var(--brand-subtle)",
            border: "1px solid color-mix(in srgb, var(--brand) 20%, transparent)",
            color: "var(--brand)",
          }}
        >
          <div className="mb-2">
            {uploadStatus} {uploadPercent > 0 && `${uploadPercent}%`}
          </div>
          <div
            className="h-1.5 rounded-full overflow-hidden"
            style={{ background: "var(--inset)" }}
          >
            <div
              className="h-full rounded-full transition-all duration-300 ease-out"
              style={{ width: `${uploadPercent}%`, background: "var(--brand)" }}
            />
          </div>
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

          {/* Libraries table.
              WARP-1506 — the section had no way to create one, and its empty
              state was a dead sentence. Exactly ONE "New library" control is
              on screen at a time: the empty state owns it while there is
              nothing to list (that's where a first-time admin is looking),
              and it moves up to the section header once there is a list to
              sit above. */}
          <div className="sect" style={{ alignItems: "center" }}>
            <h2>Libraries</h2>
            {librariesExist && (
              <button
                ref={newLibraryTriggerRef}
                type="button"
                className="btn ghost sm"
                style={{ marginLeft: "auto" }}
                onClick={() => setNewLibraryOpen(true)}
              >
                <FolderPlus size={13} aria-hidden="true" /> New library
              </button>
            )}
          </div>
          <div className="card">
            {!librariesExist ? (
              <div className="empty">
                <span className="ei">
                  <Building2 size={24} aria-hidden="true" />
                </span>
                <span className="eh">No department libraries yet</span>
                <span style={{ maxWidth: "38ch" }}>
                  A library is shared storage for one department — Finance,
                  Operations, whoever needs a space of their own.
                </span>
                <button
                  ref={newLibraryTriggerRef}
                  type="button"
                  className="btn primary"
                  style={{ marginTop: 4 }}
                  onClick={() => setNewLibraryOpen(true)}
                >
                  <FolderPlus size={14} aria-hidden="true" /> New library
                </button>
              </div>
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

      {/* WARP-1506 — the same dialog the departments admin uses; "library"
          is this page's noun for the same thing. */}
      <CreateLibraryDialog
        open={newLibraryOpen}
        onClose={() => setNewLibraryOpen(false)}
        onCreated={handleLibraryCreated}
        triggerRef={newLibraryTriggerRef}
        heading="New library"
        submitLabel="Create library"
      />
    </ShellPage>
  );
}
