/**
 * WARP-1505 — what an uploaded attachment is allowed to be, and what the server
 * will say it is.
 *
 * Three questions, answered here and nowhere else (PURE: no I/O, so every rule
 * has a table-driven test):
 *
 *   1. What do we CALL the file? `sanitizeAttachmentFileName` — display metadata
 *      only. The bytes are stored under an opaque uuid (`pm-attachment-storage`),
 *      so a hostile name can never become a path; the cleaning exists so the name
 *      is safe to RENDER (no RTL-override spoofing like `invoice\u202Egnp.exe`)
 *      and safe to put in a `Content-Disposition` header.
 *   2. May we STORE it, and as what type? `evaluateAttachment`:
 *        * executables are refused — by magic bytes (PE / ELF / Mach-O / Java
 *          class), by extension, or by a claimed executable MIME type;
 *        * extension, the client's claimed MIME and the magic bytes must AGREE
 *          wherever the bytes can be checked at all (`evil.png` that is really a
 *          PDF is refused; a `.txt` that is really a PNG is refused);
 *        * the type we record is the one we VERIFIED, never the client's word.
 *   3. How may it be SERVED? `isPreviewableType`: only a raster image whose magic
 *      bytes were verified is ever served inline. HTML, SVG and every other type
 *      are recorded as `application/octet-stream` and served attachment-only —
 *      the route never trusts a stored label to be safe on its own.
 *
 * What this deliberately does NOT do: scan for malware, parse documents, or
 * judge text content. A `.txt`, `.csv` or `.js` has no magic bytes to check, so
 * it is accepted and served as a download like any other opaque file.
 */

/** How many leading bytes the upload keeps for sniffing. The longest check
 *  below is the tar magic at offset 257; 4 KiB covers every PE header too. */
export const SNIFF_BYTES = 4096;

/** Longest display name we keep, in code points. Real file systems stop at 255. */
const MAX_NAME_CODEPOINTS = 255;

/** Raster types the route may serve inline — and the ONLY ones. SVG is markup,
 *  not a raster image, and is never on this list. */
const PREVIEWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isPreviewableType(mimeType: string): boolean {
  return PREVIEWABLE.has(mimeType);
}

// ── 1. The display name ─────────────────────────────────────────────────────

