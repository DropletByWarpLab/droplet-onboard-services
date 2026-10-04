/**
 * WARP-3538 — `search_cloud_files`: the calling person's own connected cloud
 * files (today OneDrive and SharePoint), found by name, location or modified
 * date.
 *
 * Like the calendar and reminder tools (WARP-3101) it reads THROUGH THE
 * ORCHESTRATOR (`GET /api/cloud-files`), never `ctx.prisma`: the rows are
 * per-person, their names are ciphertext at rest, and only the orchestrator
 * holds the key. `orchestratorCtx` makes `ctx.prisma` throw on any touch, so a
 * handler that reads the table itself fails loudly instead of passing on a stub.
 *
 * What these pin:
 *   - 🔴 whose files: the person is the transport's (the mcp-server stamps
 *     X-Nextcloud-User on every orchestrator call), never an argument. No
 *     identity parameter exists, and a model-supplied one reaches nothing.
 *   - the wire: one GET, the route's own parameter names, the full ISO date,
 *     and the one place the tool's word and the route's differ (`location` is
 *     the route's `source`);
 *   - the result: a whitelist of the route's fields, so a field the route one
 *     day adds (a download link, content) cannot reach the model unreviewed;
 *   - every refusal and failure is an error — never an empty list, which the
 *     model would read as "you have no such file".
 */
import { describe, it, expect } from "vitest";
import searchCloudFiles from "../../../src/handlers/files/search-cloud-files.js";
import { json, orchestratorCtx, queryOf } from "../../helpers/orchestrator-ctx.js";
import { expectErr, expectOk } from "../../helpers/tool-result.js";

/** A row as `GET /api/cloud-files` sends it. */
const LEASE = {
  name: "Signed lease agreement.pdf",
  isFolder: false,
  provider: "m365",
  location: "Front Desk › Documents",
  path: "Contracts/2026",
  webUrl: "https://contoso.example/sites/frontdesk/Shared%20Documents/Contracts/2026/lease.pdf",
  lastModifiedAt: "2026-09-30T14:03:00.000Z",
  lastModifiedBy: "Dana Whitfield",
  sizeBytes: 482113,
};

const FOLDER = {
  name: "Contracts",
  isFolder: true,
  provider: "m365",
  location: "OneDrive",
  path: null,
  webUrl: "https://contoso.example/personal/sam/Documents/Contracts",
  lastModifiedAt: "2026-09-01T08:00:00.000Z",
  lastModifiedBy: null,
  sizeBytes: null,
};

type Data = { type: string; count: number; limit: number; files: Array<Record<string, unknown>> };
const dataOf = (r: Parameters<typeof expectOk>[0]) => expectOk(r).data as Data;

