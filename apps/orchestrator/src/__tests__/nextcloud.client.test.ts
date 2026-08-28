import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the config module before importing the client so it picks up our overrides.
vi.mock("../config.js", () => ({
  config: {
    NEXTCLOUD_URL: "http://nextcloud.test",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    FILES_ROOT: "/tmp/files",
    MAX_UPLOAD_SIZE_MB: 10,
    STORAGE_BACKEND: "nextcloud",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import {
  ncListFiles,
  ncUploadFile,
  NcPreconditionFailedError,
  ncDownloadFile,
  ncCreateDirectory,
  ncMoveFile,
  ncCopyFile,
  ncGetFileId,
  ncListTrash,
  ncRestoreTrashItem,
  ncDeleteTrashItem,
  ncEmptyTrash,
  ncListVersions,
  ncRestoreVersion,
  ncSetFavorite,
  ncListFavorites,
  ncSearchFiles,
  ncListRecents,
  ncFetchThumbnail,
  ncCreateShareV2,
  ncUpdateShare,
  ncDeleteShare,
  ncListSharedWithMe,
  ncListOutboundShares,
  ncEnsureGroup,
  ncDeleteFile,
  ncCreateRichdocumentsDirectUrl,
} from "../services/nextcloud.client.js";

/**
 * Minimal fetch mock. Each test replaces `global.fetch` with a vi.fn() that
 * returns a stub Response whose shape matches whatever the SUT consumes.
 */
function mockResponse(init: {
  ok: boolean;
  status: number;
  text?: string;
  json?: unknown;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    text: vi.fn().mockResolvedValue(init.text ?? ""),
    json: vi.fn().mockResolvedValue(init.json ?? {}),
    headers: new Headers(),
  } as unknown as Response;
}

describe("nextcloud.client — atomic create PUT (WARP-2523)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("sends If-None-Match: * only when the create-new option is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await ncUploadFile("t", "alice", "/Documents", "q3.pdf", Buffer.from("x"), {
      ifNoneMatch: true,
    });
    expect(fetchMock.mock.calls[0][1].headers["If-None-Match"]).toBe("*");

    // The plain upload path (WARP-2096's documented clobber semantics) must
    // stay byte-identical: no conditional header unless asked for.
    await ncUploadFile("t", "alice", "/Documents", "q3.pdf", Buffer.from("x"));
    expect(fetchMock.mock.calls[1][1].headers["If-None-Match"]).toBeUndefined();
  });

  it("maps a 412 under the create-new option to NcPreconditionFailedError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 412 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      ncUploadFile("t", "alice", "/d", "f.pdf", Buffer.from("x"), { ifNoneMatch: true }),
    ).rejects.toBeInstanceOf(NcPreconditionFailedError);
  });

  it("keeps the generic PUT error for a 412 without the option", async () => {
    // A 412 with no If-None-Match sent is some other precondition failing —
    // pretending it means "already exists" would be a lie.
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 412 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const err = await ncUploadFile("t", "alice", "/d", "f.pdf", Buffer.from("x")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NcPreconditionFailedError);
  });
});

describe("nextcloud.client — move/copy/rename", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe("ncMoveFile", () => {
    it("issues MOVE with Destination header and Overwrite=F by default", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 201 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncMoveFile("token123", "alice", "/a/one.txt", "/b/one.txt");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/remote.php/dav/files/alice/a/one.txt");
      expect(init.method).toBe("MOVE");
      expect(init.headers.Destination).toBe(
        "http://nextcloud.test/remote.php/dav/files/alice/b/one.txt"
      );
      expect(init.headers.Overwrite).toBe("F");
      expect(init.headers.Authorization).toBe("Bearer token123");
    });

    it("sets Overwrite=T when overwrite is true", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 204 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncMoveFile("token", "bob", "/x", "/y", true);

      const init = fetchMock.mock.calls[0][1];
      expect(init.headers.Overwrite).toBe("T");
    });

    it("throws on non-2xx WebDAV status", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 409 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(ncMoveFile("t", "u", "/a", "/b")).rejects.toThrow(/MOVE failed: 409/);
    });
  });

  describe("ncCopyFile", () => {
    it("issues COPY with Destination header", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 201 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncCopyFile("token", "alice", "/src.txt", "/dest.txt", false);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/remote.php/dav/files/alice/src.txt");
      expect(init.method).toBe("COPY");
      expect(init.headers.Destination).toBe(
        "http://nextcloud.test/remote.php/dav/files/alice/dest.txt"
      );
      expect(init.headers.Overwrite).toBe("F");
    });
  });

  describe("ncGetFileId", () => {
    it("parses the oc:fileid from a PROPFIND response", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 207,
          text: `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/doc.pdf</d:href>
    <d:propstat><d:prop><oc:fileid>42</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`,
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const id = await ncGetFileId("token", "alice", "/doc.pdf");

      expect(id).toBe(42);
      const init = fetchMock.mock.calls[0][1];
      expect(init.method).toBe("PROPFIND");
      expect(init.headers.Depth).toBe("0");
    });

    it("returns null on 404", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: false, status: 404 })) as unknown as typeof fetch;
      expect(await ncGetFileId("t", "u", "/missing")).toBeNull();
    });

    it("returns null when no fileid in body", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: "<d:multistatus/>" })) as unknown as typeof fetch;
      expect(await ncGetFileId("t", "u", "/doc.pdf")).toBeNull();
    });
  });
});

