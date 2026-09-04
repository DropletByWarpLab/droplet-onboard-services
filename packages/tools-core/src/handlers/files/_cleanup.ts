/**
 * WARP-2664 — shared, PURE helpers for the file-cleanup tools
 * (`analyze_file_cleanup`, `organize_files`, `delete_files`).
 *
 * Nothing in here makes an HTTP call. `__tests__/tool-routes.test.ts`
 * parses each HANDLER's source for the `ctx.http.nextcloud.<method>(...)`
 * literal it dispatches through, so the listing / mkdir / move / delete
 * calls stay in the handlers; this module only classifies entries and
 * builds plans. `walkTree` takes the listing call as a callback for the
 * same reason.
 */
import path from "node:path";

/**
 * Surfaced verbatim to the chat model, which relays it to the user — so it
 * says how to RECOVER, not just that auth is missing. Same wording as the
 * WARP-1456 file tools (`restore-file-version.ts`, `share-file.ts`).
 */
export const FILE_AUTH_REQUIRED_MESSAGE =
  "File access isn't connected for this session. Ask the user to sign out of the Droplet dashboard and sign back in with their password — that reconnects file access and file tools will work again.";

/** Files one `organize_files` call moves; the rest are reported as remaining. */
export const ORGANIZE_MAX_MOVES = 500;

/**
 * WARP-2664 — the one thing these tools cannot determine, stated in the result
 * rather than papered over.
 *
 * `GET /api/files` does not surface an upstream failure to its caller: when
 * Nextcloud is unreachable or answers 5xx, `ncListFiles` throws and
 * `handleFileError(err, res, next, [])` turns it into **200 with `[]`**
 * (`isUpstreamUnavailable` matches any `: 5xx` message shape). A 404 is
 * unaffected — that branch runs first — so a genuinely missing folder still
 * surfaces properly.
 *
 * The consequence is that "this folder is empty" and "the file service is
 * having a moment" are the SAME answer at this layer. Reporting an empty scan
 * as a clean folder would have the assistant tell someone their drive is tidy
 * during an outage, so every result that could be explained by the degrade
 * carries this instead. `delete_files` refuses directories outright for the
 * same reason — see that handler's header.
 */
export const DEGRADED_LISTING_CAVEAT =
  "An empty folder listing and an unreachable file service look identical here, so this result may reflect a temporary outage rather than what is really stored. Say so rather than reporting the folder as clean, and offer to re-run it.";

/** One row of a `GET /api/files?path=` listing, as the tools read it. */
export interface CleanupEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mimeType: string | null;
  /**
   * ISO-8601. `""` only when the row carried no string `modifiedAt` at all
   * (`parseEntries`' fallback), which the shipping producer never sends:
   * the orchestrator's listing parser (`parseMultiStatus`,
   * nextcloud.client.ts) stamps a PROPFIND block that lacks
   * `<d:getlastmodified>` with the CURRENT time. A file Nextcloud cannot
   * date therefore arrives here looking freshly modified — never stale,
   * filed under today's month or year — rather than as "Undated". The
   * "Undated" branch below is defensive, for a producer that omits the
   * field, not a state this listing produces.
   */
  modifiedAt: string;
}

/**
 * Parse a listing body into entries, dropping malformed rows rather than
 * throwing. The orchestrator returns a bare array (`res.json(entries)`);
 * an `{ entries: [...] }` wrapper is tolerated because older fixtures use it.
 */
export function parseEntries(raw: unknown): CleanupEntry[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries)
      ? ((raw as { entries: unknown[] }).entries)
      : [];
  const out: CleanupEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.path !== "string" || r.path.length === 0) continue;
    const fromPath = r.path.split("/").pop() ?? "";
    const name = typeof r.name === "string" && r.name.length > 0 ? r.name : fromPath;
    if (!name) continue;
    out.push({
      name,
      path: r.path,
      isDirectory: r.isDirectory === true,
      size:
        typeof r.size === "number" && Number.isFinite(r.size) && r.size >= 0 ? r.size : 0,
      mimeType: typeof r.mimeType === "string" ? r.mimeType : null,
      modifiedAt: typeof r.modifiedAt === "string" ? r.modifiedAt : "",
    });
  }
  return out;
}

/** One `GET /api/files?path=` answer, read the same way by every cleanup tool. */
export interface Listing {
  ok: boolean;
  status: number;
  /** Empty when `ok` is false. */
  entries: CleanupEntry[];
  /**
   * An OK answer with no entries — which is also exactly what the route
   * returns during an outage (see {@link DEGRADED_LISTING_CAVEAT}). Decided
   * HERE, once, so the three tools caveat on the same signal; before PR
   * #1985 each re-derived it its own way, with nothing holding them equal.
   */
  possiblyDegraded: boolean;
}

