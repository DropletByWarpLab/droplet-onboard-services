/**
 * WARP-1876 — turning a drop (or a directory picker selection) into the
 * calls the shipped API actually accepts.
 *
 * `POST /api/files/upload` writes FLAT: the target directory comes from
 * `?path=` and each part's name is a BASENAME (`file.originalname`, see
 * apps/orchestrator/src/routes/files.ts). There is no nested-path field on
 * the wire, and this ticket does not invent one. So a folder tree is
 * decomposed here into the two calls that already exist:
 *
 *   1. `POST /api/files/mkdir` per directory, shallow → deep
 *      (`ncCreateDirectory` tolerates 405 "already exists", so re-dropping
 *       the same folder is idempotent);
 *   2. `POST /api/files/upload` once per directory, with that directory's
 *      files — which keeps the existing batching, progress and
 *      partial-failure contract (WARP-1666 / WARP-1843) intact per group.
 *
 * Everything here is pure except `readDroppedUploads`, which walks the
 * browser's FileSystemEntry tree.
 */

export interface DroppedUpload {
  file: File;
  /**
   * POSIX path relative to the drop target directory, INCLUDING the file
   * name. `"a.txt"` for a root-level file, `"Reports/Q1/a.txt"` for a
   * file inside a dropped folder.
   */
  relativePath: string;
}

/** A directory's worth of files — one `uploadFiles` call. */
export interface UploadGroup {
  /** Relative directory ("" = the drop target itself). */
  dir: string;
  files: File[];
}

/**
 * Everything one drop (or one picker selection) yielded.
 *
 * The counts matter as much as the files: a walk that quietly discards what
 * it cannot read reports a partial migration as a complete one — 188 of 200
 * documents land and the user is told the move succeeded (WARP-1876 review).
 */
export interface DroppedSelection {
  uploads: DroppedUpload[];
  /**
   * Every directory the drop contained, INCLUDING the ones with no files in
   * them. File paths alone can't express an empty folder, and an office
   * dragging a `Clients/` tree expects its empty folders to arrive too.
   */
  directories: string[];
  /**
   * Entries the walk could not turn into an upload: a file the browser
   * refused to materialize (an online-only OneDrive/iCloud placeholder is
   * the common one), a directory whose reader died, a name that is not a
   * usable path segment, or a subtree past `MAX_DEPTH`. Counted so the
   * caller can say so — never silently dropped.
   */
  skipped: number;
}

/** The directory part of a relative path; "" for a root-level file. */
export function parentDir(relativePath: string): string {
  const idx = relativePath.lastIndexOf("/");
  return idx === -1 ? "" : relativePath.slice(0, idx);
}

/**
 * Every directory that must exist before the uploads run, shallow first
 * and de-duplicated. Shallow-first is not cosmetic: WebDAV MKCOL fails
 * with 409 when an intermediate collection is missing, so "Reports" has
 * to be created before "Reports/2026".
 *
 * `directories` is the walk's own record of the folders it visited. File
 * parents alone lose every EMPTY folder in the dropped tree, which is how a
 * `Clients/` drop arrives thirteen folders short (WARP-1876 review).
 */
export function requiredDirectories(
  uploads: DroppedUpload[],
  directories: string[] = [],
): string[] {
  const seen = new Set<string>();
  const addChain = (dir: string) => {
    if (!dir) return;
    const segments = dir.split("/");
    for (let i = 1; i <= segments.length; i++) {
      seen.add(segments.slice(0, i).join("/"));
    }
  };
  for (const u of uploads) addChain(parentDir(u.relativePath));
  for (const dir of directories) addChain(dir);
  // Depth, then name — a stable order that is always shallow-first.
  return [...seen].sort((a, b) => {
    const d = a.split("/").length - b.split("/").length;
    return d !== 0 ? d : a.localeCompare(b);
  });
}

/** Group uploads by their parent directory, first-seen order preserved. */
export function groupByDirectory(uploads: DroppedUpload[]): UploadGroup[] {
  const groups = new Map<string, File[]>();
  for (const u of uploads) {
    const dir = parentDir(u.relativePath);
    const bucket = groups.get(dir);
    if (bucket) bucket.push(u.file);
    else groups.set(dir, [u.file]);
  }
  return [...groups].map(([dir, files]) => ({ dir, files }));
}

/**
 * A path segment we are willing to send to the server. The mkdir route
 * rejects `..` itself (`isSafeUserPath`, WARP-938) — this is the matching
 * client-side guard so a hostile or merely odd directory name is dropped
 * at the boundary rather than bounced back as a 400 mid-batch.
 *
 * A BACKSLASH is not unsafe and never was: it is an ordinary character in a
 * macOS/Linux file name, and the server's guard only looks for `..` segments
 * (routes/files.ts `isSafeUserPath`). Rejecting it here discarded real
 * documents — and did it inconsistently, since `uploadsFromFileList` uploads
 * the very same file by falling back to its bare name (WARP-1876 review).
 */