describe("nextcloud.client — trash", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const trashXml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/trashbin/alice/trash/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/trashbin/alice/trash/photo.jpg.d1712860391</d:href>
    <d:propstat>
      <d:prop>
        <d:getlastmodified>Mon, 01 Apr 2024 10:00:00 GMT</d:getlastmodified>
        <d:getcontentlength>123456</d:getcontentlength>
        <d:resourcetype/>
        <nc:trashbin-filename>photo.jpg</nc:trashbin-filename>
        <nc:trashbin-original-location>Photos/photo.jpg</nc:trashbin-original-location>
        <nc:trashbin-deletion-time>1712860391</nc:trashbin-deletion-time>
      </d:prop>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/trashbin/alice/trash/notes.txt.d1712950000</d:href>
    <d:propstat>
      <d:prop>
        <d:getlastmodified>Tue, 02 Apr 2024 11:00:00 GMT</d:getlastmodified>
        <d:getcontentlength>42</d:getcontentlength>
        <d:resourcetype/>
        <nc:trashbin-filename>notes.txt</nc:trashbin-filename>
        <nc:trashbin-original-location>notes.txt</nc:trashbin-original-location>
        <nc:trashbin-deletion-time>1712950000</nc:trashbin-deletion-time>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;

  describe("ncListTrash", () => {
    it("parses trash entries and sorts most-recent-first", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: trashXml }));
      global.fetch = fetchMock as unknown as typeof fetch;

      const items = await ncListTrash("token", "alice");

      expect(items).toHaveLength(2);
      // notes.txt deleted later (1712950000 > 1712860391)
      expect(items[0].name).toBe("notes.txt.d1712950000");
      expect(items[0].originalName).toBe("notes.txt");
      expect(items[0].originalLocation).toBe("/");
      expect(items[0].size).toBe(42);

      expect(items[1].name).toBe("photo.jpg.d1712860391");
      expect(items[1].originalName).toBe("photo.jpg");
      expect(items[1].originalLocation).toBe("/Photos");
      expect(items[1].size).toBe(123456);
      expect(items[1].isDirectory).toBe(false);
    });

    it("uses PROPFIND Depth: 1 against the trashbin endpoint", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: "<d:multistatus/>" }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncListTrash("token", "alice");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/remote.php/dav/trashbin/alice/trash");
      expect(init.method).toBe("PROPFIND");
      expect(init.headers.Depth).toBe("1");
    });

    it("returns empty array when trashbin returns 404", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: false, status: 404 })) as unknown as typeof fetch;
      expect(await ncListTrash("t", "u")).toEqual([]);
    });
  });

  describe("ncRestoreTrashItem", () => {
    it("MOVEs from trash/ to restore/", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 204 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncRestoreTrashItem("token", "alice", "photo.jpg.d1712860391");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "http://nextcloud.test/remote.php/dav/trashbin/alice/trash/photo.jpg.d1712860391"
      );
      expect(init.method).toBe("MOVE");
      expect(init.headers.Destination).toBe(
        "http://nextcloud.test/remote.php/dav/trashbin/alice/restore/photo.jpg.d1712860391"
      );
    });
  });

  describe("ncDeleteTrashItem", () => {
    it("issues DELETE against the trash item", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 204 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncDeleteTrashItem("token", "alice", "notes.txt.d1712950000");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("/trashbin/alice/trash/notes.txt.d1712950000");
      expect(init.method).toBe("DELETE");
    });
  });

  describe("ncEmptyTrash", () => {
    it("issues DELETE on the trashbin root", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 204 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncEmptyTrash("token", "alice");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/remote.php/dav/trashbin/alice/trash");
      expect(init.method).toBe("DELETE");
    });
  });
});