export async function readListing(res: Response): Promise<Listing> {
  const entries = res.ok ? parseEntries(await res.json().catch(() => null)) : [];
  return { ok: res.ok, status: res.status, entries, possiblyDegraded: res.ok && entries.length === 0 };
}

/** Clamp an LLM-supplied number to an integer in [min, max], or a default. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`;
}

// ── Categories ───────────────────────────────────────────────────────

export type FileCategory =
  | "Documents"
  | "Images"
  | "Videos"
  | "Audio"
  | "Archives"
  | "Installers"
  | "Other";

export const FILE_CATEGORIES: readonly FileCategory[] = [
  "Documents",
  "Images",
  "Videos",
  "Audio",
  "Archives",
  "Installers",
  "Other",
];

const EXTENSIONS_BY_CATEGORY: Record<Exclude<FileCategory, "Other">, readonly string[]> = {
  Documents: [
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
    "txt", "md", "csv", "tsv", "epub", "pages", "numbers", "key",
  ],
  Images: [
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "svg",
    "raw", "cr2", "nef", "arw", "dng", "psd",
  ],
  Videos: ["mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "mts", "m2ts", "3gp", "mpg", "mpeg"],
  Audio: ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma", "aiff"],
  Archives: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso", "dmg"],
  Installers: ["exe", "msi", "pkg", "deb", "rpm", "apk", "appimage"],
};

const CATEGORY_BY_EXTENSION: ReadonlyMap<string, FileCategory> = new Map(
  (Object.entries(EXTENSIONS_BY_CATEGORY) as Array<[FileCategory, readonly string[]]>).flatMap(
    ([category, exts]) => exts.map((ext): [string, FileCategory] => [ext, category]),
  ),
);

/** Lower-cased extension without the dot; "" for none (dotfiles have none). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Extension first (what a person sees), MIME type as the fallback. */
export function categoryOf(name: string, mimeType: string | null): FileCategory {
  const byExt = CATEGORY_BY_EXTENSION.get(extensionOf(name));
  if (byExt) return byExt;
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "Images";
  if (mime.startsWith("video/")) return "Videos";
  if (mime.startsWith("audio/")) return "Audio";
  if (mime.startsWith("text/") || mime === "application/pdf") return "Documents";
  if (
    /^application\/(zip|x-tar|gzip|x-gzip|x-7z-compressed|x-rar-compressed|vnd\.rar|x-bzip2|x-xz)$/.test(
      mime,
    )
  ) {
    return "Archives";
  }
  return "Other";
}

// ── Junk ─────────────────────────────────────────────────────────────

const JUNK_EXACT_NAMES: ReadonlyMap<string, string> = new Map([
  [".ds_store", "macOS folder metadata"],
  [".localized", "macOS folder metadata"],
  ["thumbs.db", "Windows thumbnail cache"],
  ["ehthumbs.db", "Windows thumbnail cache"],
  ["desktop.ini", "Windows folder settings"],
]);

const JUNK_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["tmp", "temporary file"],
  ["temp", "temporary file"],
  ["part", "unfinished download"],
  ["crdownload", "unfinished download"],
  ["download", "unfinished download"],
  ["bak", "backup copy"],
  ["old", "backup copy"],
  ["orig", "backup copy"],
  ["swp", "editor swap file"],
  ["swo", "editor swap file"],
]);

/**
 * Why a file counts as junk, or null. Deliberately conservative: only
 * files an OS or an editor left behind, never anything a person named.
 */
export function junkReason(name: string): string | null {
  const lower = name.toLowerCase();
  const exact = JUNK_EXACT_NAMES.get(lower);
  if (exact) return exact;
  if (lower.startsWith("._")) return "macOS resource fork";
  if (lower.startsWith("~$")) return "Office lock file";
  if (lower.startsWith(".~lock.") && lower.endsWith("#")) return "LibreOffice lock file";
  if (lower.endsWith("~")) return "editor backup";
  return JUNK_EXTENSIONS.get(extensionOf(lower)) ?? null;
}

export function isDotfile(name: string): boolean {
  return name.startsWith(".");
}

// ── Duplicates ───────────────────────────────────────────────────────

/**
 * Strip the suffixes copy operations add — "report (1).pdf",
 * "report - Copy.pdf", "report copy 2.pdf", "Copy of report.pdf" — so the
 * copies group with their original. Lower-cased; the extension is kept.
 */
