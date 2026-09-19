/**
 * App-download store — the serve-time gates, against REAL files.
 *
 * These use a real temp directory rather than a mocked fs on purpose:
 * the thing under test is "do the bytes on disk still match the digest
 * that shipped", and a mocked filesystem would let that assertion pass
 * without ever hashing anything.
 *
 * Every guard here is mutation-tested — each refusal case starts from a
 * setup that is proven to SUCCEED in the first test, then changes exactly
 * one thing. A guard that never sees its own failure mode is not a guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppDownloadsStore } from "./store.js";

const INSTALLER_BYTES = Buffer.from("MZ fake installer payload, but real bytes");
const SIG_BYTES = Buffer.from("untrusted comment: minisign signature\nRWQ...\n");

const sha256 = (buf: Buffer) =>
  createHash("sha256").update(buf).digest("hex");

let dir: string;

/** Write a staging tree that the store should accept. Callers mutate it. */
async function stage(
  catalogOverride?: (catalog: Record<string, unknown>) => void,
) {
  await mkdir(path.join(dir, "windows"), { recursive: true });
  await writeFile(
    path.join(dir, "windows", "Droplet-setup.exe"),
    INSTALLER_BYTES,
  );
  await writeFile(
    path.join(dir, "windows", "Droplet-setup.exe.sig"),
    SIG_BYTES,
  );

  const catalog: Record<string, unknown> = {
    schemaVersion: 1,
    generatedAt: "2026-08-13T10:00:00.000Z",
    platforms: [
      {
        platform: "windows",
        version: "0.2.0",
        primary: "Droplet-setup.exe",
        assets: [
          {
            name: "Droplet-setup.exe",
            kind: "installer",
            size: INSTALLER_BYTES.length,
            sha256: sha256(INSTALLER_BYTES),
          },
          {
            name: "Droplet-setup.exe.sig",
            kind: "signature",
            size: SIG_BYTES.length,
            sha256: sha256(SIG_BYTES),
            signs: "Droplet-setup.exe",
            signatureAlgorithm: "minisign-ed25519",
          },
        ],
      },
    ],
  };

  catalogOverride?.(catalog);
  await writeFile(
    path.join(dir, "catalog.json"),
    JSON.stringify(catalog, null, 2),
  );
}

/** Drain a stream so assertions can compare the bytes actually served. */
async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "droplet-appdl-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AppDownloadsStore — the baseline that must pass", () => {
  it("loads a staged catalog and reports digest-only attestation by default", async () => {
    await stage();
    const store = new AppDownloadsStore({ dir });

    const loaded = await store.loadCatalog();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Never claims "signed" when no signature was checked.
    expect(loaded.attestation).toBe("digest-only");
    expect(loaded.catalog.platforms).toHaveLength(1);
  });

  it("serves the exact bytes when the digest matches", async () => {
    await stage();
    const store = new AppDownloadsStore({ dir });

    const opened = await store.openAsset("windows", "Droplet-setup.exe");
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(opened.size).toBe(INSTALLER_BYTES.length);
    expect(opened.contentType).toBe("application/octet-stream");
    await expect(readAll(opened.stream)).resolves.toEqual(INSTALLER_BYTES);
  });

  it("serves the passenger signature asset too", async () => {
    await stage();
    const store = new AppDownloadsStore({ dir });

    const opened = await store.openAsset("windows", "Droplet-setup.exe.sig");
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await expect(readAll(opened.stream)).resolves.toEqual(SIG_BYTES);
  });
});

describe("AppDownloadsStore — the digest gate actually fires", () => {
  it("REFUSES an artifact whose bytes changed but whose size did not", async () => {
    await stage();
    // Same length, different content — this is the case a size check alone
    // would wave through, and the one the digest exists for.
    const tampered = Buffer.from(INSTALLER_BYTES);
    tampered[0] = tampered[0] ^ 0xff;
    expect(tampered.length).toBe(INSTALLER_BYTES.length);
    await writeFile(path.join(dir, "windows", "Droplet-setup.exe"), tampered);

    const store = new AppDownloadsStore({ dir });
    const opened = await store.openAsset("windows", "Droplet-setup.exe");

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.failureReason).toBe("digest_mismatch");
    // No stream is handed back at all — a refusal cannot surface as a
    // truncated or partial download.
    expect(opened).not.toHaveProperty("stream");
  });

  it("REFUSES an artifact that grew, naming the size mismatch first", async () => {
    await stage();
    await writeFile(
      path.join(dir, "windows", "Droplet-setup.exe"),
      Buffer.concat([INSTALLER_BYTES, Buffer.from("extra")]),
    );

    const store = new AppDownloadsStore({ dir });
    const opened = await store.openAsset("windows", "Droplet-setup.exe");

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.failureReason).toBe("size_mismatch");
  });

  it("REFUSES when the catalog lists an asset that is not on disk", async () => {
    await stage((catalog) => {
      (catalog.platforms as Array<{ assets: unknown[] }>)[0].assets.push({
        name: "ghost.exe",
        kind: "installer",
        size: 10,
        sha256: sha256(Buffer.from("nope")),
      });
    });

    const store = new AppDownloadsStore({ dir });
    const opened = await store.openAsset("windows", "ghost.exe");

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.failureReason).toBe("asset_missing");
  });
});

