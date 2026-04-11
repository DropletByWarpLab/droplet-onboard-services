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
  },
}));

import {
  ncMoveFile,
  ncCopyFile,
  ncGetFileId,
  ncListTrash,
  ncRestoreTrashItem,
  ncDeleteTrashItem,
  ncEmptyTrash,
  ncListVersions,
  ncRestoreVersion,
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