describe("nextcloud.client — versions", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const versionsXml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/versions/alice/versions/12345/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/versions/alice/versions/12345/1712860391</d:href>
    <d:propstat>
      <d:prop>
        <d:getlastmodified>Mon, 01 Apr 2024 10:00:00 GMT</d:getlastmodified>
        <d:getcontentlength>500</d:getcontentlength>
      </d:prop>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/versions/alice/versions/12345/1712870000</d:href>
    <d:propstat>
      <d:prop>
        <d:getlastmodified>Tue, 02 Apr 2024 11:00:00 GMT</d:getlastmodified>
        <d:getcontentlength>600</d:getcontentlength>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;

  describe("ncListVersions", () => {
    it("parses versions sorted most-recent first", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: versionsXml }));
      global.fetch = fetchMock as unknown as typeof fetch;

      const versions = await ncListVersions("token", "alice", 12345);

      expect(versions).toHaveLength(2);
      expect(versions[0].versionId).toBe("1712870000");
      expect(versions[0].size).toBe(600);
      expect(versions[1].versionId).toBe("1712860391");
      expect(versions[1].size).toBe(500);
    });

    it("targets the correct versions URL", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: "<d:multistatus/>" }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncListVersions("token", "alice", 999);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/remote.php/dav/versions/alice/versions/999");
      expect(init.method).toBe("PROPFIND");
      expect(init.headers.Depth).toBe("1");
    });

    it("returns [] when file has no version history (404)", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: false, status: 404 })) as unknown as typeof fetch;
      expect(await ncListVersions("t", "u", 1)).toEqual([]);
    });
  });

  describe("ncRestoreVersion", () => {
    it("MOVEs from the version URL to restore target", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 204 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncRestoreVersion("token", "alice", 12345, "1712860391");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "http://nextcloud.test/remote.php/dav/versions/alice/versions/12345/1712860391"
      );
      expect(init.method).toBe("MOVE");
      expect(init.headers.Destination).toBe(
        "http://nextcloud.test/remote.php/dav/versions/alice/restore/target"
      );
    });

    it("throws on non-success status", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: false, status: 500 })) as unknown as typeof fetch;
      await expect(ncRestoreVersion("t", "u", 1, "v")).rejects.toThrow(/Version restore failed/);
    });
  });
});

// ── Phase 2 ──