function isSafeSegment(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/");
}

/** Normalize a picker selection. `webkitRelativePath` is set by a
 *  `webkitdirectory` input and empty for a plain multi-select. */
export function uploadsFromFileList(files: FileList | File[]): DroppedUpload[] {
  return Array.from(files).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const relativePath =
      rel && rel.split("/").every(isSafeSegment) ? rel : file.name;
    return { file, relativePath };
  });
}

/**
 * A picker selection as a selection. A `<input type="file">` hands over
 * files it has already opened, so nothing is unreadable and empty folders
 * never reach us — the two counts are structurally zero here, unlike a drop.
 */
export function selectionFromFileList(files: FileList | File[]): DroppedSelection {
  return { uploads: uploadsFromFileList(files), directories: [], skipped: 0 };
}

// ── FileSystemEntry traversal ────────────────────────────────────────────
//
// Structurally typed rather than leaning on lib.dom's FileSystemEntry: the
// API is a non-standard WebKit legacy interface, and typing it structurally
// keeps the traversal testable without a browser.

interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (onSuccess: (f: File) => void, onError?: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      onSuccess: (entries: EntryLike[]) => void,
      onError?: (e: unknown) => void,
    ) => void;
  };
}

function entryFile(entry: EntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.file) return resolve(null);
    entry.file(
      (f) => resolve(f),
      () => resolve(null),
    );
  });
}

/**
 * Drain a directory reader. `readEntries` returns AT MOST 100 entries per
 * call and signals completion with an empty array — calling it once is the
 * classic way to silently lose every file past the first page.
 *
 * `complete` separates "that was the last page" from "the reader failed":
 * an error mid-drain loses the REST OF THE SUBTREE, and the caller has to
 * be able to say so.
 */
async function readAllEntries(
  entry: EntryLike,
): Promise<{ entries: EntryLike[]; complete: boolean }> {
  const reader = entry.createReader?.();
  if (!reader) return { entries: [], complete: false };
  const all: EntryLike[] = [];
  for (;;) {
    const page = await new Promise<EntryLike[] | null>((resolve) => {
      reader.readEntries(
        (entries) => resolve(entries),
        () => resolve(null),
      );
    });
    if (page === null) return { entries: all, complete: false };
    if (page.length === 0) return { entries: all, complete: true };
    all.push(...page);
  }
}

/** Guards against a pathological tree; deeper than this is not a real
 *  document folder and the paths stop being usable anyway. */
const MAX_DEPTH = 32;

/** The walk's running result — `skipped` is a counter, so it is carried on
 *  a mutable accumulator rather than returned up the recursion. */
type WalkAccumulator = DroppedSelection;

async function walk(
  entry: EntryLike,
  prefix: string,
  depth: number,
  acc: WalkAccumulator,
): Promise<void> {
  // A name we cannot express as a path segment can't be created or uploaded
  // — but it is still something the user dropped, so it is counted.
  if (!isSafeSegment(entry.name)) {
    acc.skipped++;
    return;
  }
  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await entryFile(entry);
    // No file means the browser refused to hand it over — an online-only
    // OneDrive/iCloud placeholder, a permissions error, a file that moved
    // mid-drop. It is missing from the box exactly like a failed upload is.
    if (file) acc.uploads.push({ file, relativePath });
    else acc.skipped++;
    return;
  }

  if (!entry.isDirectory) return;

  if (depth >= MAX_DEPTH) {
    acc.skipped++;
    return;
  }

  // Recorded BEFORE the children so a folder with nothing in it still gets
  // created — file parents alone can't express an empty folder.
  acc.directories.push(relativePath);
  const { entries, complete } = await readAllEntries(entry);
  if (!complete) acc.skipped++;
  for (const child of entries) {
    await walk(child, relativePath, depth + 1, acc);
  }
}

/**
 * Read a drop into a flat upload list, expanding any dropped directories.
 *
 * `webkitGetAsEntry()` is what makes a folder drop distinguishable from a
 * file drop at all — in `dataTransfer.files` a directory appears as a
 * zero-byte File named after the folder, which is exactly the junk upload
 * this ticket removes. Falls back to `dataTransfer.files` (flat) only when
 * the entries API is unavailable.
 */
export async function readDroppedUploads(dt: DataTransfer): Promise<DroppedSelection> {
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items
    .map((item) =>
      typeof (item as DataTransferItem).webkitGetAsEntry === "function"
        ? ((item as DataTransferItem).webkitGetAsEntry() as EntryLike | null)
        : null,
    )
    .filter((e): e is EntryLike => e !== null);

  if (entries.length === 0) {
    return selectionFromFileList(dt.files ?? []);
  }

  const acc: WalkAccumulator = { uploads: [], directories: [], skipped: 0 };
  for (const entry of entries) {
    await walk(entry, "", 0, acc);
  }
  return acc;
}
