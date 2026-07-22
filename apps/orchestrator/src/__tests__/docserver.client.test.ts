/**
 * WARP-882 / WS-4 — OnlyOffice Document Server client.
 *
 * Engine-agnostic WOPI-style integration: the orchestrator mints an editor
 * session that the dashboard hands to the Nextcloud `onlyoffice` connector,
 * which in turn drives the Document Server. These tests pin the contract:
 *   - `docServerHealthy()` — reachability probe against DOCS_INTERNAL_URL.
 *   - `ncMintEditorSession()` — resolves the NC fileId (via ncGetFileId, 3 args)
 *     and returns the editor URL + a short-lived signed access token.
 *   - `DocServerUnavailableError` — thrown when DOCS is disabled or unreachable,
 *     so the route layer can map it to a 503.
 *
 * Nothing here dials a real Document Server: `fetch` and the Nextcloud client
 * are mocked. End-to-end co-authoring is an on-box integration test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    NEXTCLOUD_URL: "http://nextcloud.test",
    DOCS_INTERNAL_URL: "http://docserver.test",
    DOCS_ENABLED: true,
    DOCS_EDITOR_PUBLIC_PATH: "/docs/",
    DOCS_ACCESS_TOKEN_TTL_SECONDS: 600,
    ONLYOFFICE_JWT_SECRET: "test-onlyoffice-secret-32-chars-aaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/nextcloud.client.js", () => ({
  ncGetFileId: vi.fn(),
  ncListSharedWithMe: vi.fn(),
}));

import {
  ncMintEditorSession,
  docServerHealthy,
  DocServerUnavailableError,
} from "../services/docserver.client.js";
import { ncGetFileId } from "../services/nextcloud.client.js";

const ncGetFileIdMock = ncGetFileId as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("docServerHealthy", () => {
  it("returns true when the doc server health endpoint responds 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "true" }),
    );
    await expect(docServerHealthy()).resolves.toBe(true);
  });

  it("returns false when the doc server responds non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "" }),
    );
    await expect(docServerHealthy()).resolves.toBe(false);
  });

  it("returns false (never throws) when the fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(docServerHealthy()).resolves.toBe(false);
  });
});

describe("ncMintEditorSession", () => {
  it("resolves the file id with the 3-arg ncGetFileId and returns the session payload", async () => {
    ncGetFileIdMock.mockResolvedValue(4242);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "true" }),
    );

    const session = await ncMintEditorSession(
      "nc-token",
      "alice",
      "/Documents/report.docx",
      "edit",
    );

    // 3-arg contract: (token, ncUser, path) — NOT a request object.
    expect(ncGetFileIdMock).toHaveBeenCalledWith("nc-token", "alice", "/Documents/report.docx");
    expect(session.ncFileId).toBe(4242);
    expect(session.mode).toBe("edit");
    expect(typeof session.editorUrl).toBe("string");
    expect(session.editorUrl).toContain("4242");
    expect(typeof session.accessToken).toBe("string");
    expect(session.accessToken.length).toBeGreaterThan(0);
    expect(session.accessTokenTtl).toBeGreaterThan(0);
  });

  it("honours a view-mode request distinctly from edit", async () => {
    ncGetFileIdMock.mockResolvedValue(7);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "true" }),
    );
    const session = await ncMintEditorSession("t", "bob", "/x.docx", "view");
    expect(session.mode).toBe("view");
  });

  // WARP-882 co-authoring: the engine joins two opens into ONE live document iff
  // their documentKey matches. So two DIFFERENT users opening the SAME file must
  // get the SAME documentKey — otherwise they fork into separate sessions and
  // never co-author. The key is derived from ncFileId only (never per-user).
  it("derives the SAME documentKey for two different users on the same file (shared co-authoring session)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "true" }),
    );
    ncGetFileIdMock.mockResolvedValue(4242);
    const alice = await ncMintEditorSession("nc-token-a", "alice", "/Documents/report.docx", "edit");
    ncGetFileIdMock.mockResolvedValue(4242);
    const bob = await ncMintEditorSession("nc-token-b", "bob", "/Documents/report.docx", "edit");

    expect(alice.documentKey).toBe(bob.documentKey);
    expect(alice.documentKey.length).toBeGreaterThan(0);
  });

  // Same user, but the path changed (rename/move) — the in-progress shared
  // session must survive, so the key tracks the stable ncFileId, not the path.
  it("derives the SAME documentKey when the same fileId is opened under a different path (rename-safe)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "true" }),
    );
    ncGetFileIdMock.mockResolvedValue(99);
    const before = await ncMintEditorSession("t", "alice", "/Documents/old-name.docx", "edit");
    ncGetFileIdMock.mockResolvedValue(99);
    const after = await ncMintEditorSession("t", "alice", "/Documents/new-name.docx", "edit");
    expect(before.documentKey).toBe(after.documentKey);
  });

  // Two DIFFERENT files must namespace into DIFFERENT engine sessions.
  it("derives DIFFERENT documentKeys for different files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "true" }),
    );
    ncGetFileIdMock.mockResolvedValue(1);
    const one = await ncMintEditorSession("t", "alice", "/a.docx", "edit");
    ncGetFileIdMock.mockResolvedValue(2);
    const two = await ncMintEditorSession("t", "alice", "/b.docx", "edit");
    expect(one.documentKey).not.toBe(two.documentKey);
  });

  it("throws DocServerUnavailableError when DOCS is unreachable", async () => {
    ncGetFileIdMock.mockResolvedValue(7);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(
      ncMintEditorSession("t", "bob", "/x.docx", "edit"),
    ).rejects.toBeInstanceOf(DocServerUnavailableError);
  });

  it("throws a non-DocServerUnavailable error (not 503) when the file does not exist", async () => {
    ncGetFileIdMock.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "true" }),
    );
    await expect(
      ncMintEditorSession("t", "bob", "/missing.docx", "edit"),
    ).rejects.not.toBeInstanceOf(DocServerUnavailableError);
  });
});

describe("DocServerUnavailableError", () => {
  it("carries a stable code + 503 status and serializes via toJSON", () => {
    const err = new DocServerUnavailableError("docs down");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("DOCS_UNAVAILABLE");
    expect(err.status).toBe(503);
    expect(err.toJSON()).toMatchObject({ code: "DOCS_UNAVAILABLE", status: 503 });
  });
});

describe("ncMintEditorSession — DOCS disabled", () => {
  it("throws DocServerUnavailableError when DOCS_ENABLED is false", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: {
        NEXTCLOUD_URL: "http://nextcloud.test",
        DOCS_INTERNAL_URL: "http://docserver.test",
        DOCS_ENABLED: false,
        DOCS_EDITOR_PUBLIC_PATH: "/docs/",
        DOCS_ACCESS_TOKEN_TTL_SECONDS: 600,
        ONLYOFFICE_JWT_SECRET: "test-onlyoffice-secret-32-chars-aaa",
      },
    }));
    vi.doMock("../services/nextcloud.client.js", () => ({
      ncGetFileId: vi.fn().mockResolvedValue(1),
      ncListSharedWithMe: vi.fn(),
    }));
    const mod = await import("../services/docserver.client.js");
    await expect(
      mod.ncMintEditorSession("t", "u", "/x.docx", "edit"),
    ).rejects.toBeInstanceOf(mod.DocServerUnavailableError);
    vi.resetModules();
  });
});

// WARP-882 security fail-safe (reviewer finding): an empty ONLYOFFICE_JWT_SECRET
// must NEVER mint an editor session — every editor JWT is HS256-signed with this
// secret, so an empty secret would yield a forgeable document-access token. The
// guard lives in ncMintEditorSession() (the JWT-signing path), so even a reachable
// engine with an empty secret throws DocServerUnavailableError (→ 503) and no
// token is ever signed with the empty key.
describe("ncMintEditorSession — empty JWT secret (security fail-safe)", () => {
  const emptySecretConfig = {
    config: {
      NEXTCLOUD_URL: "http://nextcloud.test",
      DOCS_INTERNAL_URL: "http://docserver.test",
      DOCS_ENABLED: true,
      DOCS_EDITOR_PUBLIC_PATH: "/docs/",
      DOCS_ACCESS_TOKEN_TTL_SECONDS: 600,
      ONLYOFFICE_JWT_SECRET: "",
    },
  };

  it("throws DocServerUnavailableError (no forgeable JWT) even when the engine is reachable", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => emptySecretConfig);
    vi.doMock("../services/nextcloud.client.js", () => ({
      // fileId resolves AND the engine is healthy below — the ONLY thing wrong
      // is the empty secret, so this pins that the secret guard (not a missing
      // file or an unreachable engine) is what refuses the mint.
      ncGetFileId: vi.fn().mockResolvedValue(1),
      ncListSharedWithMe: vi.fn(),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "true" }),
    );
    const mod = await import("../services/docserver.client.js");
    await expect(
      mod.ncMintEditorSession("t", "u", "/x.docx", "edit"),
    ).rejects.toBeInstanceOf(mod.DocServerUnavailableError);
    vi.resetModules();
  });
});
