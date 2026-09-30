/**
 * WARP-3057 — the file name an upload is stored under.
 *
 * The multipart parser runs with `preservePath: true`, so the name arrives
 * exactly as the client sent it, and it is ours to check:
 *
 * - `/` anywhere, or a `..` segment (split on `/` or `\`), is a traversal
 *   attempt and the whole upload is refused; so is a C0/C1 control
 *   character (NUL included), which no real file name carries;
 * - `\` is kept as part of the name, never read as a path separator, but
 *   Nextcloud refuses it in every file name (`OCP\Constants::FILENAME_INVALID_CHARS`
 *   is `\\/`), so it is stored as `_` and the upload reports the rename;
 * - an empty name, or `.`, is refused. Segments are compared trimmed,
 *   because Nextcloud trims before its own `.`/`..` check: `" .."` would
 *   pass here, stage, and then fail the commit as a 500.
 *
 * Returns the name to store, or null to refuse the upload.
 */
export function storedUploadName(raw: string): string | null {
  if (raw.includes("/") || /[\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
  if (raw.split("\\").some((seg) => seg.trim() === "..")) return null;
  const name = raw.replaceAll("\\", "_");
  if (name.trim() === "" || name.trim() === ".") return null;
  return name;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * WARP-3057 — the name a pre-fix upload SHOULD have had, or null.
 *
 * Before the fix a plain `filename=` was decoded as latin1, so the UTF-8
 * bytes of `Café` were stored as `CafÃ©`. The repair re-reads the stored
 * name's code points as bytes and decodes them as UTF-8. It only answers
 * when that round trip is clean: every character is in U+0000–U+00FF, at
 * least one is above U+007F, the bytes are valid UTF-8, and the result
 * carries no separator or control character. A genuine latin1 name such as
 * `Café` (one byte 0xE9) is not valid UTF-8 and is left alone.
 */
export function repairLatin1Mojibake(name: string): string | null {
  if (!/[\u0080-ÿ]/.test(name) || /[^\u0000-ÿ]/.test(name)) return null;
  let fixed: string;
  try {
    fixed = UTF8.decode(Buffer.from(name, "latin1"));
  } catch {
    return null;
  }
  if (/[\\/\u0000-\u001f\u007f]/.test(fixed)) return null;
  return fixed;
}

/**
 * The rename plan for a list of stored file paths (`user/files/…/name`):
 * each path whose last segment repairs cleanly, unless the repaired path is
 * already taken by a file or a directory (`dirs`) — that one is skipped,
 * never overwritten and never moved INTO a directory of that name.
 */
export function planMojibakeRenames(
  paths: string[],
  dirs: string[] = [],
): {
  renames: { from: string; to: string }[];
  skipped: { from: string; to: string }[];
} {
  const taken = new Set([...paths, ...dirs]);
  const renames: { from: string; to: string }[] = [];
  const skipped: { from: string; to: string }[] = [];
  for (const from of paths) {
    const cut = from.lastIndexOf("/");
    const fixed = repairLatin1Mojibake(from.slice(cut + 1));
    if (fixed === null) continue;
    const to = from.slice(0, cut + 1) + fixed;
    if (taken.has(to)) {
      skipped.push({ from, to });
    } else {
      taken.add(to);
      renames.push({ from, to });
    }
  }
  return { renames, skipped };
}
