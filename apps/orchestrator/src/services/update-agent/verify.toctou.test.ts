/**
 * WARP-537 review fix — verify/parse TOCTOU regression.
 *
 * The original composed chain verified the file AT `opts.manifestPath`
 * and then RE-READ that path to parse. A writer swapping the file
 * between the two operations got unverified bytes into the parser. These
 * tests use a fake cosign (mocked `execFile`) whose side effect performs
 * exactly that swap at the instant "verification" runs, and pin that:
 *
 *   1. the manifest returned to the caller is built from the bytes read
 *      BEFORE the swap — the attacker's post-swap content never parses;
 *   2. the blob path handed to cosign is a private copy holding those
 *      same bytes, never the caller-visible (swappable) original path;
 *   3. the private copy is cleaned up, on success and on refusal.
 *
 * The spawn is mocked here to make the swap deterministic; the actual
 * cryptographic accept/reject behaviour is covered by the real-cosign
 * golden suite in verify.test.ts, which stays unmocked. This file is
 * separate from verify.test.ts precisely so the vi.mock of
 * node:child_process cannot leak into the golden tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

import { verifyAndParseRelease } from "./verify.js";

const fx = (name: string): string =>
  path.join(__dirname, "__fixtures__", name);

const ORIGINAL_SHA = "0123456789abcdef0123456789abcdef01234567";
const ATTACKER_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

type ExecCallback = (
  err: NodeJS.ErrnoException | null,
  stdout: string,
  stderr: string,
) => void;

describe("verifyAndParseRelease TOCTOU (WARP-537 review)", () => {
  let workDir: string;
  let manifestPath: string;
  let validBytes: Buffer;
  let attackerBytes: Buffer;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "toctou-test-"));
    manifestPath = path.join(workDir, "release.json");
    validBytes = readFileSync(fx("release.valid.json"));
    // Attacker payload: schema-valid on purpose — under the old
    // verify-then-re-read shape it would have parsed cleanly and been
    // acted on, which is exactly the hole this suite pins shut.
    attackerBytes = Buffer.from(
      validBytes.toString("utf8").replace(ORIGINAL_SHA, ATTACKER_SHA),
      "utf8",
    );
    writeFileSync(manifestPath, validBytes);
    execFileMock.mockReset();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("parses the bytes it verified, not the file swapped in during verification", async () => {
    let blobPathSeenByCosign = "";
    let blobBytesSeenByCosign: Buffer = Buffer.alloc(0);

    execFileMock.mockImplementation(
      (
        _bin: string,
        args: string[],
        _options: object,
        callback: ExecCallback,
      ) => {
        // The moment "cosign" runs, the attacker swaps the file at the
        // caller-visible path — the classic TOCTOU window.
        writeFileSync(manifestPath, attackerBytes);
        // Record what blob cosign was actually pointed at, right now.
        blobPathSeenByCosign = args[args.length - 1];
        blobBytesSeenByCosign = readFileSync(blobPathSeenByCosign);
        callback(null, "", "");
      },
    );

    const res = await verifyAndParseRelease({
      manifestPath,
      signaturePath: fx("release.valid.json.sig"),
      publicKeyPath: fx("TEST-ONLY-signing.pub"),
    });

    // The swap really happened at the observable path…
    expect(readFileSync(manifestPath).equals(attackerBytes)).toBe(true);

    // …but the parsed manifest is the pre-swap, verified content.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.release.gitSha).toBe(ORIGINAL_SHA);

    // Cosign was pointed at a private copy of the read bytes, never the
    // swappable original path.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(path.resolve(blobPathSeenByCosign)).not.toBe(
      path.resolve(manifestPath),
    );
    expect(blobBytesSeenByCosign.equals(validBytes)).toBe(true);

    // The private copy does not outlive the call.
    expect(existsSync(blobPathSeenByCosign)).toBe(false);
  });

  it("still refuses when verification of the read bytes fails, and cleans up the private copy", async () => {
    let blobPathSeenByCosign = "";

    execFileMock.mockImplementation(
      (
        _bin: string,
        args: string[],
        _options: object,
        callback: ExecCallback,
      ) => {
        blobPathSeenByCosign = args[args.length - 1];
        const err: NodeJS.ErrnoException = new Error(
          "signature mismatch",
        );
        callback(err, "", "invalid signature");
      },
    );

    const res = await verifyAndParseRelease({
      manifestPath,
      signaturePath: fx("release.valid.json.sig"),
      publicKeyPath: fx("TEST-ONLY-signing.pub"),
    });

    expect(res).toMatchObject({
      ok: false,
      failureReason: "signature_failed",
    });
    expect(blobPathSeenByCosign).not.toBe("");
    expect(existsSync(blobPathSeenByCosign)).toBe(false);
  });

  it("fails closed on the placeholder trust anchor without ever spawning cosign", async () => {
    execFileMock.mockImplementation(() => {
      throw new Error("cosign must not spawn on a placeholder anchor");
    });

    const res = await verifyAndParseRelease({
      manifestPath,
      signaturePath: fx("release.valid.json.sig"),
      publicKeyPath: fx("placeholder-cosign.pub"),
    });

    expect(res).toMatchObject({
      ok: false,
      failureReason: "trust_anchor_placeholder",
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