export function normalizeCopyName(name: string): string {
  const ext = extensionOf(name);
  let stem = ext ? name.slice(0, name.length - ext.length - 1) : name;
  for (let i = 0; i < 3; i++) {
    const next = stem
      .replace(/\s*\(\d+\)$/, "")
      .replace(/\s*-\s*copy(\s*\(\d+\)|\s*\d+)?$/i, "")
      .replace(/\s+copy(\s+\d+)?$/i, "")
      .replace(/^copy\s+of\s+/i, "");
    if (next === stem) break;
    stem = next;
  }
  return (ext ? `${stem}.${ext}` : stem).toLowerCase();
}

export interface DuplicateGroup {
  /** The normalized name the copies share. */
  name: string;
  size: number;
  /**
   * The copy to KEEP. Chosen, not incidental: reclaimable bytes are computed
   * as `size × (copies - 1)`, i.e. on the assumption that exactly one copy
   * survives, so the group has to say WHICH one. Without that the model can
   * hand every path in the group to `delete_files` and the user loses the
   * file outright, while the report claims the space was merely reclaimed.
   */
  keep: string;
  /** The other copies, best-original first. Never includes `keep`. */
  duplicates: string[];
}

/**
 * Files that share a normalized name AND a byte size. Name + size is a
 * CANDIDATE signal, not proof — content hashing is WARP-2096's job — so
 * the tools label these "candidates" and never delete one unasked.
 * Empty files are excluded: every empty file matches every other.
 * Sorted by reclaimable bytes (size × extra copies), largest first.
 */
export function duplicateGroups(files: readonly CleanupEntry[]): DuplicateGroup[] {
  const byKey = new Map<string, { name: string; size: number; entries: CleanupEntry[] }>();
  for (const f of files) {
    if (f.isDirectory || f.size <= 0) continue;
    const name = normalizeCopyName(f.name);
    // NUL separates the two key parts because a filename cannot contain
    // one, so no name can forge a boundary. Written as an ESCAPE, never as
    // a raw control byte: a literal 0x00 in tracked source makes
    // grep/ripgrep treat the whole file as binary and skip it silently.
    const key = `${name}\u0000${f.size}`;
    const group = byKey.get(key);
    if (group) group.entries.push(f);
    else byKey.set(key, { name, size: f.size, entries: [f] });
  }
  return [...byKey.values()]
    .filter((g) => g.entries.length > 1)
    .map((g) => {
      // Keep the likeliest ORIGINAL: the copy whose own name survived
      // normalization untouched ("report.pdf" beats "report (1).pdf"),
      // then the shallowest path, then lexicographic, so the choice is
      // deterministic rather than dependent on the order the walk
      // happened to reach them in.
      const ranked = [...g.entries].sort((a, b) => {
        const aOriginal = a.name.toLowerCase() === g.name ? 0 : 1;
        const bOriginal = b.name.toLowerCase() === g.name ? 0 : 1;
        if (aOriginal !== bOriginal) return aOriginal - bOriginal;
        const aDepth = a.path.split("/").length;
        const bDepth = b.path.split("/").length;
        if (aDepth !== bDepth) return aDepth - bDepth;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });
      return {
        name: g.name,
        size: g.size,
        keep: ranked[0].path,
        duplicates: ranked.slice(1).map((e) => e.path),
      };
    })
    .sort((a, b) => b.size * b.duplicates.length - a.size * a.duplicates.length);
}

// ── Organize plans ───────────────────────────────────────────────────

export const ORGANIZE_RULES = ["by_type", "by_extension", "by_month", "by_year"] as const;
export type OrganizeRule = (typeof ORGANIZE_RULES)[number];

export function isOrganizeRule(value: unknown): value is OrganizeRule {
  return typeof value === "string" && (ORGANIZE_RULES as readonly string[]).includes(value);
}

