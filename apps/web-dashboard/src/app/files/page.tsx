"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Folder,
  FolderPlus,
  Link as LinkIcon,
  X,
  Eye,
  Star,
  ShieldCheck,
} from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useToast } from "@/components/Toast";
import { BreadcrumbNav } from "@/components/BreadcrumbNav";
import { UploadZone, UploadButton } from "@/components/UploadZone";
import { FileRow } from "@/components/FileManager/FileRow";
import {
  ContextMenu,
  contextMenuIcons,
  type ContextMenuItem,
} from "@/components/FileManager/ContextMenu";
import { SelectionToolbar } from "@/components/FileManager/SelectionToolbar";
import { MoveCopyDialog } from "@/components/FileManager/MoveCopyDialog";
import { VersionHistoryPanel } from "@/components/FileManager/VersionHistoryPanel";
import { TagChips } from "@/components/FileManager/TagChips";
import { CommentsPanel } from "@/components/FileManager/CommentsPanel";
import { SearchBar } from "@/components/FileManager/SearchBar";
import { PreviewPane } from "@/components/FileManager/PreviewPane";
import { DocEditorPanel } from "@/components/FileManager/DocEditorPanel";
import { ShareDialog } from "@/components/FileManager/ShareDialog";
import { SpaceSwitcher } from "@/components/FileManager/SpaceSwitcher";
import {
  resolveSearchResultTarget,
  toSpaceRelativePath,
} from "@/components/FileManager/search-target";
import { StarButton } from "@/components/FileManager/StarButton";
import { Thumbnail } from "@/components/FileManager/Thumbnail";
import { VolumesPanel } from "@/components/FileManager/VolumesPanel";
import { volumeCrumbLabel } from "@/components/FileManager/drive-display";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useFiles } from "@/lib/hooks/useFiles";
import { useDrives } from "@/lib/hooks/useDrives";
import { usePools } from "@/lib/hooks/usePools";
import { useFileManager } from "@/lib/hooks/useFileManager";
import { useFavorites } from "@/lib/hooks/useFavorites";
import { useFileRealtime } from "@/lib/hooks/useFileRealtime";
import { useSpaces } from "@/lib/hooks/useSpaces";
import {
  uploadFiles,
  UploadBatchError,
  deleteFile,
  createDirectory,
  getDownloadUrl,
  renameFile,
  bulkDeleteFiles,
  bulkMoveFiles,
  bulkCopyFiles,
  fetchShares,
} from "@/lib/api";
import { authFetch, useAuth } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";
import type { FileEntryInfo, FileSpaceId, ShareDetail } from "@/lib/types";

// WARP-1267 — verbatim copy (design brief §2).
const READER_TOOLBAR_TOOLTIP =
  "You can view and download here. Ask a manager for edit access.";
const ADMIN_FOREIGN_LIBRARY_COPY =
  "You're viewing this library as an administrator. This visit is logged.";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// WARP-1547 — the Files page's address is the (space, path) PAIR, and this is
// the only function that writes it. Both live in the query string
// (`/files?space=dept:<uuid>&path=/Contracts/2026`); both are read back by the
// single URL→view effect below.
//
// The defaults — the personal space and a space's root — are OMITTED, so the
// plain surface stays `/files`, a volume deep-link stays `/files?path=…`, and
// the library jump stays exactly the `/files?space=dept%3A<id>` shape
// /admin/files already links to (URLSearchParams percent-encodes the same way
// encodeURIComponent does for these values).
function buildFilesUrl(space: FileSpaceId, path: string): string {
  const qs = new URLSearchParams();
  if (space && space !== "personal") qs.set("space", space);
  if (path && path !== "/") qs.set("path", path);
  const query = qs.toString();
  return query ? `/files?${query}` : "/files";
}