describe("search_cloud_files", () => {
  it("requires auth, and makes no hop without it", async () => {
    // MUTATION: delete the `ctx.userId` guard in the handler and this goes red.
    const o = orchestratorCtx("");
    const r = expectErr(await searchCloudFiles.handler({ query: "lease" }, o.ctx));
    expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(o.get).not.toHaveBeenCalled();
  });

  it("🔴 searches the acting person's files through the orchestrator — one GET, no identity of its own", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { items: [LEASE] }));
    await searchCloudFiles.handler({ query: "lease" }, o.ctx);

    expect(o.get).toHaveBeenCalledTimes(1);
    const [path, opts] = o.get.mock.calls[0]!;
    expect(path.split("?")[0]).toBe("/api/cloud-files");
    // Exactly the Accept header and nothing else. The acting person is stamped
    // onto every orchestrator call by the mcp-server (context.ts
    // `withActingUser`); a handler that sent its own X-Nextcloud-User would
    // WIN over that stamp (the caller's headers are merged last), which is the
    // way a tool could end up reading somebody else's files.
    expect(opts).toEqual({ headers: { Accept: "application/json" } });
    // Never through prisma; no write verb.
    expect(o.post).not.toHaveBeenCalled();
    expect(o.patch).not.toHaveBeenCalled();
    expect(o.delete).not.toHaveBeenCalled();
  });

  it("🔴 forwards no identity a model supplies — the schema has none and extras reach nothing", async () => {
    // MUTATION: copy any of these keys onto the query string (or into a
    // header) and this goes red. Whose files these are is the transport's
    // decision, never an argument.
    const o = orchestratorCtx("alice");
    o.get.mockResolvedValueOnce(json(200, { items: [] }));
    await searchCloudFiles.handler(
      {
        query: "lease",
        userId: "bob",
        user_id: "bob",
        user: "bob",
        username: "bob",
        owner: "bob",
        account: "bob@contoso.example",
        // The pre-D13 spellings a model may still carry in its head: a drive
        // or site is not a thing this tool takes, so naming one reaches nothing.
        site: "bob's site",
        library: "bob's library",
        drive: "b!bobs-drive",
        sourceId: "b!bobs-drive",
        headers: { "X-Nextcloud-User": "bob" },
      },
      o.ctx,
    );
    const [path, opts] = o.get.mock.calls[0]!;
    expect(queryOf(path)).toEqual({ q: "lease", limit: "25" });
    expect(opts).toEqual({ headers: { Accept: "application/json" } });
    expect(path).not.toMatch(/bob/i);

    const props = Object.keys((searchCloudFiles.inputSchema as { properties: object }).properties);
    expect(props.filter((p) => /user|owner|account|person|tenant|drive|site|source|id$/i.test(p))).toEqual([]);
  });

  it("threads every filter under the route's own parameter names — `location` is the route's `source` — the date as a full ISO timestamp", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { items: [LEASE] }));
    const r = await searchCloudFiles.handler(
      { query: "  lease ", location: " Front Desk ", provider: "m365", modified_since: "2026-08-01", limit: 5 },
      o.ctx,
    );
    expect(queryOf(o.get.mock.calls[0]![0])).toEqual({
      q: "lease",
      source: "Front Desk",
      provider: "m365",
      modifiedSince: "2026-08-01T00:00:00.000Z",
      limit: "5",
    });
    expect(dataOf(r).limit).toBe(5);
  });

  it("asks for no filter it was not given, and defaults the limit to 25 on the wire", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { items: [] }));
    const r = await searchCloudFiles.handler({}, o.ctx);
    // No `provider` either: every connected drive is searched together, and
    // each result's `location` and `provider` say which it came from.
    expect(queryOf(o.get.mock.calls[0]![0])).toEqual({ limit: "25" });
    expect(dataOf(r).limit).toBe(25);
  });

  it("treats a blank or null filter as absent — a model fills unused arguments with empty strings", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { items: [] }));
    await searchCloudFiles.handler(
      { query: "   ", location: "", provider: "  ", modified_since: "", limit: undefined },
      o.ctx,
    );
    expect(queryOf(o.get.mock.calls[0]![0])).toEqual({ limit: "25" });

    const nulls = orchestratorCtx();
    nulls.get.mockResolvedValueOnce(json(200, { items: [] }));
    await searchCloudFiles.handler({ query: null, location: null, provider: null, modified_since: null, limit: null }, nulls.ctx);
    expect(queryOf(nulls.get.mock.calls[0]![0])).toEqual({ limit: "25" });
  });

  it("accepts the provider in any letter case, and sends it lower-case", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { items: [] }));
    await searchCloudFiles.handler({ provider: " M365 " }, o.ctx);
    expect(queryOf(o.get.mock.calls[0]![0]).provider).toBe("m365");
  });

  it("rejects arguments it cannot use, without a hop", async () => {
    const o = orchestratorCtx();
    for (const args of [
      { query: 42 },
      { query: "x".repeat(201) },
      { location: ["Front Desk"] },
      { location: "s".repeat(201) },
      // A provider that does not exist (yet) is refused here, not sent to be
      // refused by the route: the model is told what the valid value is.
      { provider: "dropbox" },
      { provider: "onedrive" },
      { provider: 365 },
      { provider: {} },
      { modified_since: "garbage" },
      { modified_since: 20260801 },
      { limit: 0 },
      { limit: 101 },
      { limit: 2.5 },
      { limit: "ten" },
    ]) {
      const r = expectErr(await searchCloudFiles.handler(args, o.ctx));
      expect(r.error.code, JSON.stringify(args)).toBe("INVALID_ARGS");
    }
    expect(o.get).not.toHaveBeenCalled();
  });

  it("names the providers that exist when it refuses one", async () => {
    const o = orchestratorCtx();
    const r = expectErr(await searchCloudFiles.handler({ provider: "dropbox" }, o.ctx));
    expect(r.error.message).toBe("provider must be one of: m365");
  });

  it("returns the whitelisted fields in the tool's own spelling, dates normalised", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { items: [LEASE, FOLDER] }));
    const data = dataOf(await searchCloudFiles.handler({ query: "contracts" }, o.ctx));

    expect(data.type).toBe("search_cloud_files");
    expect(data.count).toBe(2);
    expect(data.files[0]).toEqual({
      name: "Signed lease agreement.pdf",
      is_folder: false,
      provider: "m365",
      location: "Front Desk › Documents",
      path: "Contracts/2026",
      web_url: LEASE.webUrl,
      modified_at: "2026-09-30T14:03:00.000Z",
      modified_by: "Dana Whitfield",
      size_bytes: 482113,
    });
    expect(data.files[1]).toEqual({
      name: "Contracts",
      is_folder: true,
      provider: "m365",
      location: "OneDrive",
      path: null,
      web_url: FOLDER.webUrl,
      modified_at: "2026-09-01T08:00:00.000Z",
      modified_by: null,
      size_bytes: null,
    });
  });

  it("🔴 never passes on a field the tool did not name — no download link, no content", async () => {
    // The tool's promise is names, places, links and dates: "never file
    // contents". A route that later adds `downloadUrl`, `content`, a token or
    // another person's id must not reach the model through this tool by
    // accident. MUTATION: spread the row (`...r`) instead of naming its
    // fields and this goes red.
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(
      json(200, {
        items: [
          {
            ...LEASE,
            downloadUrl: "https://download.example/abc",
            "@microsoft.graph.downloadUrl": "https://download.example/def",
            content: "PATIENT: J. Smith, DOB 1970-01-01",
            sourceId: "b!secret-drive",
            externalId: "01ABCDEF",
            userId: "u-123",
            nameEnc: "dcv1:abcdef",
          },
        ],
      }),
    );
    const data = dataOf(await searchCloudFiles.handler({}, o.ctx));
    expect(Object.keys(data.files[0]!).sort()).toEqual([
      "is_folder",
      "location",
      "modified_at",
      "modified_by",
      "name",
      "path",
      "provider",
      "size_bytes",
      "web_url",
    ]);
    expect(JSON.stringify(data)).not.toMatch(/download|PATIENT|b!secret|01ABCDEF|u-123|dcv1/);
  });

  it("a provider the route sends that is not text is null, not passed through", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { items: [{ ...LEASE, provider: { x: 1 } }, { ...LEASE, provider: undefined }] }));
    const data = dataOf(await searchCloudFiles.handler({}, o.ctx));
    expect(data.files.map((f) => f.provider)).toEqual([null, null]);
  });

  it("reads a size sent as a number, tolerates the decimal string a BigInt becomes, and drops anything that is not a whole number of bytes", async () => {
    // The route sends `sizeBytes` as a JSON number — a BigInt column read with
    // Number(), exact below 2^53 (a file of 8 PiB does not exist). The decimal
    // string is accepted too, so a route that forgets the conversion degrades
    // to a correct size and not to a silent null.
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(
      json(200, {
        items: [
          { ...LEASE, name: "a", sizeBytes: "1048576" },
          { ...LEASE, name: "b", sizeBytes: "not-a-size" },
          { ...LEASE, name: "c", sizeBytes: -5 },
          { ...LEASE, name: "d", sizeBytes: 0 },
          { ...LEASE, name: "e", sizeBytes: 1048576 },
          { ...LEASE, name: "f", sizeBytes: 2 ** 53 },
          { ...LEASE, name: "g", sizeBytes: 1.5 },
        ],
      }),
    );
    const data = dataOf(await searchCloudFiles.handler({}, o.ctx));
    expect(data.files.map((f) => f.size_bytes)).toEqual([1048576, null, null, 0, 1048576, null, null]);
  });

  it("a date it cannot read is null, not a thrown RangeError or an Invalid Date string", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { items: [{ ...LEASE, lastModifiedAt: "not-a-date" }] }));
    const data = dataOf(await searchCloudFiles.handler({}, o.ctx));
    expect(data.files[0]!.modified_at).toBeNull();
  });

  it("never returns more than was asked for, whatever the route sends", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(
      json(200, { items: Array.from({ length: 30 }, (_v, i) => ({ ...LEASE, name: `f${i}` })) }),
    );
    const data = dataOf(await searchCloudFiles.handler({ limit: 10 }, o.ctx));
    expect(data.count).toBe(10);
    expect(data.files.map((f) => f.name)).toEqual(Array.from({ length: 10 }, (_v, i) => `f${i}`));
  });

  it("returns an empty result cleanly", async () => {
    const o = orchestratorCtx();
    o.get.mockResolvedValueOnce(json(200, { items: [] }));
    const data = dataOf(await searchCloudFiles.handler({ query: "nothing-matches" }, o.ctx));
    expect(data.count).toBe(0);
    expect(data.files).toEqual([]);
  });

  describe("a refusal or a failure is an error — never an empty result", () => {
    it("403 names whose files could not be told, or that this person's access does not include them", async () => {
      const noPerson = orchestratorCtx();
      noPerson.get.mockResolvedValueOnce(json(403, { error: "acting_user_required" }));
      const a = expectErr(await searchCloudFiles.handler({}, noPerson.ctx));
      expect(a.error.code).toBe("FORBIDDEN");
      // The calendar copy ("whose calendar and reminders these are") would be
      // wrong here: this says cloud files.
      expect(a.error.message).toMatch(/cloud files/i);
      expect(a.error.message).not.toMatch(/calendar|reminder/i);

      const noRole = orchestratorCtx();
      noRole.get.mockResolvedValueOnce(json(403, { error: "forbidden_tool_for_role", tool: "search_cloud_files" }));
      const b = expectErr(await searchCloudFiles.handler({}, noRole.ctx));
      expect(b.error.code).toBe("FORBIDDEN");
      expect(b.error.message).toMatch(/access/i);

      const other = orchestratorCtx();
      other.get.mockResolvedValueOnce(json(403, {}));
      expect(expectErr(await searchCloudFiles.handler({}, other.ctx)).error.code).toBe("FORBIDDEN");
    });

    it("a 409 or a 404 is NOT_CONNECTED, and says where to connect", async () => {
      // MUTATION: drop either status from the handler's mapping and its case
      // goes red; map them to an empty result and both do.
      for (const status of [409, 404]) {
        const o = orchestratorCtx();
        o.get.mockResolvedValueOnce(json(status, { error: "m365_not_connected" }));
        const r = expectErr(await searchCloudFiles.handler({ query: "lease" }, o.ctx));
        expect(r.error.code, String(status)).toBe("NOT_CONNECTED");
        expect(r.error.message).toMatch(/connect microsoft 365/i);
        expect(r.error.message).toMatch(/settings/i);
      }
    });

    it("a 400 carries the route's own reason as INVALID_ARGS, with its fields in the tool's spelling", async () => {
      // The route names `q`, `source` and `modifiedSince`; the model sent
      // `query`, `location` and `modified_since`, and has to be told which of
      // ITS arguments was refused.
      const o = orchestratorCtx();
      o.get.mockResolvedValueOnce(
        json(400, {
          error: "invalid_request",
          details: { fieldErrors: { modifiedSince: ["bad"], q: ["bad"], source: ["bad"], provider: ["bad"], constructor: ["bad"] } },
        }),
      );
      const r = expectErr(await searchCloudFiles.handler({ modified_since: "2026-08-01" }, o.ctx));
      expect(r.error.code).toBe("INVALID_ARGS");
      expect(r.error.message).toBe("invalid modified_since, query, location, provider, constructor");

      const bare = orchestratorCtx();
      bare.get.mockResolvedValueOnce(json(400, { error: "invalid_request" }));
      expect(expectErr(await searchCloudFiles.handler({}, bare.ctx)).error.message).toBe("invalid request");

      const refused = orchestratorCtx();
      refused.get.mockResolvedValueOnce(json(400, { error: "too_many_files_to_search" }));
      const t = expectErr(await searchCloudFiles.handler({}, refused.ctx));
      expect(t.error.code).toBe("INVALID_ARGS");
      expect(t.error.message).toBe("too_many_files_to_search");
    });

    it("any other status is SEARCH_FAILED, naming the status and the route's reason", async () => {
      const down = orchestratorCtx();
      down.get.mockResolvedValueOnce(json(503, {}));
      const a = expectErr(await searchCloudFiles.handler({}, down.ctx));
      expect(a.error.code).toBe("SEARCH_FAILED");
      expect(a.error.message).toBe("orchestrator returned 503");

      const reasoned = orchestratorCtx();
      reasoned.get.mockResolvedValueOnce(json(500, { error: "cloud_files_unavailable" }));
      const b = expectErr(await searchCloudFiles.handler({}, reasoned.ctx));
      expect(b.error.code).toBe("SEARCH_FAILED");
      expect(b.error.message).toBe("orchestrator returned 500: cloud_files_unavailable");
    });

    it("a 200 that is not the route's list is SEARCH_FAILED, not an empty success", async () => {
      for (const body of [{}, { items: "nope" }, { files: [] }, [], null]) {
        const o = orchestratorCtx();
        o.get.mockResolvedValueOnce(json(200, body));
        const r = expectErr(await searchCloudFiles.handler({}, o.ctx));
        expect(r.error.code, JSON.stringify(body)).toBe("SEARCH_FAILED");
      }
      const html = orchestratorCtx();
      html.get.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 200 }));
      expect(expectErr(await searchCloudFiles.handler({}, html.ctx)).error.code).toBe("SEARCH_FAILED");
    });
  });

  it("metadata: Tier-1 read-only, nothing required, no extra args, and the description says what it will not do", () => {
    expect(searchCloudFiles.name).toBe("search_cloud_files");
    expect(searchCloudFiles.requiresWrite).toBe(false);
    expect(searchCloudFiles.requiresConfirmation).toBe(false);
    const schema = searchCloudFiles.inputSchema as {
      required?: readonly string[];
      additionalProperties?: boolean;
      properties?: Record<string, { type?: string; enum?: readonly string[]; minimum?: number; maximum?: number }>;
    };
    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["limit", "location", "modified_since", "provider", "query"]);
    expect(schema.properties?.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 100 });
    // The providers that exist today and no others: a later provider's PR adds
    // its own value here, with its own handler tests.
    expect(schema.properties?.provider).toMatchObject({ type: "string", enum: ["m365"] });
    // Not `maxLength` / `pattern`: those are what blew llama.cpp's grammar
    // compiler (WARP-1839). A closed `enum` is the shape the registry already
    // carries elsewhere.
    for (const prop of Object.values(schema.properties ?? {})) {
      expect(Object.keys(prop)).not.toEqual(expect.arrayContaining(["maxLength"]));
      expect(Object.keys(prop)).not.toEqual(expect.arrayContaining(["pattern"]));
    }
    // The model has to choose this over search_files / search_content, and has
    // to know it never reads a file's contents.
    expect(searchCloudFiles.description).toMatch(/OneDrive/);
    expect(searchCloudFiles.description).toMatch(/SharePoint/);
    expect(searchCloudFiles.description).toMatch(/other cloud drives appear here once connected/i);
    expect(searchCloudFiles.description).toMatch(/never file contents/i);
  });
});
