/**
 * WARP-882 / WARP-1686 — document-server client.
 *
 * Engine-aware WOPI integration: the orchestrator mints an editor session that
 * the dashboard hands to the Nextcloud connector app for the CONFIGURED engine
 * (DOCS_ENGINE — collabora default, onlyoffice selectable), which in turn
 * drives the document server. These tests pin the contract:
 *   - `docServerHealthy()` — reachability probe against DOCS_INTERNAL_URL,
 *     ENGINE-SPECIFIC: collabora = /hosting/discovery returning the WOPI
 *     discovery XML; onlyoffice = /healthcheck returning the literal `true`.
 *   - `ncMintEditorSession()` — resolves the NC fileId (via ncGetFileId, 3 args)
 *     and returns the engine's connector editor URL + a short-lived signed
 *     access token. The URL is BROWSER-FACING (gateway /nextcloud/ leg), never
 *     the compose-internal NEXTCLOUD_URL.
 *   - `DocServerUnavailableError` — thrown when DOCS is disabled or unreachable,
 *     so the route layer can map it to a 503.
 *
 * Nothing here dials a real document server: `fetch` and the Nextcloud client
 * are mocked. End-to-end co-authoring is an on-box integration test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    NEXTCLOUD_URL: "http://nextcloud.test",
    NEXTCLOUD_PUBLIC_PATH: "/nextcloud",
    DOCS_INTERNAL_URL: "http://docserver.test",
    DOCS_ENABLED: true,
    DOCS_ENGINE: "collabora",
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

// Healthy-engine fetch response for the DEFAULT engine (collabora): coolwsd's
// /hosting/discovery answer. A fresh object per call site (the client reads
// text() once).
const discoveryOk = () => ({
  ok: true,
  status: 200,
  text: async () =>
    '<wopi-discovery><net-zone name="external-http"/></wopi-discovery>',
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("docServerHealthy — collabora (default engine)", () => {
  it("probes /hosting/discovery and accepts the WOPI discovery XML", async () => {
    const fetchMock = vi.fn().mockResolvedValue(discoveryOk());
    vi.stubGlobal("fetch", fetchMock);
    await expect(docServerHealthy()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://docserver.test/hosting/discovery",
      expect.anything(),
    );
  });

  it("rejects a 200 whose body is NOT a discovery document", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "<html>starting</html>" }),
    );
    await expect(docServerHealthy()).resolves.toBe(false);
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

describe("docServerHealthy — DOCS_ENGINE=onlyoffice", () => {
  it("probes /healthcheck and accepts the literal `true`", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: {
        NEXTCLOUD_URL: "http://nextcloud.test",
        NEXTCLOUD_PUBLIC_PATH: "/nextcloud",
        DOCS_INTERNAL_URL: "http://docserver.test",
        DOCS_ENABLED: true,
        DOCS_ENGINE: "onlyoffice",
        DOCS_EDITOR_PUBLIC_PATH: "/docs/",
        DOCS_ACCESS_TOKEN_TTL_SECONDS: 600,
        ONLYOFFICE_JWT_SECRET: "test-onlyoffice-secret-32-chars-aaa",
      },
    }));
    vi.doMock("../services/nextcloud.client.js", () => ({
      ncGetFileId: vi.fn(),
      ncListSharedWithMe: vi.fn(),
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "true" });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../services/docserver.client.js");
    await expect(mod.docServerHealthy()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://docserver.test/healthcheck",
      expect.anything(),
    );
    vi.resetModules();
  });
});

describe("ncMintEditorSession", () => {
  it("resolves the file id with the 3-arg ncGetFileId and returns the session payload", async () => {
    ncGetFileIdMock.mockResolvedValue(4242);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(discoveryOk()));

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

  // WARP-1686: the editor URL is the BROWSER-facing connector page for the
  // configured engine, on the gateway's /nextcloud/ leg. It must never carry
  // the compose-internal NEXTCLOUD_URL host — a browser cannot resolve it.
  it("returns the richdocuments connector page (default engine), browser-facing", async () => {
    ncGetFileIdMock.mockResolvedValue(4242);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(discoveryOk()));
    const session = await ncMintEditorSession("t", "alice", "/a.docx", "edit");
    expect(session.editorUrl).toBe(
      "/nextcloud/index.php/apps/richdocuments/index?fileId=4242",
    );
    expect(session.editorUrl).not.toContain("nextcloud.test");
  });

  it("honours a view-mode request distinctly from edit", async () => {
    ncGetFileIdMock.mockResolvedValue(7);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(discoveryOk()));
    const session = await ncMintEditorSession("t", "bob", "/x.docx", "view");
    expect(session.mode).toBe("view");
  });

  // WARP-882 co-authoring: the engine joins two opens into ONE live document iff
  // their documentKey matches. So two DIFFERENT users opening the SAME file must
  // get the SAME documentKey — otherwise they fork into separate sessions and
  // never co-author. The key is derived from ncFileId only (never per-user).
  it("derives the SAME documentKey for two different users on the same file (shared co-authoring session)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(discoveryOk()));
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(discoveryOk()));
    ncGetFileIdMock.mockResolvedValue(99);
    const before = await ncMintEditorSession("t", "alice", "/Documents/old-name.docx", "edit");
    ncGetFileIdMock.mockResolvedValue(99);
    const after = await ncMintEditorSession("t", "alice", "/Documents/new-name.docx", "edit");
    expect(before.documentKey).toBe(after.documentKey);
  });

  // Two DIFFERENT files must namespace into DIFFERENT engine sessions.
  it("derives DIFFERENT documentKeys for different files", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(discoveryOk()));
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(discoveryOk()));
    await expect(
      ncMintEditorSession("t", "bob", "/missing.docx", "edit"),
    ).rejects.not.toBeInstanceOf(DocServerUnavailableError);
  });
});

describe("ncMintEditorSession — DOCS_ENGINE=onlyoffice editor URL", () => {
  it("returns the onlyoffice connector page with the server-decided mode", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: {
        NEXTCLOUD_URL: "http://nextcloud.test",
        NEXTCLOUD_PUBLIC_PATH: "/nextcloud",
        DOCS_INTERNAL_URL: "http://docserver.test",
        DOCS_ENABLED: true,
        DOCS_ENGINE: "onlyoffice",
        DOCS_EDITOR_PUBLIC_PATH: "/docs/",
        DOCS_ACCESS_TOKEN_TTL_SECONDS: 600,
        ONLYOFFICE_JWT_SECRET: "test-onlyoffice-secret-32-chars-aaa",
      },
    }));
    vi.doMock("../services/nextcloud.client.js", () => ({
      ncGetFileId: vi.fn().mockResolvedValue(42),
      ncListSharedWithMe: vi.fn(),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "true" }),
    );
    const mod = await import("../services/docserver.client.js");
    const session = await mod.ncMintEditorSession("t", "alice", "/a.docx", "view");
    expect(session.editorUrl).toBe("/nextcloud/index.php/apps/onlyoffice/42?mode=view");
    vi.resetModules();
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
        NEXTCLOUD_PUBLIC_PATH: "/nextcloud",
        DOCS_INTERNAL_URL: "http://docserver.test",
        DOCS_ENABLED: false,
        DOCS_ENGINE: "collabora",
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
// token is ever signed with the empty key. Unchanged under WARP-1686: the
// orchestrator signs its session tokens with this secret under BOTH engines
// (secrets.sh generates it unconditionally), so the fail-safe stays engine-wide.
describe("ncMintEditorSession — empty JWT secret (security fail-safe)", () => {
  const emptySecretConfig = {
    config: {
      NEXTCLOUD_URL: "http://nextcloud.test",
      NEXTCLOUD_PUBLIC_PATH: "/nextcloud",
      DOCS_INTERNAL_URL: "http://docserver.test",
      DOCS_ENABLED: true,
      DOCS_ENGINE: "collabora",
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
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "<wopi-discovery></wopi-discovery>",
      }),
    );
    const mod = await import("../services/docserver.client.js");
    await expect(
      mod.ncMintEditorSession("t", "u", "/x.docx", "edit"),
    ).rejects.toBeInstanceOf(mod.DocServerUnavailableError);
    vi.resetModules();
  });
});