describe("nextcloud.client — favorites", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe("ncSetFavorite", () => {
    it("PROPPATCHes oc:favorite=1 when favoriting", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncSetFavorite("token", "alice", "/doc.pdf", true);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/remote.php/dav/files/alice/doc.pdf");
      expect(init.method).toBe("PROPPATCH");
      expect(init.body).toContain("<oc:favorite>1</oc:favorite>");
      expect(init.headers["Content-Type"]).toBe("application/xml");
    });

    it("PROPPATCHes oc:favorite=0 when unfavoriting", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncSetFavorite("token", "alice", "/doc.pdf", false);
      expect(fetchMock.mock.calls[0][1].body).toContain("<oc:favorite>0</oc:favorite>");
    });

    it("throws on non-207 status", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: false, status: 500 })) as unknown as typeof fetch;
      await expect(ncSetFavorite("t", "u", "/x", true)).rejects.toThrow(/PROPPATCH favorite failed/);
    });
  });

  describe("ncListFavorites", () => {
    it("issues REPORT with filter-files favorite=1 and parses results", async () => {
      const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/reports/q1.pdf</d:href>
    <d:propstat><d:prop>
      <d:getlastmodified>Mon, 01 Apr 2024 10:00:00 GMT</d:getlastmodified>
      <d:getcontentlength>1024</d:getcontentlength>
      <d:getcontenttype>application/pdf</d:getcontenttype>
      <d:resourcetype/>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`;
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: xml }));
      global.fetch = fetchMock as unknown as typeof fetch;

      const items = await ncListFavorites("token", "alice");

      expect(items).toHaveLength(1);
      expect(items[0].path).toBe("/reports/q1.pdf");
      expect(items[0].size).toBe(1024);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/remote.php/dav/files/alice/");
      expect(init.method).toBe("REPORT");
      expect(init.body).toContain("<oc:filter-rules>");
      expect(init.body).toContain("<oc:favorite>1</oc:favorite>");
    });

    it("returns [] on 404", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: false, status: 404 })) as unknown as typeof fetch;
      expect(await ncListFavorites("t", "u")).toEqual([]);
    });
  });
});

describe("nextcloud.client — search and recents", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const searchXml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/budget-2024.xlsx</d:href>
    <d:propstat><d:prop>
      <d:getlastmodified>Mon, 01 Apr 2024 10:00:00 GMT</d:getlastmodified>
      <d:getcontentlength>5000</d:getcontentlength>
      <d:getcontenttype>application/vnd.openxmlformats-officedocument.spreadsheetml.sheet</d:getcontenttype>
      <d:resourcetype/>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`;

  /**
   * The `<d:href>` SEARCH scope is a URL path embedded in an XML document, so a
   * username has to survive BOTH layers: percent-encoding first (it is one path
   * segment) and XML escaping second. `[user, expected encoded segment]`.
   */
  const scopeUserCases: Array<[string, string]> = [
    ["a&b", "a%26b"],
    ["a<b", "a%3Cb"],
    ["a>b", "a%3Eb"],
    ["bob smith", "bob%20smith"],
    ["tag#1", "tag%231"],
    ["100%done", "100%25done"],
  ];

  describe("ncSearchFiles", () => {
    it("issues SEARCH with basicsearch wrapping a LIKE pattern", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: searchXml }));
      global.fetch = fetchMock as unknown as typeof fetch;

      const items = await ncSearchFiles("token", "alice", { query: "budget" });

      expect(items).toHaveLength(1);
      expect(items[0].name).toBe("budget-2024.xlsx");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/remote.php/dav/");
      expect(init.method).toBe("SEARCH");
      expect(init.body).toContain("<d:basicsearch>");
      expect(init.body).toContain("<d:literal>%budget%</d:literal>");
      expect(init.body).toContain("<d:href>/files/alice</d:href>");
      expect(init.body).toContain("<d:nresults>50</d:nresults>");
    });

    it("escapes XML metacharacters in the query", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: "<d:multistatus/>" }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncSearchFiles("token", "alice", { query: "a<b>&c" });

      const body = fetchMock.mock.calls[0][1].body as string;
      expect(body).toContain("%a&lt;b&gt;&amp;c%");
      expect(body).not.toContain("<b>&c");
    });

    it("adds a mime filter when provided", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: "<d:multistatus/>" }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncSearchFiles("token", "alice", { query: "q", mime: "application/pdf" });

      const body = fetchMock.mock.calls[0][1].body as string;
      expect(body).toContain("<d:and>");
      expect(body).toContain("application/pdf");
    });

    it("honours custom limits", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: "<d:multistatus/>" }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncSearchFiles("token", "alice", { query: "q", limit: 5 });

      expect(fetchMock.mock.calls[0][1].body).toContain("<d:nresults>5</d:nresults>");
    });

    it.each(scopeUserCases)(
      "percent-encodes then XML-escapes the username %j in the search scope href",
      async (user, encoded) => {
        const fetchMock = vi
          .fn()
          .mockResolvedValue(mockResponse({ ok: true, status: 207, text: "<d:multistatus/>" }));
        global.fetch = fetchMock as unknown as typeof fetch;

        await ncSearchFiles("token", user, { query: "q" });

        const body = fetchMock.mock.calls[0][1].body as string;
        expect(body).toContain(`<d:href>/files/${encoded}</d:href>`);
        // The raw username must never reach the document — that is either an
        // XML injection (`&`, `<`, `>`) or a wrong-scope address (` `, `#`, `%`).
        expect(body).not.toContain(`/files/${user}`);
        // Encode-then-escape, not escape-then-encode: the latter yields `%26amp%3B`.
        expect(body).not.toContain("amp%3B");
      }
    );
  });

  describe("ncListRecents", () => {
    it("issues SEARCH with orderby lastmodified DESC", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: "<d:multistatus/>" }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncListRecents("token", "alice", 30);

      const init = fetchMock.mock.calls[0][1];
      expect(init.method).toBe("SEARCH");
      expect(init.body).toContain("<d:descending/>");
      expect(init.body).toContain("<d:nresults>30</d:nresults>");
    });

    it("sorts returned entries most-recent first regardless of parseMultiStatus ordering", async () => {
      const mixedXml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/older.txt</d:href>
    <d:propstat><d:prop>
      <d:getlastmodified>Mon, 01 Apr 2024 10:00:00 GMT</d:getlastmodified>
      <d:getcontentlength>10</d:getcontentlength>
      <d:getcontenttype>text/plain</d:getcontenttype>
      <d:resourcetype/>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/newer.txt</d:href>
    <d:propstat><d:prop>
      <d:getlastmodified>Fri, 05 Apr 2024 10:00:00 GMT</d:getlastmodified>
      <d:getcontentlength>10</d:getcontentlength>
      <d:getcontenttype>text/plain</d:getcontenttype>
      <d:resourcetype/>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`;
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: mixedXml })) as unknown as typeof fetch;

      const items = await ncListRecents("token", "alice", 10);

      expect(items[0].name).toBe("newer.txt");
      expect(items[1].name).toBe("older.txt");
    });

    it.each(scopeUserCases)(
      "percent-encodes then XML-escapes the username %j in the recents scope href",
      async (user, encoded) => {
        const fetchMock = vi
          .fn()
          .mockResolvedValue(mockResponse({ ok: true, status: 207, text: "<d:multistatus/>" }));
        global.fetch = fetchMock as unknown as typeof fetch;

        await ncListRecents("token", user, 10);

        const body = fetchMock.mock.calls[0][1].body as string;
        expect(body).toContain(`<d:href>/files/${encoded}</d:href>`);
        expect(body).not.toContain(`/files/${user}`);
        expect(body).not.toContain("amp%3B");
      }
    );
  });
});

describe("nextcloud.client — thumbnails", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe("ncFetchThumbnail", () => {
    it("GETs core/preview with the given dimensions and returns body + content type", async () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: vi.fn().mockResolvedValue(pngBytes),
        headers: new Headers({ "content-type": "image/png" }),
      } as unknown as Response);
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await ncFetchThumbnail("token", 42, 512, 512);

      expect(result).not.toBeNull();
      expect(result!.contentType).toBe("image/png");
      expect(result!.body.byteLength).toBe(4);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "http://nextcloud.test/index.php/core/preview?fileId=42&x=512&y=512&a=1&forceIcon=0"
      );
    });

    it("returns null on 404", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue({
          ok: false,
          status: 404,
          arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
          headers: new Headers(),
        } as unknown as Response) as unknown as typeof fetch;
      expect(await ncFetchThumbnail("t", 1)).toBeNull();
    });
  });
});

describe("nextcloud.client — shares v2", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const shareRecord = {
    id: "7",
    share_type: 3,
    permissions: 1,
    path: "/report.pdf",
    file_target: "/report.pdf",
    url: "http://nextcloud.test/s/abc",
    token: "abc",
    expiration: "2026-12-31",
    password: "hashed",
    note: "please review",
    share_with: null,
    uid_owner: "alice",
    displayname_owner: "Alice",
    stime: 1712860391,
  };

  describe("ncCreateShareV2", () => {
    it("POSTs to OCS shares with the full option set", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { status: "ok" }, data: shareRecord } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const share = await ncCreateShareV2("token", "/report.pdf", {
        shareType: 3,
        permissions: 1,
        expireDate: "2026-12-31",
        password: "s3cret",
        note: "please review",
      });

      expect(share.id).toBe(7);
      expect(share.url).toBe("http://nextcloud.test/s/abc");
      expect(share.expireDate).toBe("2026-12-31");
      expect(share.hasPassword).toBe(true);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/ocs/v2.php/apps/files_sharing/api/v1/shares");
      expect(init.method).toBe("POST");
      const body = (init.body as URLSearchParams).toString();
      expect(body).toContain("path=%2Freport.pdf");
      expect(body).toContain("shareType=3");
      expect(body).toContain("permissions=1");
      expect(body).toContain("expireDate=2026-12-31");
      expect(body).toContain("password=s3cret");
    });

    it("throws NextcloudOcsError on OCS failure in body (2xx HTTP but failure meta)", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { status: "failure", statuscode: 404, message: "Nope" }, data: [] } },
        })
      ) as unknown as typeof fetch;

      await expect(
        ncCreateShareV2("t", "/x", { shareType: 3 })
      ).rejects.toThrow(/OCS share create: Nope/);
    });

    it("surfaces the OCS message when HTTP 400 is returned (password policy)", async () => {
      // Mimics Nextcloud rejecting a password that's in the compromised list.
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
        text: vi.fn().mockResolvedValue(""),
        json: vi.fn().mockResolvedValue({
          ocs: {
            meta: {
              status: "failure",
              statuscode: 400,
              message: "Password is present in compromised password list. Please choose a different password.",
            },
            data: [],
          },
        }),
      } as unknown as Response);
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        ncCreateShareV2("t", "/report.pdf", { shareType: 3, password: "pwned" })
      ).rejects.toThrow(/compromised password list/);
    });
  });

  describe("ncUpdateShare", () => {
    it("PUTs a single field via OCS and parses ok status", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { status: "ok" }, data: shareRecord } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncUpdateShare("token", 7, "password", "new-pwd");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/ocs/v2.php/apps/files_sharing/api/v1/shares/7");
      expect(init.method).toBe("PUT");
      expect((init.body as URLSearchParams).toString()).toBe("password=new-pwd");
    });

    it("throws on OCS non-ok with the server's error message", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { status: "failure", statuscode: 400, message: "Bad" }, data: [] } },
        })
      ) as unknown as typeof fetch;

      await expect(
        ncUpdateShare("t", 1, "permissions", "3")
      ).rejects.toThrow(/OCS share update/);
    });
  });

  describe("ncDeleteShare", () => {
    it("DELETEs the share id", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 200 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncDeleteShare("token", 7);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/ocs/v2.php/apps/files_sharing/api/v1/shares/7");
      expect(init.method).toBe("DELETE");
    });
  });

  describe("ncListSharedWithMe", () => {
    it("GETs the shared_with_me endpoint and maps records", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: {
            ocs: {
              meta: { status: "ok" },
              data: [
                { ...shareRecord, id: "10", uid_owner: "bob", displayname_owner: "Bob" },
                { ...shareRecord, id: "11", uid_owner: "carol", displayname_owner: "Carol" },
              ],
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const shares = await ncListSharedWithMe("token");

      expect(shares).toHaveLength(2);
      expect(shares[0].uidOwner).toBe("bob");
      expect(shares[0].ownerDisplayName).toBe("Bob");
      expect(shares[1].uidOwner).toBe("carol");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "http://nextcloud.test/ocs/v2.php/apps/files_sharing/api/v1/shares?shared_with_me=true"
      );
    });

    it("returns [] when OCS returns empty array", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { status: "ok" }, data: [] } },
        })
      ) as unknown as typeof fetch;

      expect(await ncListSharedWithMe("t")).toEqual([]);
    });
  });

  // WARP-941 — outbound listing for the dashboard's "Shared by me" tab.
  describe("ncListOutboundShares", () => {
    it("GETs the OCS shares endpoint WITHOUT a path filter, initiator-only (no reshares/subfiles)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: {
            ocs: {
              meta: { status: "ok" },
              data: [
                {
                  ...shareRecord,
                  id: "21",
                  share_type: 0,
                  share_with: "romain",
                  share_with_displayname: "Romain",
                },
                { ...shareRecord, id: "22" },
              ],
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const shares = await ncListOutboundShares("token");

      expect(shares).toHaveLength(2);
      expect(shares[0].id).toBe(21);
      expect(shares[0].shareType).toBe(0);
      expect(shares[0].shareWith).toBe("romain");
      expect(shares[0].shareWithDisplayName).toBe("Romain");
      expect(shares[1].shareType).toBe(3);

      const [url] = fetchMock.mock.calls[0];
      // Initiator-only: NO path filter (Nextcloud then scopes to shares this
      // user CREATED — uid_initiator), and none of the broadening/inbound
      // params. `reshares` would widen getSharesBy to files the user merely
      // OWNS but did not create; `subfiles` is a no-op without a folder `path`.
      // Both are dropped so the "Shared by me" tab means "shares I created".
      expect(url).toBe(
        "http://nextcloud.test/ocs/v2.php/apps/files_sharing/api/v1/shares"
      );
      expect(url).not.toContain("path=");
      expect(url).not.toContain("shared_with_me");
      expect(url).not.toContain("reshares");
      expect(url).not.toContain("subfiles");
    });

    it("returns [] when OCS returns empty array", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { status: "ok" }, data: [] } },
        })
      ) as unknown as typeof fetch;

      expect(await ncListOutboundShares("t")).toEqual([]);
    });

    it("throws with the status on a non-ok HTTP response", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 503 })
      ) as unknown as typeof fetch;

      await expect(ncListOutboundShares("t")).rejects.toThrow(
        /OCS list outbound shares failed: 503/
      );
    });
  });
});

describe("nextcloud.client — ncEnsureGroup (WARP-989)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("POSTs the group to the OCS groups endpoint with admin basic auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({ ocs: { meta: { statuscode: 100 } } }),
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await ncEnsureGroup("household");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://nextcloud.test/ocs/v1.php/cloud/groups?format=json");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.headers["OCS-APIRequest"]).toBe("true");
    expect(String(init.body)).toBe("groupid=household");
  });

  it("treats OCS 102 (group already exists) as success — the ensure is idempotent", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({
          ocs: { meta: { statuscode: 102, message: "group exists" } },
        }),
      })
    ) as unknown as typeof fetch;

    await expect(ncEnsureGroup("household")).resolves.toBeUndefined();
  });

  it("throws on any other non-100 OCS status so callers can decide fatality", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({
          ocs: { meta: { statuscode: 101, message: "invalid input" } },
        }),
      })
    ) as unknown as typeof fetch;

    await expect(ncEnsureGroup("household")).rejects.toThrow(
      /OCS error creating group: invalid input/
    );
  });

  it("throws on a non-JSON (HTML) response instead of silently passing", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, text: "<html>setup</html>" })
    ) as unknown as typeof fetch;

    await expect(ncEnsureGroup("household")).rejects.toThrow(/invalid response/);
  });
});

/**
 * WARP-1682 — DELETE is idempotent (RFC 9110 §9.2.2): the caller asks for an
 * end state ("this path must not exist"), not for a state transition. A 404
 * means that end state already holds, so it is a SUCCESS, not a failure.
 *
 * Treating it as a failure is what produced the reported symptom — an error
 * toast over a file that really was deleted. The resource genuinely can be
 * gone by the time our DELETE lands: a retry, a second tab, the file indexer,
 * or the trashbin race that `runBulk` in routes/files.ts:2404 documents
 * ("one of the requests can 500 while the file ends up half-moved").
 *
 * The outcome is still reported back so callers can tell the two apart for
 * logging without either being an error.
 */
describe("nextcloud.client — ncDeleteFile idempotence (WARP-1682)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("issues DELETE at the WebDAV path and reports 'deleted' on 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(ncDeleteFile("tok", "alice", "/docs/report.pdf")).resolves.toBe("deleted");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://nextcloud.test/remote.php/dav/files/alice/docs/report.pdf");
    expect(init.method).toBe("DELETE");
  });

  it("reports 'already-absent' on 404 instead of throwing", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: false, status: 404 })) as unknown as typeof fetch;

    await expect(ncDeleteFile("tok", "alice", "/docs/gone.pdf")).resolves.toBe("already-absent");
  });

  it("still throws on 423 Locked — the file is NOT gone and the caller must hear about it", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: false, status: 423 })) as unknown as typeof fetch;

    await expect(ncDeleteFile("tok", "alice", "/docs/locked.pdf")).rejects.toThrow(
      /WebDAV DELETE failed: 423/,
    );
  });

  it("still throws on 403 Forbidden", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: false, status: 403 })) as unknown as typeof fetch;

    await expect(ncDeleteFile("tok", "alice", "/docs/nope.pdf")).rejects.toThrow(
      /WebDAV DELETE failed: 403/,
    );
  });

  it("still throws on 500 — the trashbin race leaves the outcome unknown, so it is not success", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: false, status: 500 })) as unknown as typeof fetch;

    await expect(ncDeleteFile("tok", "alice", "/docs/racy.pdf")).rejects.toThrow(
      /WebDAV DELETE failed: 500/,
    );
  });
});

// ── WebDAV URL percent-encoding ──

describe("nextcloud.client — WebDAV URL percent-encoding", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const DAV = "http://nextcloud.test/remote.php/dav/files";

  /**
   * Characters that change which resource a URL addresses when interpolated
   * raw: `#` truncates at the fragment, `?` starts a query string, a bare `%`
   * is an invalid escape, `+` may decode to a space, `&` and space are simply
   * not path-legal. Non-ASCII must be UTF-8 percent-encoded.
   */
  const NASTY: Array<[label: string, name: string, encoded: string]> = [
    ["a space", "my report.txt", "my%20report.txt"],
    ["a hash", "note#1.txt", "note%231.txt"],
    ["a question mark", "what?.txt", "what%3F.txt"],
    ["a percent", "100%.txt", "100%25.txt"],
    ["a plus", "a+b.txt", "a%2Bb.txt"],
    ["an ampersand", "r&d.txt", "r%26d.txt"],
    ["a non-ASCII char", "résumé.txt", "r%C3%A9sum%C3%A9.txt"],
  ];

  function okFetch(status = 204, text = "<d:multistatus/>") {
    const mock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status, text }));
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  describe("ncDeleteFile", () => {
    for (const [label, name, encoded] of NASTY) {
      it(`encodes ${label} in the DELETE target`, async () => {
        const fetchMock = okFetch(204);
        await ncDeleteFile("token", "alice", `/docs/${name}`);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${DAV}/alice/docs/${encoded}`);
        expect(init.method).toBe("DELETE");
      });
    }
  });

  describe("ncDownloadFile", () => {
    for (const [label, name, encoded] of NASTY) {
      it(`encodes ${label} in the GET target`, async () => {
        const fetchMock = okFetch(200);
        await ncDownloadFile("token", "alice", `/docs/${name}`);
        expect(fetchMock.mock.calls[0][0]).toBe(`${DAV}/alice/docs/${encoded}`);
      });
    }
  });

  describe("ncUploadFile", () => {
    for (const [label, name, encoded] of NASTY) {
      it(`encodes ${label} in the PUT target`, async () => {
        const fetchMock = okFetch(201);
        await ncUploadFile("token", "alice", "/docs", name, Buffer.from("x"));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${DAV}/alice/docs/${encoded}`);
        expect(init.method).toBe("PUT");
      });
    }
  });

  describe("ncListFiles", () => {
    for (const [label, name, encoded] of NASTY) {
      it(`encodes ${label} in the PROPFIND target`, async () => {
        const fetchMock = okFetch(207);
        await ncListFiles("token", "alice", `/${name}`);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${DAV}/alice/${encoded}`);
        expect(init.method).toBe("PROPFIND");
      });
    }
  });

  describe("ncCreateDirectory", () => {
    it("encodes every segment of a nested MKCOL path", async () => {
      const fetchMock = okFetch(201);
      await ncCreateDirectory("token", "alice", "/R&D/Q1 2026/100% done");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${DAV}/alice/R%26D/Q1%202026/100%25%20done`);
      expect(init.method).toBe("MKCOL");
    });
  });

  describe("ncMoveFile", () => {
    it("encodes both the request URL and the Destination header", async () => {
      const fetchMock = okFetch(201);
      await ncMoveFile("token", "alice", "/a/old #1.txt", "/b/new ?2.txt");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${DAV}/alice/a/old%20%231.txt`);
      expect(init.headers.Destination).toBe(`${DAV}/alice/b/new%20%3F2.txt`);
    });
  });

  describe("ncSetFavorite", () => {
    it("encodes the PROPPATCH target", async () => {
      const fetchMock = okFetch(207);
      await ncSetFavorite("token", "alice", "/notes/todo #3.md", true);
      expect(fetchMock.mock.calls[0][0]).toBe(`${DAV}/alice/notes/todo%20%233.md`);
    });
  });

  describe("path/user structure", () => {
    it("preserves `/` as the segment separator", async () => {
      const fetchMock = okFetch(204);
      await ncDeleteFile("token", "alice", "/a/b/c.txt");
      expect(fetchMock.mock.calls[0][0]).toBe(`${DAV}/alice/a/b/c.txt`);
    });

    it("strips leading slashes before encoding", async () => {
      const fetchMock = okFetch(204);
      await ncDeleteFile("token", "alice", "///a b.txt");
      expect(fetchMock.mock.calls[0][0]).toBe(`${DAV}/alice/a%20b.txt`);
    });

    it("encodes the user component", async () => {
      const fetchMock = okFetch(204);
      await ncDeleteFile("token", "a b#c", "/x.txt");
      expect(fetchMock.mock.calls[0][0]).toBe(`${DAV}/a%20b%23c/x.txt`);
    });

    it("keeps the REPORT root URL for ncListFavorites unchanged", async () => {
      const fetchMock = okFetch(207);
      await ncListFavorites("token", "alice");
      expect(fetchMock.mock.calls[0][0]).toBe(`${DAV}/alice/`);
    });

    it("does not double-encode a path that already contains a literal percent", async () => {
      // "%23" as literal filename text must become "%2523", not stay "%23".
      const fetchMock = okFetch(204);
      await ncDeleteFile("token", "alice", "/%23literal.txt");
      expect(fetchMock.mock.calls[0][0]).toBe(`${DAV}/alice/%2523literal.txt`);
    });
  });

  describe("PROPFIND href decoding", () => {
    it("decodes percent-encoded hrefs back into raw names and paths", async () => {
      const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/docs/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/docs/r%C3%A9sum%C3%A9%20%231%20100%25.txt</d:href>
    <d:propstat><d:prop>
      <d:getlastmodified>Mon, 01 Apr 2024 10:00:00 GMT</d:getlastmodified>
      <d:getcontentlength>7</d:getcontentlength>
      <d:getcontenttype>text/plain</d:getcontenttype>
      <d:resourcetype/>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`;
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: true, status: 207, text: xml })) as unknown as typeof fetch;

      const entries = await ncListFiles("token", "alice", "/docs");

      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("résumé #1 100%.txt");
      expect(entries[0].path).toBe("/docs/résumé #1 100%.txt");
    });
  });
});

