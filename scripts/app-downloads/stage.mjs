#!/usr/bin/env node
/**
 * Stage a built client installer where the box can serve it.
 *
 * The other half of `gen-catalog.mjs`. That script pins digests for
 * whatever is already sitting in the staging root; this one is what puts
 * something there in the first place, and it exists because the manual
 * procedure in `data/app-downloads/README.md` has never been run by
 * anything automated — so every box ships with an empty staging root and
 * `/downloads` honestly reports that no apps are staged.
 *
 * USAGE
 *   node scripts/app-downloads/stage.mjs [options] <installer> [<file>...]
 *
 *   --dir <path>        staging root (default: data/app-downloads)
 *   --platform <name>   windows|macos|linux|android|ios (default: inferred
 *                       from the file extension)
 *   --version <x.y.z>   (default: inferred from the filename)
 *   --min-os <text>     e.g. "Windows 10 (1809) or newer"
 *   --store-url <url>   for store-distributed platforms (android/ios)
 *   --note <text>       one human sentence shown on the page
 *   --keep-existing     do NOT clear the platform directory first
 *   --dry-run           print what would happen, touch nothing
 *
 * WHY IT CLEARS THE PLATFORM DIRECTORY BY DEFAULT
 * `pickPrimary()` in gen-catalog.mjs takes the first `-setup.exe` in
 * sorted order. Stage 0.2.0 next to a leftover 0.1.2 and the catalog's
 * `primary` becomes the OLDER installer — the download button then hands
 * out the stale build, silently and with a passing digest check.
 * Replacing the directory is therefore the safe default, and keeping the
 * old build is the flag you have to ask for.
 */
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PLATFORMS = ["windows", "macos", "linux", "android", "ios"];

/** Extension -> platform. Only unambiguous mappings live here; anything
 *  that could belong to two platforms has to be named with --platform. */
const PLATFORM_BY_EXT = {
  ".exe": "windows",
  ".msi": "windows",
  ".apk": "android",
  ".dmg": "macos",
  ".pkg": "macos",
  ".appimage": "linux",
  ".deb": "linux",
  ".rpm": "linux",
  ".ipa": "ios",
};

/** The names the catalog parser accepts (its own ASSET_NAME_RE).
 *  Rejecting here means a bad filename fails at staging time with a clear
 *  message rather than at parse time on a customer's box. */
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** "Droplet_0.2.0_x64-setup.exe" -> "0.2.0". */
const VERSION_IN_NAME_RE = /(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?)/;