export default function FilesPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialPath = searchParams?.get("path") ?? "/";
  const [currentPath, setCurrentPath] = useState(initialPath);
  // WARP-883 — active Files space (My Files vs shared Household). Switching
  // resets the path to that space's root and re-lists.
  const [space, setSpace] = useState<FileSpaceId>("personal");
  const { spaces, sharedAvailable } = useSpaces();
  const { user } = useAuth();
  const isOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";
  // WARP-1267 — the active space's full record (rights, kind, membership,
  // parent name) drives reader posture, the admin foreign-library banner,
  // and the team breadcrumb prefix below.
  const activeSpace = useMemo(
    () => spaces.find((s) => s.id === space),
    [spaces, space]
  );
  const isReaderSpace = activeSpace?.right === "reader";
  const isTeamSpace = activeSpace?.kind === "team";

  // WARP-1267 — admin-in-foreign-library banner (design brief §2): shown
  // only to an owner/admin who is NOT a member of the active department/
  // team, dismissible per visit. `space` in the dep array means switching
  // away and back resets the dismissal — "returns on space re-entry".
  const [bannerDismissed, setBannerDismissed] = useState(false);
  useEffect(() => {
    setBannerDismissed(false);
  }, [space]);
  const showAdminForeignBanner =
    isOwnerOrAdmin &&
    !!activeSpace &&
    (activeSpace.kind === "department" || activeSpace.kind === "team") &&
    activeSpace.isMember === false &&
    !bannerDismissed;

  // WARP-1140: the shared space's home-relative root (e.g. "/Household") —
  // needed to translate between home-relative entry/search-result paths and
  // the space-root-relative `currentPath`.
  const sharedRoot = useMemo(
    () => spaces.find((s) => s.id === "shared")?.root ?? null,
    [spaces]
  );
  // WARP-1247: the Move/Copy dialog's picker tree and confirm handler are
  // HOME-relative (the picker is not space-aware — see handleMoveCopyConfirm),
  // so its seed must be the home-relative form of the space-relative
  // `currentPath`. Generalized to any space via the active space's root.
  const activeSpaceRoot = useMemo(
    () => spaces.find((s) => s.id === space)?.root ?? "/",
    [spaces, space]
  );
  const homeRelativeCurrentPath = useMemo(() => {
    if (!activeSpaceRoot || activeSpaceRoot === "/") return currentPath;
    return currentPath === "/" ? activeSpaceRoot : `${activeSpaceRoot}${currentPath}`;
  }, [activeSpaceRoot, currentPath]);
  // WARP-1262 (T10): write destinations rooted at `currentPath` (upload,
  // new-folder, paste-into-current-folder) are already SPACE-relative — the
  // exact shape the write routes now resolve server-side via
  // `?space=`/body `space` — so they're passed straight through with the
  // active `space` alongside. This replaces the WARP-1200 client-side
  // `toHomeRelativePath` pre-translation (which built the HOME-relative
  // form by hand); the server now owns that resolution.
  //
  // Listing entries, by contrast, always carry HOME-relative paths
  // (WARP-1140) — a selected file's `.path` is "/Household/Trips/x.pdf",
  // not the space-relative "/Trips/x.pdf" the write routes expect. Any
  // handler that operates on an entry path (delete/rename/move/copy/
  // favorite) must convert with this helper before calling the API.
  //
  // WARP-1623: keyed on the ACTIVE space's root, not on the `shared` id. The
  // old form only stripped the Household mount, so once a `dept:` listing
  // reached the wire, a library row's "/Finance/Q1/x.pdf" would have been sent
  // verbatim to a write route that re-prefixes the mount. The personal root is
  // "/", for which `toSpaceRelativePath` is the identity — so personal needs no
  // special case here.
  const toActiveSpaceRelative = useCallback(
    (p: string) => toSpaceRelativePath(p, activeSpaceRoot),
    [activeSpaceRoot]
  );
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // Reader posture (WARP-1267): close a still-open new-folder composer if
  // the active space becomes read-only out from under it (space switch).
  useEffect(() => {
    if (isReaderSpace) setShowNewFolder(false);
  }, [isReaderSpace]);
  const [selectedFile, setSelectedFile] = useState<FileEntryInfo | null>(null);
  const [previewFile, setPreviewFile] = useState<FileEntryInfo | null>(null);
  // WARP-882: the file currently open in the in-browser editor.
  const [editorFile, setEditorFile] = useState<FileEntryInfo | null>(null);
  const [shareFile, setShareFile] = useState<FileEntryInfo | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FileEntryInfo;
  } | null>(null);
  const [moveDialog, setMoveDialog] = useState<{
    mode: "move" | "copy";
    paths: string[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // NOTE (WARP-1547): `?path=` used to be re-applied by its own effect here,
  // separately from `?space=` further down — the two raced and the space one
  // won, so `?space=…&path=/Sub` always landed on the library root. Both
  // params are now applied together by the single URL→view effect below.

  // Subscribe to live file events so uploads/renames/etc. from other tabs,
  // the CLI, or native clients show up immediately — no polling.
  useFileRealtime();

  // WARP-883 (WS-1 fast-follow) — shares already on the file being shared, so
  // the ShareDialog lists pre-existing links (not just session-created ones).
  //
  // NOTE: this useCallback MUST be declared ABOVE the useEffect that depends on
  // it. The effect's dependency array `[shareFile, loadExistingShares]` is read
  // during render; if the `const loadExistingShares` were declared later, the
  // page would throw a temporal-dead-zone ReferenceError on first render and
  // white-screen the whole Files surface (QA finding, WARP-883).
  const [existingShares, setExistingShares] = useState<ShareDetail[]>([]);
  const loadExistingShares = useCallback(async (filePath: string) => {
    try {
      setExistingShares(await fetchShares(filePath));
    } catch {
      // Non-fatal — the dialog still works for creating new links.
      setExistingShares([]);
    }
  }, []);

  // WARP-883 (WS-1 fast-follow) — load the shares already on a file the moment
  // the share dialog opens for it, so the dialog shows pre-existing links.
  useEffect(() => {
    if (shareFile) loadExistingShares(shareFile.path);
  }, [shareFile, loadExistingShares]);

  // WARP-1338: destructure the listing error too — a failed WebDAV listing
  // (e.g. the 404 a drive tile deep-link hits before the drive is registered
  // in Nextcloud) must render as a distinct failure state, never masquerade
  // as the false "This folder is empty".
  const { files, isLoading, error: listingError, refresh } = useFiles(currentPath, space);
  const fm = useFileManager(currentPath);

  // WARP-1338 (UX review): the not-connected copy is keyed to its CAUSE —
  // the 404 an unregistered drive actually hits (fetchFiles embeds the HTTP
  // status in the thrown message) — not merely to being below root, so a
  // transient failure deep inside a healthy, registered drive never claims
  // the drive "isn't connected".
  const driveNotConnected =
    !!listingError &&
    currentPath !== "/" &&
    /\b404\b/.test(
      listingError instanceof Error ? listingError.message : String(listingError)
    );

  // WARP-1338 (UX review): a volume deep-link lands on /files?path=
  // /<mount-tail>; for the live box's legacy pool that tail is the full fs
  // UUID, and the current-folder crumb rendered it raw — a GUID must never
  // be the primary location label (WARP-1337). Feed the breadcrumb the SAME
  // display chain the tiles use for a first-segment volume match. SWR dedupes
  // these keys with VolumesPanel's own subscriptions.
  const { drives } = useDrives();
  const { pools } = usePools();
  const crumbLabelForSegment = useCallback(
    (segment: string, index: number) =>
      index === 0 && space === "personal"
        ? volumeCrumbLabel(segment, drives, pools)
        : undefined,
    [space, drives, pools]
  );

  // WARP-1547 — THE funnel. Every change of the active (space, path) pair
  // goes through here: the space switcher, the breadcrumbs, opening a folder,
  // picking a search result, and the URL→view effect below. Nothing else may
  // call `setSpace` — a second setter is how the rail, the listing and the URL
  // drift apart (the `SearchBar.onPickResult` bypass this ticket removed).
  //
  // WARP-883 — changing space clears the outgoing space's selection so it
  // can't leak across. The LANDING PATH is the caller's decision: the switcher
  // passes the new space's root (the preserved "switching resets to root"
  // behavior), while a deep link or a Back/Forward step passes the folder it
  // is actually addressing.
  const clearSelection = fm.clearSelection;
  const applyLocation = useCallback(
    (nextSpace: FileSpaceId, nextPath: string) => {
      if (nextSpace !== space) {
        setSpace(nextSpace);
        clearSelection();
      }
      setCurrentPath(nextPath || "/");
    },
    [space, clearSelection]
  );

  // WARP-1547 — funnel + URL write-back, for everything that MOVES the user.
  // The page previously never wrote the URL at all, so a folder inside a
  // library had no shareable link and browser Back left Files entirely.
  //
  // `push`, not `replace`: each folder needs its own history entry, which is
  // what makes Back/Forward walk folder history. The guard keeps a re-click on
  // the folder you're already in from stacking duplicate entries.
  const navigateTo = useCallback(
    (nextSpace: FileSpaceId, nextPath: string) => {
      const target = buildFilesUrl(nextSpace, nextPath || "/");
      applyLocation(nextSpace, nextPath);
      if (target !== buildFilesUrl(space, currentPath)) router.push(target);
    },
    [applyLocation, router, space, currentPath]
  );

  // WARP-883 — switch space: jump to that space's root and clear selection so
  // the previous space's selection/clipboard doesn't leak across.
  const handleSpaceChange = useCallback(
    (next: FileSpaceId) => {
      if (next === space) return;
      navigateTo(next, "/");
    },
    [space, navigateTo]
  );

  // WARP-1270 (T18) / WARP-1547 — URL → view, for BOTH params at once.
  //
  // `?space=` deep-links a specific library (the /admin/files "Open library"
  // jump, design brief §5) and `?path=` deep-links a folder inside it. These
  // used to be applied by two separate effects — `?path=` seeded state on
  // mount, then `?space=` landed once `spaces` resolved and reset the path to
  // the library root — so the pair could never round-trip. Applying them
  // together is the fix; holding the whole pair until `spaces` has loaded is
  // what stops the space from arriving late and clobbering the path again.
  //
  // Keyed on the query STRING (not the params object, whose identity churns),
  // so it re-runs for each distinct URL — including the ones the browser's
  // Back/Forward buttons restore, which is what moves the view through folder
  // history. `appliedSearchRef` makes it idempotent per URL, so a manual space
  // switch afterwards is not re-clobbered by the original deep link.
  const searchKey = searchParams?.toString() ?? "";
  const appliedSearchRef = useRef<string | null>(null);
  useEffect(() => {
    if (appliedSearchRef.current === searchKey) return;
    const requestedSpace = searchParams?.get("space") ?? null;
    if (requestedSpace && spaces.length === 0) return;
    appliedSearchRef.current = searchKey;
    // A stale/unknown/inaccessible space id (archived library, typo'd link, a
    // library this viewer can't reach) falls back to the personal space
    // silently — same fail-safe as before. Deliberately no error surface and
    // no server call: the response must not confirm or deny that the id
    // exists.
    const nextSpace =
      requestedSpace && spaces.some((s) => s.id === requestedSpace)
        ? requestedSpace
        : "personal";
    applyLocation(nextSpace, searchParams?.get("path") ?? "/");
  }, [searchKey, searchParams, spaces, applyLocation]);

  const { items: favoriteItems, refresh: refreshFavorites } = useFavorites();
  const favoritedPaths = useMemo(
    () => new Set(favoriteItems.map((f) => f.path)),
    [favoriteItems]
  );

  // ── Upload ──
  const handleUpload = useCallback(
    async (fileList: FileList) => {
      setIsUploading(true);
      setError(null);
      setUploadPercent(0);
      const count = fileList.length;
      setUploadProgress(`Uploading ${count} file${count > 1 ? "s" : ""}...`);
      try {
        await uploadFiles(
          currentPath,
          fileList,
          (percent) => {
            setUploadPercent(percent);
          },
          space
        );
        await refresh();
        setUploadProgress(null);
      } catch (err) {
        // WARP-1666: a large selection is uploaded in batches, so a failure
        // partway through still leaves earlier batches on the box. Refresh so
        // those files actually appear, and say how many landed rather than
        // implying the whole upload was lost. `translateError` deliberately
        // never echoes a raw message, so the count is composed here from the
        // typed error instead of read out of `err.message`.
        if (err instanceof UploadBatchError && err.uploaded > 0) {
          console.error("partial upload", err.cause);
          await refresh();
          toast(
            `Uploaded ${err.uploaded} of ${err.total} files. The rest didn't upload — try again to finish.`
          );
        } else {
          toast(
            translateError(
              err instanceof UploadBatchError ? err.cause : err,
              "files"
            )
          );
        }
        setUploadProgress(null);
      } finally {
        setIsUploading(false);
        setUploadPercent(0);
      }
    },
    [currentPath, space, refresh, toast]
  );

  // ── Download ──
  const handleDownload = useCallback(
    (filePath: string) => {
      const url = getDownloadUrl(filePath);
      authFetch(url)
        .then((res) => res.blob())
        .then((blob) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = filePath.split("/").pop() || "download";
          a.click();
          URL.revokeObjectURL(a.href);
        })
        .catch(() => toast("Download failed"));
    },
    [toast]
  );

  const handleBulkDownload = useCallback(() => {
    for (const p of fm.selectedPaths) {
      const file = files.find((f) => f.path === p);
      if (file && !file.isDirectory) handleDownload(p);
    }
  }, [fm.selectedPaths, files, handleDownload]);

  // ── Delete / bulk delete ──
  //
  // Both flows route through <ConfirmDialog>. Single-file delete stores
  // the path string in pendingDeletePath; bulk delete just stores `true`
  // (the paths are already in `fm.selectedPaths`).
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);

  const handleDelete = useCallback((filePath: string) => {
    setPendingDeletePath(filePath);
  }, []);

  const performDelete = useCallback(async () => {
    const filePath = pendingDeletePath;
    if (!filePath) return;
    try {
      await deleteFile(toActiveSpaceRelative(filePath), space);
      if (selectedFile?.path === filePath) setSelectedFile(null);
      fm.clearSelection();
      setPendingDeletePath(null);
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
      throw err;
    }
  }, [pendingDeletePath, selectedFile, refresh, toast, fm, toActiveSpaceRelative, space]);

  const handleBulkDelete = useCallback(() => {
    if (fm.selectedCount === 0) return;
    setPendingBulkDelete(true);
  }, [fm.selectedCount]);

  const performBulkDelete = useCallback(async () => {
    try {
      const results = await bulkDeleteFiles(
        fm.selectedPaths.map(toActiveSpaceRelative),
        space
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        toast(`${failed.length} item(s) failed to delete`);
      }
      fm.clearSelection();
      setSelectedFile(null);
      setPendingBulkDelete(false);
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
      throw err;
    }
  }, [fm, refresh, toast, toActiveSpaceRelative, space]);

  // ── New folder ──
  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    const folderPath =
      currentPath === "/"
        ? `/${newFolderName.trim()}`
        : `${currentPath}/${newFolderName.trim()}`;
    try {
      await createDirectory(folderPath, space);
      setNewFolderName("");
      setShowNewFolder(false);
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
    }
  }, [currentPath, space, newFolderName, refresh, toast]);

  // ── Share (opens full dialog) ──
  const handleShare = useCallback((file: FileEntryInfo) => {
    setShareFile(file);
  }, []);

  // ── Preview (opens rich preview modal) ──
  const handlePreview = useCallback((file: FileEntryInfo) => {
    if (file.isDirectory) return;
    setPreviewFile(file);
  }, []);

  // WARP-1143 — Home "Recent files" deep link: `?preview=<path>` (read once on
  // mount, same pattern as the calendar's `?date=`) selects + previews that
  // file once the target folder's listing has loaded. A target that no longer
  // resolves (deleted/unindexed since the recents snapshot) fails with a toast,
  // not silently.
  const [pendingPreviewPath, setPendingPreviewPath] = useState<string | null>(
    () => searchParams?.get("preview") ?? null
  );
  useEffect(() => {
    if (!pendingPreviewPath || isLoading) return;
    const target = files.find((f) => f.path === pendingPreviewPath);
    setPendingPreviewPath(null);
    if (target && !target.isDirectory) {
      setSelectedFile(target);
      handlePreview(target);
    } else {
      toast("Couldn't open that file — it may have been moved or deleted.");
    }
  }, [pendingPreviewPath, isLoading, files, handlePreview, toast]);

  // ── Rename ──
  const handleRenameCommit = useCallback(
    async (file: FileEntryInfo, newName: string) => {
      try {
        await renameFile(toActiveSpaceRelative(file.path), newName, space);
        fm.endRename();
        if (selectedFile?.path === file.path) setSelectedFile(null);
        await refresh();
      } catch (err) {
        toast(translateError(err, "files"));
        fm.endRename();
      }
    },
    [fm, selectedFile, refresh, toast, toActiveSpaceRelative, space]
  );

  // ── Move / copy (bulk via dialog) ──
  //
  // WARP-1262 (T10): the picker (<MoveCopyDialog>) only ever browses the
  // PERSONAL space (T15's job to make it space-aware) — `moveDialog.paths`
  // (HOME-relative entry paths) and `targetDir` (personal-relative, from the
  // dialog's own tree) are left unconverted and sent with no `space` arg
  // (defaults "personal"), unchanged from pre-T10. Threading the active
  // `space` here without also making the picker space-aware would silently
  // mis-resolve `targetDir` under a space it was never browsed in.
  const handleMoveCopyConfirm = useCallback(
    async (targetDir: string) => {
      if (!moveDialog) return;
      try {
        if (moveDialog.mode === "move") {
          const results = await bulkMoveFiles(moveDialog.paths, targetDir);
          const failed = results.filter((r) => !r.ok);
          if (failed.length > 0) toast(`${failed.length} move(s) failed`);
        } else {
          const results = await bulkCopyFiles(moveDialog.paths, targetDir);
          const failed = results.filter((r) => !r.ok);
          if (failed.length > 0) toast(`${failed.length} copy(s) failed`);
        }
        fm.clearSelection();
        setMoveDialog(null);
        await refresh();
      } catch (err) {
        toast(translateError(err, "files"));
      }
    },
    [moveDialog, fm, refresh, toast]
  );

  const handlePasteClipboard = useCallback(async () => {
    if (!fm.clipboard) return;
    try {
      // WARP-1262 (T10): clipboard paths are home-relative entry paths
      // (WARP-1140) — converted to the active space's space-relative form,
      // same as every other entry-path write below. The paste DESTINATION
      // (`currentPath`) is already space-relative, so it's passed straight
      // through with the active `space`.
      const paths = fm.clipboard.paths.map(toActiveSpaceRelative);
      if (fm.clipboard.mode === "cut") {
        const results = await bulkMoveFiles(paths, currentPath, false, space);
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) toast(`${failed.length} move(s) failed`);
      } else {
        const results = await bulkCopyFiles(paths, currentPath, false, space);
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) toast(`${failed.length} copy(s) failed`);
      }
      fm.clearClipboard();
      fm.clearSelection();
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
    }
  }, [fm, currentPath, space, refresh, toast, toActiveSpaceRelative]);

  // ── Row click / open ──
  const handleRowSelect = useCallback(
    (file: FileEntryInfo, e: React.MouseEvent) => {
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;
      const mode = isShift ? "range" : isCtrlOrMeta ? "toggle" : "replace";
      fm.toggleSelection(file.path, mode, files);

      if (!isCtrlOrMeta && !isShift && !file.isDirectory) {
        setSelectedFile(file);
      }
    },
    [fm, files]
  );

  // Double-click / Enter on a row. Folders navigate in; files open the rich
  // preview modal (Samantha QA #bugs — opening a file used to drop into the
  // info sidebar, which is the SINGLE-click affordance via handleRowSelect).
  const handleRowOpen = useCallback((file: FileEntryInfo) => {
    if (file.isDirectory) {
      // WARP-1140: listing entries carry HOME-relative paths ("/Household/…")
      // but `currentPath` is relative to the ACTIVE space's root. Feeding the
      // entry path back verbatim while the Household tab is active
      // double-prefixed the next listing ("/Household/Household/…"), which
      // rendered as a silently empty folder.
      //
      // WARP-1547: through the funnel, so the URL follows the user into the
      // folder — that link is now shareable and Back returns to the parent.
      //
      // WARP-1623: that translation now runs for EVERY space with a mount, not
      // just Household — otherwise the same double-prefix reappears the moment
      // a `dept:` space is really listed ("/Finance/Finance/Q1"), and the URL
      // the funnel writes carries the double-prefixed path with it.
      navigateTo(space, toSpaceRelativePath(file.path, activeSpaceRoot));
      fm.clearSelection();
    } else {
      handlePreview(file);
    }
  }, [fm, handlePreview, space, activeSpaceRoot, navigateTo]);

  // ── Context menu ──
  const handleRowContextMenu = useCallback(
    (file: FileEntryInfo, x: number, y: number) => {
      // If the row isn't already part of selection, make it the only selected item
      if (!fm.isSelected(file.path)) {
        fm.selectOnly(file.path);
      }
      setContextMenu({ x, y, file });
    },
    [fm]
  );

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const file = contextMenu.file;
    const selectedCount = Math.max(fm.selectedCount, 1);
    const isSingle = selectedCount === 1;

    return [
      {
        label: file.isDirectory ? "Open" : "Preview",
        icon: contextMenuIcons.Open,
        disabled: !isSingle,
        onClick: () => (file.isDirectory ? handleRowOpen(file) : handlePreview(file)),
      },
      {
        label: "Download",
        icon: contextMenuIcons.Download,
        disabled: file.isDirectory,
        onClick: () => handleDownload(file.path),
      },
      { separator: true },
      {
        // WARP-1267 — reader posture (design brief §2): rename/move/delete
        // are visible-but-disabled inside a `reader`-right space, tooltip
        // copy carried via the item label's title isn't available on this
        // menu, so the disabled state alone communicates it (ContextMenu
        // has no per-item tooltip slot; the toolbar/row equivalents do).
        label: "Rename",
        icon: contextMenuIcons.Rename,
        disabled: !isSingle || isReaderSpace,
        onClick: () => fm.beginRename(file.path),
      },
      {
        label: `Cut${isSingle ? "" : ` (${selectedCount})`}`,
        icon: contextMenuIcons.Cut,
        disabled: isReaderSpace,
        onClick: () => fm.cut(),
      },
      {
        label: `Copy${isSingle ? "" : ` (${selectedCount})`}`,
        icon: contextMenuIcons.Copy,
        onClick: () => fm.copy(),
      },
      {
        label: `Move to…`,
        icon: contextMenuIcons.Cut,
        disabled: isReaderSpace,
        onClick: () =>
          setMoveDialog({
            mode: "move",
            paths: fm.selectedCount > 0 ? fm.selectedPaths : [file.path],
          }),
      },
      {
        label: `Copy to…`,
        icon: contextMenuIcons.Copy,
        onClick: () =>
          setMoveDialog({
            mode: "copy",
            paths: fm.selectedCount > 0 ? fm.selectedPaths : [file.path],
          }),
      },
      { separator: true },
      {
        label: "Share link",
        icon: contextMenuIcons.Share,
        disabled: !isSingle,
        onClick: () => handleShare(file),
      },
      {
        label: "Delete",
        icon: contextMenuIcons.Delete,
        destructive: true,
        disabled: isReaderSpace,
        onClick: () => {
          if (fm.selectedCount > 1) {
            void handleBulkDelete();
          } else {
            void handleDelete(file.path);
          }
        },
      },
    ];
  }, [
    contextMenu,
    fm,
    isReaderSpace,
    handleRowOpen,
    handlePreview,
    handleDownload,
    handleShare,
    handleDelete,
    handleBulkDelete,
  ]);

  // ── Selection toolbar actions ──
  //
  // WARP-1262 (T10): the dialog's tree only browses the PERSONAL space
  // (T15's job to make it space-aware) — these prefixes stay in the entries'
  // raw HOME-relative form to match, unconverted.
  const forbiddenPrefixes = useMemo(
    () => (moveDialog ? moveDialog.paths : []),
    [moveDialog]
  );

  const selectionLabels = useMemo(() => {
    if (!moveDialog) return [];
    return moveDialog.paths.map((p) => p.split("/").pop() || p);
  }, [moveDialog]);

  // ShellPage header action slot: New Folder + Upload. The file-system
  // BreadcrumbNav stays BELOW the header — it's intra-page navigation
  // (path within Files), distinct from the page-level "Files" header.
  const filesActions = (
    <>
      <button
        onClick={() => !isReaderSpace && setShowNewFolder(true)}
        disabled={isReaderSpace}
        aria-disabled={isReaderSpace || undefined}
        title={isReaderSpace ? READER_TOOLBAR_TOOLTIP : undefined}
        className="btn ghost"
        type="button"
      >
        <FolderPlus size={14} />
        <span className="hidden sm:inline">New folder</span>
      </button>
      <UploadButton
        onClick={() => fileInputRef.current?.click()}
        disabled={isReaderSpace}
        title={isReaderSpace ? READER_TOOLBAR_TOOLTIP : undefined}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && !isReaderSpace) handleUpload(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );

  return (
    <ShellPage
      icon={<Folder size={15} />}
      label="Files"
      title="Files"
      sub="Everything on your Droplet, indexed locally for instant, private search."
      actions={filesActions}
    >
      {/* Search bar.
          WARP-1139: `relative z-40` — the shell's ds-rise entrance animation
          (fill-mode: both, animates transform) leaves every `.page-inner`
          child in its own stacking context, so later siblings (the scope
          tabs, breadcrumbs, file rows) painted OVER the results dropdown
          despite its own z-index. Lifting this wrapper's stacking context
          above its z-auto siblings restores the expected layering. */}
      <div className="mb-4 relative z-40">
        <SearchBar
          onPickResult={(file) => {
            // WARP-1140: results are HOME-relative; one inside the shared
            // root must open in the Household space with the prefix stripped
            // (currentPath is space-root-relative), or the navigation lands
            // on a double-prefixed, silently empty listing.
            const target = resolveSearchResultTarget(
              file.path,
              sharedAvailable ? sharedRoot : null
            );
            // WARP-1547: this handler used to call `setSpace` directly —
            // the second space setter, bypassing the funnel, so a search
            // pick moved the listing without clearing selection through the
            // same path or touching the URL. It now goes through
            // `navigateTo` like every other move; the funnel owns the
            // space-change selection clear.
            if (file.isDirectory) {
              navigateTo(target.space, target.path);
            } else {
              // Jump to parent dir and mark the file selected (selection
              // compares against entry paths, which stay home-relative).
              const parent = target.path.replace(/\/[^/]*$/, "") || "/";
              navigateTo(target.space, parent);
              setSelectedFile(file);
            }
          }}
        />
      </div>

      {/* Space switcher (My Files / Household / N department+team spaces,
          WARP-1267). The switcher itself renders nothing when there's only
          one space to be in — no lone control.

          WARP-1667: `relative z-30` for the same reason the search bar above
          carries `relative z-40` — ds-rise's `fill-mode: both` makes every
          `.page-inner` child a permanent stacking context, so the Spaces
          menu's own z-index is trapped in this wrapper and the later
          siblings (breadcrumbs, banner, volumes, file rows) painted over it.
          z-30 and NOT z-40: a tie would go to this wrapper on DOM order and
          put the search results back underneath the pills (WARP-1139). */}
      <div className="mb-4 relative z-30">
        <SpaceSwitcher
          spaces={spaces}
          active={space}
          onChange={handleSpaceChange}
          isOwnerOrAdmin={isOwnerOrAdmin}
        />
      </div>

      {/* Breadcrumbs — team spaces get a non-navigating parent-department
          prefix crumb (WARP-1267, design brief §2). */}
      <div className="mb-4">
        <BreadcrumbNav
          path={currentPath}
          // WARP-1547 — through the funnel: crumb jumps are navigation, so
          // they get a URL and a history entry like any other move.
          onNavigate={(next) => navigateTo(space, next)}
          prefixCrumb={isTeamSpace ? activeSpace?.parentName : undefined}
          labelForSegment={crumbLabelForSegment}
        />
      </div>

      {/* Admin-in-foreign-library banner (WARP-1267, design brief §2) —
          owner/admin visiting a department/team library they're not a
          member of. Dismissible per visit; returns on space re-entry. */}
      {showAdminForeignBanner && (
        <div
          role="status"
          className="mb-4 flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border type-footnote text-label-primary"
          style={{
            borderColor: "color-mix(in srgb, var(--color-accent) 26%, var(--color-separator))",
            background: "color-mix(in srgb, var(--color-accent) 7%, var(--color-surface-primary))",
          }}
        >
          <ShieldCheck
            size={16}
            aria-hidden="true"
            className="flex-none text-accent"
          />
          <span className="flex-1 min-w-0">{ADMIN_FOREIGN_LIBRARY_COPY}</span>
          <button
            type="button"
            onClick={() => setBannerDismissed(true)}
            aria-label="Dismiss"
            className="flex-none p-1 rounded-sm text-label-tertiary hover:text-label-primary hover:bg-accent-subtle transition-colors"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Volumes — only on the personal root so it doesn't dominate deep
          folder views or the shared space. */}
      {space === "personal" && currentPath === "/" && <VolumesPanel />}

      {/* New folder dialog */}
      {showNewFolder && !isReaderSpace && (
        <div className="card flex items-center gap-2 mb-4" style={{ padding: 12 }}>
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateFolder();
              if (e.key === "Escape") setShowNewFolder(false);
            }}
            placeholder="Folder name..."
            className="flex-1 py-2 px-3 outline-none focus:border-[var(--brand)]"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--text)",
              fontSize: "13.5px",
            }}
          />
          <button onClick={handleCreateFolder} className="btn primary" type="button">
            Create
          </button>
          <button
            onClick={() => setShowNewFolder(false)}
            className="btn ghost"
            type="button"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Selection toolbar */}
      <SelectionToolbar
        count={fm.selectedCount}
        canRename={fm.selectedCount === 1}
        hasClipboard={!!fm.clipboard}
        onClear={fm.clearSelection}
        onRename={() => {
          const first = fm.selectedPaths[0];
          if (first) fm.beginRename(first);
        }}
        onCut={fm.cut}
        onCopy={fm.copy}
        onPaste={handlePasteClipboard}
        onMove={() => setMoveDialog({ mode: "move", paths: fm.selectedPaths })}
        onCopyTo={() => setMoveDialog({ mode: "copy", paths: fm.selectedPaths })}
        onDelete={handleBulkDelete}
        onDownload={handleBulkDownload}
        readOnly={isReaderSpace}
      />

      {/* Status messages */}
      {uploadProgress && (
        <div
          className="mb-4 p-3 rounded type-footnote"
          style={{
            background: "var(--brand-subtle)",
            border: "1px solid color-mix(in srgb, var(--brand) 20%, transparent)",
            color: "var(--brand)",
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div
              className="w-4 h-4 border-2 rounded-full animate-spin"
              style={{
                borderColor: "color-mix(in srgb, var(--brand) 30%, transparent)",
                borderTopColor: "var(--brand)",
              }}
            />
            {uploadProgress} {uploadPercent > 0 && `${uploadPercent}%`}
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
      {error && (
        <div
          className="mb-4 p-3 rounded type-footnote flex items-center justify-between"
          style={{
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.2)",
            color: "#ef4444",
          }}
        >
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 hover:opacity-70">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex gap-6">
        {/* File list */}
        <div className="flex-1 min-w-0">
          <UploadZone onUpload={handleUpload} disabled={isReaderSpace}>
            <div
              className="card overflow-hidden min-h-[300px]"
              style={{ padding: 0 }}
            >
              <div
                className="flex items-center gap-3 px-4 py-2 type-caption-1 uppercase tracking-wider"
                style={{ color: "var(--text-faint)", borderBottom: "1px solid var(--card-bd)" }}
              >
                <span className="flex-1">Name</span>
                <span className="w-20 text-right hidden sm:block">Size</span>
                <span className="w-32 text-right hidden md:block">Modified</span>
                <span className="w-16" />
              </div>

              {isLoading ? (
                <div
                  className="flex items-center justify-center h-48 type-subheadline"
                  style={{ color: "var(--text-muted)" }}
                >
                  Loading...
                </div>
              ) : listingError ? (
                /* WARP-1338 — failed listing ≠ empty folder. A deep-linked
                   drive path that 404s means the drive isn't registered in
                   the file browser (yet); everything else is a plain load
                   failure. Either way: honest copy + a retry, never the
                   false "This folder is empty". role="alert" because the
                   failure lands asynchronously after the page has rendered
                   (PoolAlarmBanner precedent). */
                <div
                  role="alert"
                  className="flex flex-col items-center justify-center h-48 px-6 text-center"
                  style={{ color: "var(--text-muted)" }}
                >
                  <p className="type-subheadline mb-1">
                    {driveNotConnected
                      ? "This drive isn't connected to the file browser yet"
                      : "We couldn't load your files"}
                  </p>
                  <p
                    className="type-caption-1 mb-3"
                    style={{ color: "var(--text-faint)" }}
                  >
                    {driveNotConnected
                      ? "Its files will show up here once it finishes connecting. Try again in a moment."
                      : "Something interrupted the connection. Try again in a moment."}
                  </p>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => refresh()}
                  >
                    Try again
                  </button>
                </div>
              ) : files.length === 0 ? (
                <div
                  className="flex flex-col items-center justify-center h-48"
                  style={{ color: "var(--text-muted)" }}
                >
                  <p className="type-subheadline mb-1">This folder is empty</p>
                  <p className="type-caption-1" style={{ color: "var(--text-faint)" }}>
                    Drag &amp; drop files here, or click <strong>Upload</strong> above
                  </p>
                </div>
              ) : (
                <div className="rows">
                  {files.map((file) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      isSelected={fm.isSelected(file.path)}
                      isRenaming={fm.renamingPath === file.path}
                      favoritedPaths={favoritedPaths}
                      onSelect={(e) => handleRowSelect(file, e)}
                      onToggleSelect={() => fm.toggleSelection(file.path, "toggle", files)}
                      onOpen={() => handleRowOpen(file)}
                      onDownload={() => handleDownload(file.path)}
                      onDelete={() => handleDelete(file.path)}
                      onRename={(name) => handleRenameCommit(file, name)}
                      onCancelRename={fm.endRename}
                      onContextMenu={(x, y) => handleRowContextMenu(file, x, y)}
                      onFavoriteChanged={refreshFavorites}
                      canWrite={!isReaderSpace}
                    />
                  ))}
                </div>
              )}
            </div>
          </UploadZone>
        </div>

        {/* Detail panel */}
        {selectedFile && !selectedFile.isDirectory && (
          <div className="hidden lg:block w-72 flex-shrink-0">
            <div className="card sticky top-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3
                  className="type-headline truncate flex-1"
                  style={{ color: "var(--text)" }}
                >
                  {selectedFile.name}
                </h3>
                <StarButton
                  path={selectedFile.path}
                  favorited={favoritedPaths.has(selectedFile.path)}
                  onToggle={() => {
                    void refreshFavorites();
                  }}
                  size={16}
                />
                <button
                  onClick={() => setSelectedFile(null)}
                  className="p-1 text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Thumbnail preview (if previewable) */}
              <div className="flex justify-center">
                <Thumbnail file={selectedFile} size={140} />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between type-footnote">
                  <span style={{ color: "var(--text-muted)" }}>Size</span>
                  <span style={{ color: "var(--text)" }}>{formatBytes(selectedFile.size)}</span>
                </div>
                <div className="flex justify-between type-footnote">
                  <span style={{ color: "var(--text-muted)" }}>Type</span>
                  <span style={{ color: "var(--text)" }}>{selectedFile.mimeType || "Unknown"}</span>
                </div>
                <div className="flex justify-between type-footnote">
                  <span style={{ color: "var(--text-muted)" }}>Modified</span>
                  <span style={{ color: "var(--text)" }}>
                    {new Date(selectedFile.modifiedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <button
                  onClick={() => handlePreview(selectedFile)}
                  className="btn ghost sm"
                  type="button"
                >
                  <Eye size={14} />
                  Preview
                </button>
                <button
                  onClick={() => handleShare(selectedFile)}
                  className="btn ghost sm"
                  type="button"
                >
                  <LinkIcon size={14} />
                  Share…
                </button>
              </div>

              {/* Tags (WARP-881 / WS-3) */}
              <TagChips filePath={selectedFile.path} />

              {/* Comments (WARP-881 / WS-3) */}
              <CommentsPanel filePath={selectedFile.path} />

              {/* Version history */}
              <VersionHistoryPanel
                filePath={selectedFile.path}
                onRestored={() => refresh()}
              />
            </div>
          </div>
        )}
      </div>

      {/* Rich preview modal */}
      {previewFile && (
        <PreviewPane
          file={previewFile}
          onClose={() => setPreviewFile(null)}
          onDownload={() => handleDownload(previewFile.path)}
          onEdit={() => {
            // WARP-882: hand off from preview to the in-browser editor.
            setEditorFile(previewFile);
            setPreviewFile(null);
          }}
        />
      )}

      {/* WARP-882: in-browser editor (OnlyOffice via the docserver engine) */}
      {editorFile && (
        <DocEditorPanel file={editorFile} onClose={() => setEditorFile(null)} />
      )}

      {/* Share dialog */}
      {shareFile && (
        <ShareDialog
          filePath={shareFile.path}
          fileName={shareFile.name}
          isDirectory={shareFile.isDirectory}
          existingShares={existingShares}
          onChange={() => loadExistingShares(shareFile.path)}
          onClose={() => {
            setShareFile(null);
            setExistingShares([]);
          }}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Move / Copy dialog */}
      {moveDialog && (
        <MoveCopyDialog
          mode={moveDialog.mode}
          selectionLabels={selectionLabels}
          // WARP-1247: this is the 4th write-destination path with the
          // WARP-1200 defect — `currentPath` is SPACE-relative, but the
          // dialog's tree + `handleMoveCopyConfirm` (bulkMoveFiles /
          // bulkCopyFiles) are already home-relative. Seeding from the raw
          // `currentPath` let the stale default (e.g. "/Trips" while the
          // Household tab is active) get confirmed without re-picking a
          // node, writing into the personal space instead of "/Household/Trips".
          currentDir={homeRelativeCurrentPath}
          forbiddenPrefixes={forbiddenPrefixes}
          onCancel={() => setMoveDialog(null)}
          onConfirm={handleMoveCopyConfirm}
        />
      )}

      <ConfirmDialog
        open={pendingDeletePath !== null}
        onConfirm={performDelete}
        onCancel={() => setPendingDeletePath(null)}
        title={
          pendingDeletePath
            ? `Delete "${pendingDeletePath.split("/").pop()}"?`
            : "Delete file?"
        }
        description="The file moves to Trash. You can restore it from there until Trash is emptied."
        confirmLabel="Delete"
        variant="destructive"
      />

      <ConfirmDialog
        open={pendingBulkDelete}
        onConfirm={performBulkDelete}
        onCancel={() => setPendingBulkDelete(false)}
        title={`Move ${fm.selectedCount} item${fm.selectedCount > 1 ? "s" : ""} to Trash?`}
        description="The items move to Trash. You can restore them from there until Trash is emptied."
        confirmLabel="Move to Trash"
        variant="destructive"
      />
    </ShellPage>
  );
}