/**
 * WARP-1688 — richdocuments DIRECT-EDITING token.
 *
 * The dashboard's embedded editor iframes a Nextcloud page from the DASHBOARD's
 * origin, where the user has no Nextcloud session cookie — so the connector page
 * (`/index.php/apps/richdocuments/index?fileId=…`) bounces to NC's login. The
 * richdocuments app ships a session-free path for exactly this: OCS
 * `POST /ocs/v2.php/apps/richdocuments/api/v1/document` with a `fileId` mints a
 * one-shot direct-editing token, and `GET /direct/{token}` renders the real
 * editor with NO cookies and NO auth.
 *
 * Verified against the live connector (richdocuments appinfo/routes.php:
 * `OCS#createDirect` = POST /api/v1/document; `directView#show` = GET
 * /direct/{token}); the minting call is made AS THE USER (their app-password
 * token), so the resulting token carries that user's permissions.
 */
describe("nextcloud.client — ncCreateRichdocumentsDirectUrl (WARP-1688)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("POSTs fileId to the richdocuments OCS endpoint with the OCS headers and the caller's token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: {
          ocs: {
            meta: { status: "ok", statuscode: 200 },
            data: { url: "http://localhost/index.php/apps/richdocuments/direct/abc123" },
          },
        },
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const url = await ncCreateRichdocumentsDirectUrl("token123", 4242);

    expect(url).toBe("http://localhost/index.php/apps/richdocuments/direct/abc123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(
      "http://nextcloud.test/ocs/v2.php/apps/richdocuments/api/v1/document"
    );
    expect(init.method).toBe("POST");
    // As the USER — never the admin basic credential: the direct token
    // inherits the minting account's permissions.
    expect(init.headers.Authorization).toBe("Bearer token123");
    expect(init.headers["OCS-APIRequest"]).toBe("true");
    expect(init.headers.Accept).toBe("application/json");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(String(init.body)).toBe("fileId=4242");
  });

  it("returns null on a non-2xx OCS response (caller falls back, never 500s)", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: false, status: 403 })) as unknown as typeof fetch;

    await expect(ncCreateRichdocumentsDirectUrl("t", 1)).resolves.toBeNull();
  });

  it("returns null when the OCS envelope carries no data.url", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: { ocs: { meta: { statuscode: 200 } } } })
    ) as unknown as typeof fetch;

    await expect(ncCreateRichdocumentsDirectUrl("t", 1)).resolves.toBeNull();
  });

  it("returns null (never throws) when the response is not JSON", async () => {
    const resp = mockResponse({ ok: true, status: 200 });
    (resp.json as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SyntaxError("Unexpected token <")
    );
    global.fetch = vi.fn().mockResolvedValue(resp) as unknown as typeof fetch;

    await expect(ncCreateRichdocumentsDirectUrl("t", 1)).resolves.toBeNull();
  });

  it("returns null (never throws) when the fetch itself rejects", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    await expect(ncCreateRichdocumentsDirectUrl("t", 1)).resolves.toBeNull();
  });

  /**
   * WARP-1688 (QA finding) — "degrade instead of 500" holds for a FAILING
   * Nextcloud but not for a HUNG one: a bare fetch with no timeout leaves the
   * whole editor-session request stalled behind it, which is worse for the user
   * than the connector-page fallback this function exists to enable. Bound it,
   * and let the abort land on the same fallback path as any other failure.
   */
  it("sends an AbortSignal so the mint can be bounded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: { ocs: { data: { url: "http://localhost/x" } } },
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await ncCreateRichdocumentsDirectUrl("t", 1);

    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  it("degrades to null when Nextcloud HANGS — the request is aborted, not awaited forever", async () => {
    vi.useFakeTimers();
    try {
      // A Nextcloud that accepts the connection and then never answers. The
      // ONLY thing that can end this promise is our own abort.
      const fetchMock = vi.fn(
        (_url: unknown, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const pending = ncCreateRichdocumentsDirectUrl("t", 1);
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout on the success path (no dangling timer per mint)", async () => {
    vi.useFakeTimers();
    try {
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { data: { url: "http://localhost/x" } } },
        })
      ) as unknown as typeof fetch;

      await ncCreateRichdocumentsDirectUrl("t", 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