describe("AppDownloadsStore — traversal cannot reach the filesystem", () => {
  it.each([
    "../catalog.json",
    "../../etc/passwd",
    "..\\..\\windows\\system32\\config\\sam",
    "/etc/passwd",
    "Droplet-setup.exe/../../catalog.json",
  ])("refuses %j without touching disk", async (name) => {
    await stage();
    const store = new AppDownloadsStore({ dir });

    const opened = await store.openAsset("windows", name);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    // Stops at the catalog lookup — the name is not in the catalog, so no
    // path is ever built from it.
    expect(opened.failureReason).toBe("asset_missing");
  });

  it("refuses a catalog.json request even though the file plainly exists", async () => {
    await stage();
    const store = new AppDownloadsStore({ dir });

    const opened = await store.openAsset("windows", "catalog.json");
    expect(opened.ok).toBe(false);
  });
});

describe("AppDownloadsStore — honest degradation", () => {
  it("reports catalog_missing (not an error) when nothing is staged", async () => {
    const store = new AppDownloadsStore({ dir });
    const loaded = await store.loadCatalog();

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failureReason).toBe("catalog_missing");
  });

  it("propagates a parser refusal rather than serving a broken catalog", async () => {
    await mkdir(path.join(dir, "windows"), { recursive: true });
    await writeFile(path.join(dir, "catalog.json"), "{ not json");

    const store = new AppDownloadsStore({ dir });
    const loaded = await store.loadCatalog();

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failureReason).toBe("malformed_catalog");
  });

  it("refuses every asset while the catalog is unloadable", async () => {
    await mkdir(path.join(dir, "windows"), { recursive: true });
    await writeFile(path.join(dir, "windows", "Droplet-setup.exe"), INSTALLER_BYTES);
    await writeFile(path.join(dir, "catalog.json"), "{ not json");

    const store = new AppDownloadsStore({ dir });
    const opened = await store.openAsset("windows", "Droplet-setup.exe");

    // The bytes are right there and readable — but with no trusted catalog
    // there is no digest to check them against, so they are not served.
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.failureReason).toBe("malformed_catalog");
  });

  it("returns null for a platform the catalog omits", async () => {
    await stage();
    const store = new AppDownloadsStore({ dir });
    await expect(store.platform("linux")).resolves.toBeNull();
    await expect(store.platform("windows")).resolves.not.toBeNull();
  });
});

describe("AppDownloadsStore — the signature flag is a real gate", () => {
  it("refuses to serve anything when a signature is required but absent", async () => {
    await stage();
    const store = new AppDownloadsStore({ dir, requireSignature: true });

    const loaded = await store.loadCatalog();
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failureReason).toBe("signature_missing");
  });

  it("refuses when the signature exists but the trust anchor is a placeholder", async () => {
    await stage();
    // A signature file present, but the anchor cannot verify it. This is
    // TODAY'S production state if the flag were switched on — the test
    // pins that it fails closed rather than serving unverified bytes.
    await writeFile(path.join(dir, "catalog.json.sig"), "not-a-real-signature");
    const store = new AppDownloadsStore({
      dir,
      requireSignature: true,
      publicKeyPath: path.join(dir, "missing-anchor.pub"),
    });

    const loaded = await store.loadCatalog();
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failureReason).toBe("signature_failed");
  });

  it("loads normally with the flag OFF — the default posture still serves", async () => {
    await stage();
    await writeFile(path.join(dir, "catalog.json.sig"), "not-a-real-signature");
    const store = new AppDownloadsStore({ dir, requireSignature: false });

    const loaded = await store.loadCatalog();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // A signature file being present must NOT upgrade the claim — only an
    // actual verification does.
    expect(loaded.attestation).toBe("digest-only");
  });
});

describe("AppDownloadsStore — caching", () => {
  it("re-checks the digest on every download even though the catalog is cached", async () => {
    await stage();
    const store = new AppDownloadsStore({ dir });

    const first = await store.openAsset("windows", "Droplet-setup.exe");
    expect(first.ok).toBe(true);
    if (first.ok) await readAll(first.stream);

    // Tamper AFTER a successful read, without touching the catalog. A
    // memoised verification result would let this through.
    const tampered = Buffer.from(INSTALLER_BYTES);
    tampered[1] = tampered[1] ^ 0xff;
    await writeFile(path.join(dir, "windows", "Droplet-setup.exe"), tampered);

    const second = await store.openAsset("windows", "Droplet-setup.exe");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failureReason).toBe("digest_mismatch");
  });

  it("a stage under a running process is visible without invalidate()", async () => {
    // WARP-2666. This used to assert the opposite ("still cached as missing
    // until told otherwise"), which pinned the bug: the host side of the
    // mount IS writable, so `stage.sh` really does drop a catalog next to a
    // running orchestrator, and a memoised failure made that stage invisible
    // until someone restarted the container — indistinguishable from a stage
    // that silently failed. `invalidate()` has no production caller, so a
    // restart was the only cure.
    const store = new AppDownloadsStore({ dir });
    await expect(store.loadCatalog()).resolves.toMatchObject({
      ok: false,
      failureReason: "catalog_missing",
    });

    await stage();
    await expect(store.loadCatalog()).resolves.toMatchObject({ ok: true });
  });

  it("still memoises a SUCCESSFUL catalog read", async () => {
    // The counterweight to the test above: not caching failures must not
    // turn into not caching at all. A good catalog is read once — re-reading
    // and re-parsing it per request is the overhead the memo exists to
    // avoid, and only the DIGESTS are deliberately re-checked every time.
    await stage();
    const store = new AppDownloadsStore({ dir });
    await expect(store.loadCatalog()).resolves.toMatchObject({ ok: true });

    // Remove the catalog entirely. A re-read would now fail; the memo must
    // still answer with the version it already parsed.
    await rm(path.join(dir, "catalog.json"));
    await expect(store.loadCatalog()).resolves.toMatchObject({ ok: true });

    store.invalidate();
    await expect(store.loadCatalog()).resolves.toMatchObject({
      ok: false,
      failureReason: "catalog_missing",
    });
  });
});