// C0/C1 controls (NUL included), and the bidirectional controls that let a name
// render differently from what it is: LRM/RLM/ALM, the embeddings/overrides
// U+202A-202E and the isolates U+2066-2069.
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * The name to show and to offer on download. Never throws: a name that cleans
 * to nothing becomes `file`.
 *
 * Path parts are dropped (everything up to the last `/` or `\`), so
 * `../../etc/passwd` is `passwd`. That is a display decision, not the traversal
 * defence — the storage key is the defence, and no part of this string reaches
 * the file system.
 */
export function sanitizeAttachmentFileName(raw: string): string {
  const base = raw.normalize("NFC").split(/[\\/]/).pop() ?? "";
  const name = base.replace(CONTROL_OR_BIDI, "").trim();
  // Empty, or nothing but dots ("." / ".." / "..."): there is no name in it.
  if (name === "" || /^\.+$/.test(name)) return "file";
  const points = Array.from(name);
  if (points.length <= MAX_NAME_CODEPOINTS) return name;
  // Too long: keep the extension (it is what tells the user what the file is).
  const ext = extensionOf(name);
  const suffix = ext === "" ? "" : `.${ext}`;
  return points.slice(0, MAX_NAME_CODEPOINTS - Array.from(suffix).length).join("") + suffix;
}

// Everything below runs on the name as the client sent it, which busboy lets be
// ~16 KiB. It is therefore LINEAR by construction: scans from the end by index
// and the engine's own `lastIndexOf`/`indexOf`, never a regex that can restart
// at every position (an earlier version did, and cost 120 ms at 16 K characters)
// — and it is never clamped, because a clamped tail would let `run.exe` plus
// 5,000 dots past the blocked list.

/** Where the name ends once Windows has dropped a trailing run of dots and
 *  spaces: `run.bat.` and `run.bat ` are `run.bat` there. A scan from `end`. */
function keptEnd(s: string, end: number): number {
  let i = end;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    if (c !== 0x2e /* . */ && c !== 0x20 /* space */) break;
    i -= 1;
  }
  return i;
}

/** Extension of `s[0, end)`: lower-case, no dot, or "" when it has none that
 *  looks like one (letters/digits, at most 12). A name whose only dot is its
 *  first (`.bat`) HAS an extension: Windows runs it. */
function extensionBefore(s: string, end: number): string {
  const t = keptEnd(s, end);
  if (t === 0) return "";
  const dot = s.lastIndexOf(".", t - 1);
  const len = t - dot - 1;
  if (dot < 0 || len < 1 || len > 12) return "";
  const ext = s.slice(dot + 1, t).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : "";
}

function extensionOf(fileName: string): string {
  return extensionBefore(fileName, fileName.length);
}

/** Would Windows run this name as one of the blocked kinds? Its own extension
 *  (trailing dots and spaces dropped) — or, for an NTFS stream name, the file it
 *  is a stream of: `run.exe:Zone.Identifier` and `run.bat::$DATA` are `run.exe`
 *  and `run.bat`, so the part before the FIRST colon counts too. A colon later
 *  on, as in `Q3: final.pdf`, leaves the name's own extension alone. */
function hasBlockedExtension(fileName: string): boolean {
  if (BLOCKED_EXTENSIONS.has(extensionOf(fileName))) return true;
  const colon = fileName.indexOf(":");
  return colon > 0 && BLOCKED_EXTENSIONS.has(extensionBefore(fileName, colon));
}

/**
 * `Content-Disposition` that survives a hostile file name: an ASCII fallback
 * stripped to a conservative set, and the real name in RFC 5987 `filename*`
 * (which every current browser prefers). Mirrors routes/files.ts's
 * `contentDispositionAttachment`, plus the `'()*` the RFC says must be
 * percent-encoded in `filename*` and a `%` fallback strip (some browsers
 * percent-decode the plain `filename=`).
 */
export function contentDisposition(kind: "attachment" | "inline", fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ── 2. Sniffing ─────────────────────────────────────────────────────────────

/** A content family we can recognise from magic bytes. */
export type Family =
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "pdf"
  | "zip"
  | "gzip"
  | "bzip2"
  | "xz"
  | "7z"
  | "rar"
  | "tar"
  | "ole"
  | "executable";

export interface Sniffed {
  family: Family;
  /** The canonical MIME type of the family. */
  mime: string;
}

const FAMILY_MIME: Record<Family, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  gzip: "application/gzip",
  bzip2: "application/x-bzip2",
  xz: "application/x-xz",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  tar: "application/x-tar",
  ole: "application/x-ole-storage",
  executable: "application/octet-stream",
};

function at(head: Buffer, offset: number, bytes: readonly number[]): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((b, i) => head[offset + i] === b);
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** A Windows PE image: "MZ", then e_lfanew (u32 LE at 0x3C) pointing at "PE\0\0".
 *  Bare "MZ" is not enough — a text file may well start with those letters. */
function isPortableExecutable(head: Buffer): boolean {
  if (!at(head, 0, [0x4d, 0x5a]) || head.length < 0x40) return false;
  const peOffset = head.readUInt32LE(0x3c);
  return peOffset <= head.length - 4 && at(head, peOffset, [0x50, 0x45, 0x00, 0x00]);
}

/**
 * Recognise `head` (the first bytes of the file) by magic number. Null means "no
 * signature we know" — which is what every text file, and most media, looks like.
 */
export function sniffContent(head: Buffer): Sniffed | null {
  const hit = (family: Family): Sniffed => ({ family, mime: FAMILY_MIME[family] });

  // Executables first: they win over any extension or claim.
  if (isPortableExecutable(head)) return hit("executable");
  if (at(head, 0, [0x7f, 0x45, 0x4c, 0x46])) return hit("executable"); // ELF
  if (
    at(head, 0, [0xfe, 0xed, 0xfa, 0xce]) || // Mach-O 32
    at(head, 0, [0xfe, 0xed, 0xfa, 0xcf]) || // Mach-O 64
    at(head, 0, [0xce, 0xfa, 0xed, 0xfe]) || // Mach-O 32, little-endian
    at(head, 0, [0xcf, 0xfa, 0xed, 0xfe]) || // Mach-O 64, little-endian
    at(head, 0, [0xca, 0xfe, 0xba, 0xbe]) //   fat Mach-O — and a Java class file
  ) {
    return hit("executable");
  }

  if (at(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return hit("png");
  if (at(head, 0, [0xff, 0xd8, 0xff])) return hit("jpeg");
  if (at(head, 0, ascii("GIF87a")) || at(head, 0, ascii("GIF89a"))) return hit("gif");
  if (at(head, 0, ascii("RIFF")) && at(head, 8, ascii("WEBP"))) return hit("webp");
  // The PDF spec tolerates junk before the header, but a text file that merely
  // QUOTES "%PDF-" in its first kilobyte must not read as a PDF, so: offset 0.
  if (at(head, 0, ascii("%PDF-"))) return hit("pdf");
  if (
    at(head, 0, [0x50, 0x4b, 0x03, 0x04]) ||
    at(head, 0, [0x50, 0x4b, 0x05, 0x06]) ||
    at(head, 0, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return hit("zip");
  }
  if (at(head, 0, [0x1f, 0x8b, 0x08])) return hit("gzip");
  if (at(head, 0, ascii("BZh")) && head.length > 3 && head[3] >= 0x31 && head[3] <= 0x39) {
    return hit("bzip2");
  }
  if (at(head, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return hit("xz");
  if (at(head, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return hit("7z");
  if (at(head, 0, [...ascii("Rar!"), 0x1a, 0x07])) return hit("rar");
  if (at(head, 257, ascii("ustar"))) return hit("tar");
  if (at(head, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return hit("ole");
  return null;
}

// ── 3. The policy ───────────────────────────────────────────────────────────

/** What an extension says about the content. `binary` ones with a `family` can
 *  be checked against the magic bytes; `text` and `markup` have no signature but
 *  promise "not a binary format". */
interface ExtensionInfo {
  mime: string;
  kind: "binary" | "text" | "markup";
  family?: Family;
  /** The signature may be absent. Legacy Office names are routinely worn by
   *  RTF, HTML and XML ("Excel" exports that are really HTML tables), and
   *  refusing those would turn away real files; a signature that is PRESENT must
   *  still be the right one. */
  textOk?: true;
}

const OOXML = "application/vnd.openxmlformats-officedocument";
const ODF = "application/vnd.oasis.opendocument";

const EXTENSIONS: Record<string, ExtensionInfo> = {
  png: { mime: "image/png", kind: "binary", family: "png" },
  jpg: { mime: "image/jpeg", kind: "binary", family: "jpeg" },
  jpeg: { mime: "image/jpeg", kind: "binary", family: "jpeg" },
  gif: { mime: "image/gif", kind: "binary", family: "gif" },
  webp: { mime: "image/webp", kind: "binary", family: "webp" },
  pdf: { mime: "application/pdf", kind: "binary", family: "pdf" },
  zip: { mime: "application/zip", kind: "binary", family: "zip" },
  docx: { mime: `${OOXML}.wordprocessingml.document`, kind: "binary", family: "zip" },
  xlsx: { mime: `${OOXML}.spreadsheetml.sheet`, kind: "binary", family: "zip" },
  pptx: { mime: `${OOXML}.presentationml.presentation`, kind: "binary", family: "zip" },
  odt: { mime: `${ODF}.text`, kind: "binary", family: "zip" },
  ods: { mime: `${ODF}.spreadsheet`, kind: "binary", family: "zip" },
  odp: { mime: `${ODF}.presentation`, kind: "binary", family: "zip" },
  epub: { mime: "application/epub+zip", kind: "binary", family: "zip" },
  gz: { mime: "application/gzip", kind: "binary", family: "gzip" },
  tgz: { mime: "application/gzip", kind: "binary", family: "gzip" },
  bz2: { mime: "application/x-bzip2", kind: "binary", family: "bzip2" },
  xz: { mime: "application/x-xz", kind: "binary", family: "xz" },
  "7z": { mime: "application/x-7z-compressed", kind: "binary", family: "7z" },
  rar: { mime: "application/vnd.rar", kind: "binary", family: "rar" },
  // No `family`: a V7 tar predates the "ustar" magic, so absence proves nothing.
  tar: { mime: "application/x-tar", kind: "binary" },
  doc: { mime: "application/msword", kind: "binary", family: "ole", textOk: true },
  xls: { mime: "application/vnd.ms-excel", kind: "binary", family: "ole", textOk: true },
  ppt: { mime: "application/vnd.ms-powerpoint", kind: "binary", family: "ole", textOk: true },
  msg: { mime: "application/vnd.ms-outlook", kind: "binary", family: "ole" },
  txt: { mime: "text/plain", kind: "text" },
  log: { mime: "text/plain", kind: "text" },
  md: { mime: "text/markdown", kind: "text" },
  csv: { mime: "text/csv", kind: "text" },
  tsv: { mime: "text/tab-separated-values", kind: "text" },
  json: { mime: "application/json", kind: "text" },
  rtf: { mime: "application/rtf", kind: "text" },
  // Media we do not verify: stored under the honest type, never inline.
  mp3: { mime: "audio/mpeg", kind: "binary" },
  wav: { mime: "audio/wav", kind: "binary" },
  m4a: { mime: "audio/mp4", kind: "binary" },
  mp4: { mime: "video/mp4", kind: "binary" },
  mov: { mime: "video/quicktime", kind: "binary" },
  webm: { mime: "video/webm", kind: "binary" },
  // Active content. Accepted, but recorded as an opaque download so no label we
  // store can ever invite a browser to render it.
  html: { mime: "application/octet-stream", kind: "markup" },
  htm: { mime: "application/octet-stream", kind: "markup" },
  xhtml: { mime: "application/octet-stream", kind: "markup" },
  svg: { mime: "application/octet-stream", kind: "markup" },
  xml: { mime: "application/octet-stream", kind: "markup" },
};

/** Files that run when opened, or host a script that does. Scripts that are just
 *  text on every platform (`.sh`, `.ps1`, `.py`, `.js`) are NOT here: they cannot
 *  execute from a download and teams do attach them. */
const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "com", "scr", "pif", "bat", "cmd", "msi", "msp", "cpl", "lnk",
  "hta", "vbs", "vbe", "wsf", "wsh", "jar", "reg", "app",
]);

/** MIME types a client sends for the above, and for native binaries. */
const BLOCKED_MIMES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-dosexec",
  "application/x-executable",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-msi",
  "application/vnd.microsoft.portable-executable",
  "application/java-archive",
  "application/x-java-archive",
]);

/** What a claimed MIME type says about the content. */
function claimedKind(mime: string): Family | "text" | "markup" | null {
  if (mime === "") return null;
  if (mime === "image/pjpeg") return "jpeg";
  for (const family of ["png", "jpeg", "gif", "webp", "pdf", "gzip", "bzip2", "xz", "7z"] as const) {
    if (mime === FAMILY_MIME[family]) return family;
  }
  if (mime === "application/x-gzip") return "gzip";
  if (mime === "application/vnd.rar" || mime === "application/x-rar-compressed") return "rar";
  if (
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    mime === "application/epub+zip" ||
    mime.startsWith(`${OOXML}.`) ||
    mime.startsWith(`${ODF}.`)
  ) {
    return "zip";
  }
  if (mime === "application/msword" || mime === "application/vnd.ms-excel" || mime === "application/vnd.ms-powerpoint") {
    return "ole";
  }
  if (mime.includes("html") || mime.includes("xml") || mime.includes("svg")) return "markup";
  if (mime.startsWith("text/")) return "text";
  return null;
}

export type AttachmentVerdict =
  | { ok: true; mimeType: string; previewable: boolean }
  | { ok: false; reason: "blocked" | "mismatch" };

/**
 * Decide whether `fileName` / `claimedMime` / `head` describe a file we will
 * store, and as what.
 *
 * `claimedMime` is the multipart part's Content-Type — the CLIENT's word. It is
 * never the type we record.
 */
export function evaluateAttachment(input: {
  fileName: string;
  claimedMime: string | undefined;
  head: Buffer;
}): AttachmentVerdict {
  const ext = extensionOf(input.fileName);
  const claimed = (input.claimedMime ?? "").split(";")[0].trim().toLowerCase();
  let sniffed = sniffContent(input.head);
  // The PDF spec tolerates junk before the header (1024 bytes). That is honoured
  // only for a file that CLAIMS to be a PDF, so a text file that merely quotes
  // "%PDF-" is still not one.
  if (!sniffed && ext === "pdf" && input.head.subarray(0, 1024).includes("%PDF-")) {
    sniffed = { family: "pdf", mime: FAMILY_MIME.pdf };
  }
  const info = ext === "" ? undefined : EXTENSIONS[ext];

  // ── refuse ────────────────────────────────────────────────────────────────
  if (sniffed?.family === "executable") return { ok: false, reason: "blocked" };
  if (hasBlockedExtension(input.fileName)) return { ok: false, reason: "blocked" };
  if (BLOCKED_MIMES.has(claimed)) return { ok: false, reason: "blocked" };

  // ── the name, the claim and the bytes must agree wherever they can be compared ──
  const claim = claimedKind(claimed);
  if (sniffed) {
    // Bytes we recognise: a name or claim that promises something else is a lie.
    if (info?.family && info.family !== sniffed.family) return { ok: false, reason: "mismatch" };
    if (info && info.kind !== "binary") return { ok: false, reason: "mismatch" };
    if (claim && claim !== sniffed.family) return { ok: false, reason: "mismatch" };
  } else {
    // No signature: a name or claim that PROMISES one (png, pdf, zip, …) is a lie —
    // unless the name is one that legitimately travels without it (textOk).
    const textOk = info?.textOk === true;
    if (info?.family && !textOk) return { ok: false, reason: "mismatch" };
    if (claim && claim !== "text" && claim !== "markup" && !(textOk && claim === info?.family)) {
      return { ok: false, reason: "mismatch" };
    }
  }

  // ── what we record ────────────────────────────────────────────────────────
  let mimeType = "application/octet-stream";
  if (sniffed) {
    // The extension's own type is more specific than the family's (a `.docx` is
    // a zip family member) — but only once the bytes have agreed with it.
    mimeType = info?.family === sniffed.family ? info.mime : sniffed.mime;
  } else if (info) {
    mimeType = info.mime;
  }
  return {
    ok: true,
    mimeType,
    // Previewable ONLY on verified bytes: a `.png` name with no PNG signature
    // never reaches here (mismatch above), and an extension alone proves nothing.
    previewable: sniffed !== null && isPreviewableType(mimeType),
  };
}
