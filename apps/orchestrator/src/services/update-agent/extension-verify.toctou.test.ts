/**
 * WARP-2900 (ADR-056 slice H1): verifyExtensionStatement reads its inputs
 * exactly once.
 *
 * The statement and manifest arrive as bytes (from ExtensionVersion rows in
 * H2), and verification awaits a cosign spawn. A caller-owned Buffer can be
 * written to during that await, the in-memory twin of verify.toctou.test.ts's
 * file swap. These tests use a fake cosign (mocked execFile) whose side
 * effect overwrites the caller's buffers at the instant "verification" runs,
 * and pin that:
 *
 *   1. the statement and manifest returned (and digest-checked) are the
 *      bytes as they were on entry, not the overwritten ones;
 *   2. cosign is pointed at a private copy holding those same bytes;
 *   3. the private copy is removed on success and on refusal.
 *
 * Kept separate from the real-cosign suites so the vi.mock of
 * node:child_process cannot leak into them.
 *
 * MUTATION: read opts.statement / opts.manifest after the await instead of
 * the entry copies -> test 1 goes red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

import { verifyExtensionStatement } from "./extension-verify.js";

const fx = (name: string): string => path.join(__dirname, "__fixtures__", name);

type ExecCallback = (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

const ORIGINAL_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ATTACKER_COMMIT = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

describe("verifyExtensionStatement TOCTOU (WARP-2900)", () => {
  let statement: Buffer;
  let manifest: Buffer;
  let original: Buffer;
  let originalManifest: Buffer;

  beforeEach(() => {
    original = readFileSync(fx("extension.valid.json"));
    originalManifest = readFileSync(fx("extension.manifest.json"));
    statement = Buffer.from(original);
    manifest = Buffer.from(originalManifest);
    execFileMock.mockReset();
  });

  it("verifies and returns the bytes it was given, not bytes written during the cosign await", async () => {
    let blobPath = "";
    let blobBytes = Buffer.alloc(0);
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _o: object, cb: ExecCallback) => {
        // The attacker rewrites the caller's buffers mid-verification. Same
        // length, so an in-place overwrite is exactly what a shared buffer
        // would see.
        statement.write(
          original.toString("utf8").replace(ORIGINAL_COMMIT, ATTACKER_COMMIT),
          0,
          "utf8",
        );
        manifest.fill(0x20);
        blobPath = args[args.length - 1];
        blobBytes = readFileSync(blobPath);
        cb(null, "", "");
      },
    );

    const res = await verifyExtensionStatement({
      statement,
      signature: readFileSync(fx("extension.valid.json.release.sig"), "utf8"),
      manifest,
      boxKey: null,
      releaseAnchorPath: fx("TEST-ONLY-signing.pub"),
    });

    // The overwrite really happened to the caller's buffers...
    expect(statement.toString("utf8")).toContain(ATTACKER_COMMIT);
    // ...but the verified result is the entry-time content.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.statement.commit).toBe(ORIGINAL_COMMIT);
    expect(res.statementBytes.equals(original)).toBe(true);
    expect(res.manifestBytes.equals(originalManifest)).toBe(true);
    expect(res.manifest.id).toBe("word-count");

    // cosign saw a private copy of the entry bytes, then it was removed.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(blobBytes.equals(original)).toBe(true);
    expect(existsSync(blobPath)).toBe(false);
  });

  it("removes the private copy when cosign refuses", async () => {
    let blobPath = "";
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _o: object, cb: ExecCallback) => {
        blobPath = args[args.length - 1];
        const err = Object.assign(new Error("exit 1"), { code: 1 }) as unknown as NodeJS.ErrnoException;
        cb(err, "", "invalid signature");
      },
    );
    const res = await verifyExtensionStatement({
      statement,
      signature: readFileSync(fx("extension.valid.json.neither.sig"), "utf8"),
      manifest,
      boxKey: null,
      releaseAnchorPath: fx("TEST-ONLY-signing.pub"),
    });
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
    expect(blobPath).not.toBe("");
    expect(existsSync(blobPath)).toBe(false);
  });

  it("hands cosign the signature as a private file too", async () => {
    let sigPath = "";
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _o: object, cb: ExecCallback) => {
        sigPath = args[args.indexOf("--signature") + 1];
        expect(readFileSync(sigPath, "utf8")).toBe(
          readFileSync(fx("extension.valid.json.release.sig"), "utf8").trim(),
        );
        cb(null, "", "");
      },
    );
    await verifyExtensionStatement({
      statement,
      signature: readFileSync(fx("extension.valid.json.release.sig"), "utf8"),
      manifest,
      boxKey: null,
      releaseAnchorPath: fx("TEST-ONLY-signing.pub"),
    });
    expect(sigPath).not.toBe("");
    expect(existsSync(sigPath)).toBe(false);
  });
});