/** The subfolder NAME (not path) a file lands in under a rule. */
export function destinationFolderFor(entry: CleanupEntry, rule: OrganizeRule): string {
  switch (rule) {
    case "by_type":
      return categoryOf(entry.name, entry.mimeType);
    case "by_extension": {
      const ext = extensionOf(entry.name);
      return ext ? ext.toUpperCase() : "No extension";
    }
    case "by_month":
    case "by_year": {
      const d = new Date(entry.modifiedAt);
      if (entry.modifiedAt === "" || Number.isNaN(d.getTime())) return "Undated";
      const year = String(d.getUTCFullYear());
      if (rule === "by_year") return year;
      return `${year}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    }
  }
}

export interface OrganizeMove {
  from: string;
  to: string;
  folder: string;
}

export interface OrganizePlan {
  moves: OrganizeMove[];
  /** Destination folders, in first-use order — created before any move. */
  folders: string[];
  skipped: Array<{ path: string; reason: string }>;
  /** Files past `maxMoves` that a later call would pick up. */
  remaining: number;
}

/**
 * Build the move list for one folder. Only files DIRECTLY inside `root`
 * move; subfolders (and everything in them) are left alone, which is
 * what makes a second run a no-op. Hidden files are skipped: they are
 * app state, not something a person filed.
 */
export function planOrganize(
  root: string,
  entries: readonly CleanupEntry[],
  rule: OrganizeRule,
  maxMoves: number,
): OrganizePlan {
  const prefix = root === "/" ? "" : root;
  const moves: OrganizeMove[] = [];
  const folders: string[] = [];
  const seenFolders = new Set<string>();
  const skipped: OrganizePlan["skipped"] = [];
  let remaining = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (path.posix.dirname(entry.path) !== root) continue;
    if (isDotfile(entry.name)) {
      skipped.push({ path: entry.path, reason: "hidden file" });
      continue;
    }
    const folder = `${prefix}/${destinationFolderFor(entry, rule)}`;
    const to = `${folder}/${entry.name}`;
    if (to === entry.path) continue;
    if (moves.length >= maxMoves) {
      remaining++;
      continue;
    }
    if (!seenFolders.has(folder)) {
      seenFolders.add(folder);
      folders.push(folder);
    }
    moves.push({ from: entry.path, to, folder });
  }
  return { moves, folders, skipped, remaining };
}

// ── Bounded tree walk ────────────────────────────────────────────────

export interface WalkOptions {
  /** 0 lists only `root`; N lists folders up to N levels below it. */
  maxDepth: number;
  maxEntries: number;
  maxListings: number;
  /** Checked before every listing, as the write handlers check it before every write. */
  signal: AbortSignal;
}

export interface WalkResult {
  entries: CleanupEntry[];
  /**
   * Folders below root whose listing came back with no entries.
   *
   * NOT proof they are empty: the listing route answers 200 `[]` for an
   * unreachable Nextcloud too, so a folder that merely failed to read lands
   * here rather than in `errors` — see {@link DEGRADED_LISTING_CAVEAT}. The
   * report labels these accordingly, and nothing acts on them destructively.
   */
  emptyDirectories: string[];
  /** Some listing (the root's included) was {@link Listing.possiblyDegraded}. */
  possiblyDegraded: boolean;
  /** Listing calls made, root included. */
  listed: number;
  /** A bound stopped the walk with folders still unread; the report covers what was reached, not the tree. */
  truncated: boolean;
  /** The signal aborted with folders still unread. Implies `truncated`. */
  cancelled: boolean;
  /** Folders below root whose listing failed (status), skipped and noted. */
  errors: Array<{ path: string; status: number }>;
  /** HTTP status of the root listing. Non-2xx ⇒ nothing else was read. */
  rootStatus: number;
}

/**
 * Breadth-first, bounded walk. `list` is the handler's own
 * `ctx.http.nextcloud.get(...)` so the route manifest sees the hop.
 * Bounds are checked before each listing, so `entries` can overrun
 * `maxEntries` by at most one folder's worth.
 */
export async function walkTree(
  root: string,
  list: (dir: string) => Promise<Response>,
  opts: WalkOptions,
): Promise<WalkResult> {
  const result: WalkResult = {
    entries: [],
    emptyDirectories: [],
    possiblyDegraded: false,
    listed: 0,
    truncated: false,
    cancelled: false,
    errors: [],
    rootStatus: 0,
  };
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    // PR #1985 review: the write handlers stop before every iteration once
    // cancelled; without this the walk kept issuing up to `maxListings`
    // listings after the caller had given up.
    if (opts.signal.aborted) {
      result.cancelled = true;
      result.truncated = true;
      break;
    }
    // Only ever declared with a folder still queued (the loop condition), so
    // a scan that read everything — including one folder holding more than
    // `maxEntries` files, all of which land in `entries` — reports complete,
    // because it is. An earlier cut re-checked the cap after each listing and
    // flagged exactly that scan as truncated (PR #1985 review).
    if (result.listed >= opts.maxListings || result.entries.length >= opts.maxEntries) {
      result.truncated = true;
      break;
    }
    const next = queue.shift();
    if (!next) break;
    const listing = await readListing(await list(next.dir));
    result.listed++;
    if (next.dir === root) result.rootStatus = listing.status;
    if (!listing.ok) {
      if (next.dir === root) return result;
      result.errors.push({ path: next.dir, status: listing.status });
      continue;
    }
    if (listing.possiblyDegraded) {
      result.possiblyDegraded = true;
      if (next.dir !== root) result.emptyDirectories.push(next.dir);
    }
    for (const entry of listing.entries) {
      result.entries.push(entry);
      if (entry.isDirectory && next.depth < opts.maxDepth) {
        queue.push({ dir: entry.path, depth: next.depth + 1 });
      }
    }
  }
  return result;
}