function fail(message) {
  process.stderr.write(`stage: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    dir: "data/app-downloads",
    platform: null,
    version: null,
    minOsVersion: null,
    storeUrl: null,
    note: null,
    keepExisting: false,
    dryRun: false,
    files: [],
  };
  const takesValue = {
    "--dir": "dir",
    "--platform": "platform",
    "--version": "version",
    "--min-os": "minOsVersion",
    "--store-url": "storeUrl",
    "--note": "note",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep-existing") args.keepExisting = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (takesValue[arg]) {
      i += 1;
      if (argv[i] === undefined) fail(`${arg} needs a value`);
      args[takesValue[arg]] = argv[i];
    } else if (arg.startsWith("--")) fail(`unknown argument: ${arg}`);
    else args.files.push(arg);
  }
  if (args.files.length === 0) fail("no files given — pass at least one installer");
  if (args.platform && !PLATFORMS.includes(args.platform)) {
    fail(`unknown platform "${args.platform}" (expected one of ${PLATFORMS.join(", ")})`);
  }
  return args;
}

/**
 * Which platform these files belong to. Every file has to agree: staging
 * a .exe and an .apk in one call is a mistake rather than a
 * multi-platform stage, because they carry different versions.
 */
function resolvePlatform(files, explicit) {
  const guesses = new Set();
  for (const file of files) {
    const guess = PLATFORM_BY_EXT[path.extname(file).toLowerCase()];
    if (guess) guesses.add(guess);
  }

  // An explicit --platform used to return before the files were looked at, so
  // `--platform windows droplet.apk` staged an APK into windows/ where
  // gen-catalog happily made it `primary` — the Windows download button then
  // handed a customer an Android package, with a catalog that parses and a
  // digest that verifies. --platform is for files whose extension says
  // nothing, not an override for files that contradict it.
  if (explicit) {
    const contradicting = [...guesses].filter((g) => g !== explicit);
    if (contradicting.length > 0) {
      fail(
        `--platform ${explicit} contradicts these files, which look like ` +
          `${contradicting.join(" + ")}. Drop --platform, or stage the right files.`,
      );
    }
    return explicit;
  }

  if (guesses.size === 1) return [...guesses][0];
  if (guesses.size === 0) {
    fail("cannot infer the platform from these files — pass --platform");
  }
  return fail(
    `these files span ${[...guesses].join(" + ")} — stage one platform at a time, or pass --platform`,
  );
}

/** Version from the installer's own filename, so the page cannot claim a
 *  version the bytes are not. --version overrides. */
function resolveVersion(files, explicit) {
  if (explicit) return explicit;
  for (const file of files) {
    const match = VERSION_IN_NAME_RE.exec(path.basename(file));
    if (match) return match[1];
  }
  return fail("cannot infer a version from these filenames — pass --version");
}

async function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(process.cwd(), args.dir);
  const platform = resolvePlatform(args.files, args.platform);
  const version = resolveVersion(args.files, args.version);

  for (const file of args.files) {
    const name = path.basename(file);
    if (!ASSET_NAME_RE.test(name)) {
      fail(`"${name}" is not a name the catalog parser accepts (letters, digits, . _ + -)`);
    }
    try {
      await access(file, constants.R_OK);
    } catch {
      fail(`cannot read ${file}`);
    }
    if (!(await stat(file)).isFile()) fail(`${file} is not a regular file`);
  }

  const platformDir = path.join(root, platform);
  const staged = args.files.map((f) => path.basename(f));

  if (args.dryRun) {
    process.stdout.write(
      `stage: DRY RUN\n  platform : ${platform}\n  version  : ${version}\n` +
        `  into     : ${platformDir}\n  clear    : ${args.keepExisting ? "no" : "yes"}\n` +
        staged.map((n) => `  file     : ${n}\n`).join(""),
    );
    return;
  }

  await mkdir(platformDir, { recursive: true });

  // Clear first — see the header. Only what we are NOT about to write, so
  // re-staging the same version is idempotent rather than a
  // delete-then-copy window where the box has nothing to serve.
  if (!args.keepExisting) {
    let existing = [];
    try {
      existing = await readdir(platformDir);
    } catch {
      existing = [];
    }
    for (const name of existing) {
      if (staged.includes(name)) continue;
      // `recursive` matters: a stray subdirectory in a platform dir (an
      // unpacked bundle, a `.git`, an editor backup folder) would otherwise
      // abort the clear with an opaque ERR_FS_EISDIR *after* mkdir and
      // *before* any copy — leaving the platform dir half-cleared.
      await rm(path.join(platformDir, name), { force: true, recursive: true });
      process.stdout.write(`stage: removed stale ${platform}/${name}\n`);
    }
  }

  // Copy via a temp name in the SAME directory, then rename. A 220 MB
  // copy is not instant and gen-catalog must never hash a half-written
  // file; a rename within one directory is atomic.
  for (const file of args.files) {
    const name = path.basename(file);
    const dest = path.join(platformDir, name);
    const tmp = `${dest}.staging`;
    await copyFile(path.resolve(process.cwd(), file), tmp);
    await rename(tmp, dest);
    process.stdout.write(`stage: ${platform}/${name}\n`);
  }

  // platforms.json is the hand-authored half of the contract. Merge into
  // it rather than rewriting, so staging Windows never drops the Android
  // store URL someone set last month.
  const metaPath = path.join(root, "platforms.json");
  let meta = {};
  try {
    meta = JSON.parse(await readFile(metaPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") fail(`cannot read ${metaPath}: ${err.message}`);
  }
  const entry = { ...(meta[platform] ?? {}), version };
  if (args.minOsVersion) entry.minOsVersion = args.minOsVersion;
  if (args.storeUrl) entry.storeUrl = args.storeUrl;
  if (args.note) entry.note = args.note;
  meta[platform] = entry;
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  process.stdout.write(`stage: platforms.json — ${platform} ${version}\n`);

  // Regenerate, then prove. Running the generator is what makes an
  // artifact servable at all; the --check afterwards is not ceremony, it
  // is the same digest gate the box applies at serve time, run here so a
  // bad stage fails on the operator's terminal instead of on a customer's
  // download.
  const gen = path.join(HERE, "gen-catalog.mjs");
  execFileSync(process.execPath, [gen, "--dir", root], { stdio: "inherit" });
  execFileSync(process.execPath, [gen, "--dir", root, "--check"], { stdio: "inherit" });

  process.stdout.write(
    "stage: done — the orchestrator memoises the catalog, so restart it before this reaches /downloads\n",
  );
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
