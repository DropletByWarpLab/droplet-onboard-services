import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import readFile from "../../../src/handlers/files/read-file.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  get: Mock,
  opts: { ncToken?: string; userId?: string } = {},
): ToolContext {
  return {
    http: {
      nextcloud: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      orchestrator: {} as ToolContext["http"]["orchestrator"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    // Default to an authenticated session so the happy-path tests
    // exercise the read; auth-gate tests override these explicitly.
    userId: opts.userId === undefined ? "alice" : opts.userId,
    ncToken: opts.ncToken === undefined ? "tok" : opts.ncToken,
    signal: new AbortController().signal,
  };
}

describe("read_file", () => {
  it("rejects missing path", async () => {
    const get = vi.fn();
    const r = await readFile.handler({}, ctxWith(get));
    expect(r.ok).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  // TOOLS-03: must require an authenticated Nextcloud session, like the
  // write file-tools do.
  it("returns AUTH_REQUIRED without ncToken", async () => {
    const get = vi.fn();
    const r = await readFile.handler({ path: "/notes/x.txt" }, ctxWith(get, { ncToken: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    // The message is the model's only recovery signal: it must say HOW to
    // fix the state (password re-login re-provisions the file credential),
    // not read as a permissions refusal the model apologizes for.
    if (!r.ok) expect(r.error.message).toContain("sign back in with their password");
    expect(get).not.toHaveBeenCalled();
  });

  it("returns AUTH_REQUIRED without userId", async () => {
    const get = vi.fn();
    const r = await readFile.handler({ path: "/notes/x.txt" }, ctxWith(get, { userId: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(get).not.toHaveBeenCalled();
  });

  // TOOLS-03: traversal must be rejected at the tool boundary (the same
  // validateNcPath the write tools run), before any HTTP call.
  for (const bad of [
    "/../etc/passwd",
    "/foo/../../bar",
    "/foo\0bar",
    "",
    "/Notes/%2e%2e/admin/x",
    "/Notes/%252e%252e/admin/x",
    "/Notes/..\\admin",
  ]) {
    it(`rejects malformed path ${JSON.stringify(bad)} with INVALID_PATH`, async () => {
      const get = vi.fn();
      const r = await readFile.handler({ path: bad }, ctxWith(get));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_PATH");
      expect(get).not.toHaveBeenCalled();
    });
  }

  // PR #1985 review: a malformed percent escape is a literal, not an error.
  it("downloads a path holding a bare % as written", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response("hi", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await readFile.handler({ path: "/Reports/50% Off Report.txt" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(
      `/download?path=${encodeURIComponent("/Reports/50% Off Report.txt")}`,
      expect.anything(),
    );
  });

  it("attaches the Nextcloud auth headers on the download call", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response("hi", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await readFile.handler({ path: "/notes/x.txt" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(
      `/download?path=${encodeURIComponent("/notes/x.txt")}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcloud-Token": "tok",
          "X-Nextcloud-User": "alice",
        }),
      }),
    );
  });

  it("returns text content for text/* responses", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response("hello world", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const r = await readFile.handler({ path: "/notes/x.txt" }, ctxWith(get));
    expect(r.ok).toBe(true);
    // WARP-2194: the WHOLE payload, pinned. A short file is a complete
    // read, and it says so in the same fields a truncated one uses — the
    // model never has to infer completeness from content length.
    if (r.ok)
      expect(r.data).toEqual({
        path: "/notes/x.txt",
        content: "hello world",
        offset: 0,
        truncated: false,
        next_offset: null,
        bytes_total: 11,
        chars_total: 11,
      });
  });

  it("caps text at 10,000 characters", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response("a".repeat(20000), { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const r = await readFile.handler({ path: "/big.txt" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { content: string }).content.length).toBe(10000);
  });

  it("flags binary content types", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(" ", { status: 200, headers: { "content-type": "image/png" } }),
    );
    const r = await readFile.handler({ path: "/p.png" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { error: string }).error).toMatch(/Binary/);
  });

  it("error on 404", async () => {
    const get = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    const r = await readFile.handler({ path: "/missing" }, ctxWith(get));
    expect(r.ok).toBe(false);
  });
});

// ── WARP-1372: the download proxy reports application/octet-stream for
// plainly-readable files (md/csv/txt on the staging box), and the
// header-only gate refused every one — killing the search→read→answer
// path (~12/36 staging eval rows per run). The handler must sniff
// undeclared content like the file-indexer's watcher does (WARP-1139)
// instead of trusting the header.
describe("read_file — octet-stream sniffing (WARP-1372)", () => {
  it("reads a UTF-8 text file reported as application/octet-stream", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response("# Home maintenance log\n\nBoiler serviced 10/02/2026.", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const r = await readFile.handler({ path: "/Home/log.md" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { content?: string; error?: string };
      expect(data.error).toBeUndefined();
      expect(data.content).toContain("Boiler serviced");
    }
  });

  it("tolerates a multibyte char split at the sniff boundary", async () => {
    // 4095 ASCII bytes + 'é' (2 bytes) puts the second byte of the char
    // exactly past a 4096-byte sniff head — a truncated char is not
    // evidence of binary content (same rule as watcher.py's sniffer).
    const body = "a".repeat(4095) + "é — fin";
    const get = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const r = await readFile.handler({ path: "/notes/long.txt" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { content?: string; error?: string };
      expect(data.error).toBeUndefined();
      expect(data.content).toContain("fin");
    }
  });

  it("still refuses genuine binary content with the explanatory note", async () => {
    // PNG-ish header: NUL and high bytes that are not valid UTF-8.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x00, 0x01]);
    const get = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const r = await readFile.handler({ path: "/photo.png" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { content?: string; error?: string };
      expect(data.content).toBeUndefined();
      expect(data.error).toContain("Binary file");
    }
  });
});

// ── WARP-2194: read_file used to slice at 10,000 characters and say
// nothing about it. A 9 KB file and the first 8% of a 120 KB file came
// back in the SAME shape — `{ path, content }` — so the model summarized
// a fragment as though it were the whole file. read_document_text already
// solved this (WARP-2057) with an explicit `next_chunk`; these tests hold
// read_file to the same contract: a number while text remains, null ONLY
// when the file is genuinely exhausted.

/** Response factory — a Response body is single-use, and paging calls the
 *  handler repeatedly, so every call must get a fresh one. */
function servesText(body: string, contentType = "text/plain") {
  return vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(body, { status: 200, headers: { "content-type": contentType } }),
    );
}

type PageData = {
  path: string;
  content: string;
  offset: number;
  truncated: boolean;
  next_offset: number | null;
  bytes_total: number;
  chars_total: number;
};

async function readPage(
  get: Mock,
  path: string,
  offset?: number,
): Promise<PageData> {
  const r = await readFile.handler(
    offset === undefined ? { path } : { path, offset },
    ctxWith(get),
  );
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return (r as { ok: true; data: PageData }).data;
}

/** Page from 0 to exhaustion, exactly as the model is told to. */
async function readToEnd(get: Mock, path: string) {
  const pages: PageData[] = [];
  let offset: number | null = 0;
  // Bounded so a next_offset that never advances fails as a test rather
  // than hanging the suite.
  for (let i = 0; i < 200 && offset !== null; i++) {
    const page: PageData = await readPage(get, path, offset);
    pages.push(page);
    expect(page.next_offset, "next_offset must advance").not.toBe(offset);
    offset = page.next_offset;
  }
  expect(offset, "paging did not terminate").toBeNull();
  return { pages, text: pages.map((p) => p.content).join("") };
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** Unpaired surrogates left after removing every well-formed pair. A page
 *  containing one is a codepoint this handler split in half. */
const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""));

describe("read_file — paging contract (WARP-2194)", () => {
  it("declares offset in the input schema without loosening it", () => {
    const schema = readFile.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.properties.offset).toMatchObject({
      type: "integer",
      minimum: 0,
      default: 0,
    });
    // offset is resumable state, never something the model must supply.
    expect(schema.required).toEqual(["path"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("marks an over-cap file truncated with a usable next_offset", async () => {
    const body = "a".repeat(25000);
    const page = await readPage(servesText(body), "/big.txt");
    expect(page.content.length).toBe(10000);
    expect(page.truncated).toBe(true);
    expect(page.next_offset).toBe(10000);
    expect(page.chars_total).toBe(25000);
    expect(page.bytes_total).toBe(25000);
  });

  it("marks an under-cap file complete with next_offset null", async () => {
    const page = await readPage(servesText("hello world"), "/notes/x.txt");
    expect(page.content).toBe("hello world");
    expect(page.truncated).toBe(false);
    expect(page.next_offset).toBeNull();
    expect(page.offset).toBe(0);
  });

  // THE assertion this ticket exists for. Without it a suite that only
  // checks "content came back" stays green while the defect is fully live:
  // both responses look like `{ path, content }` and the model cannot tell
  // a fragment from a whole file.
  it("does not shape a truncated response like a complete one", async () => {
    const partial = await readPage(servesText("a".repeat(25000)), "/big.txt");
    const whole = await readPage(servesText("a".repeat(9000)), "/small.txt");

    // Same KEYS — a shape the model can rely on...
    expect(Object.keys(partial).sort()).toEqual(Object.keys(whole).sort());
    // ...but never the same ANSWER to "is that the whole file?".
    expect(partial.truncated).not.toBe(whole.truncated);
    expect(typeof partial.next_offset).toBe("number");
    expect(whole.next_offset).toBeNull();
    // And the tell must not be inferable only from content length: a file
    // of exactly 10,000 chars is complete and fills the budget.
    const exact = await readPage(servesText("a".repeat(10000)), "/exact.txt");
    expect(exact.content.length).toBe(10000);
    expect(exact.truncated).toBe(false);
    expect(exact.next_offset).toBeNull();
  });

  it("resumes from next_offset and reconstructs a multi-byte file exactly", async () => {
    // 5 chars / 11 UTF-8 bytes per unit, so a byte offset and a character
    // offset diverge on the very first unit and never re-converge. A Range
    // request or a byte-index slice would land mid-codepoint and drop or
    // duplicate characters at every page boundary.
    const body = "éàü€ß".repeat(4000) + "🌍 — 末尾\n";
    expect(utf8Len(body)).toBeGreaterThan(body.length); // genuinely multi-byte
    const get = servesText(body, "text/plain; charset=utf-8");

    const { pages, text } = await readToEnd(get, "/notes/multibyte.txt");

    expect(text).toBe(body);
    expect(text.length).toBe(body.length);
    expect(pages.length).toBeGreaterThan(1);
    // Every page but the last says "there is more"; the last says "done".
    for (const p of pages.slice(0, -1)) {
      expect(p.truncated).toBe(true);
      expect(typeof p.next_offset).toBe("number");
    }
    const last = pages[pages.length - 1];
    expect(last.truncated).toBe(false);
    expect(last.next_offset).toBeNull();
    // bytes_total is BYTES; the offsets are CHARACTERS. Both are reported
    // so neither has to be guessed from the other.
    for (const p of pages) {
      expect(p.bytes_total).toBe(utf8Len(body));
      expect(p.chars_total).toBe(body.length);
    }
    expect(last.bytes_total).toBeGreaterThan(last.chars_total);
  });

  it("never splits an astral codepoint across a page boundary", async () => {
    // The emoji straddles char 9999/10000: a naive slice at the cap hands
    // page 1 a lone high surrogate and page 2 a lone low one. They rejoin
    // on concatenation, but any consumer that UTF-8-encodes a single page
    // turns each half into U+FFFD and the character is lost for good.
    const body = "a".repeat(9999) + "🌍" + "b".repeat(500);
    const get = servesText(body);

    const { pages, text } = await readToEnd(get, "/notes/emoji.txt");

    expect(text).toBe(body);
    for (const p of pages) {
      expect(hasLoneSurrogate(p.content), JSON.stringify(p.content.slice(-4))).toBe(
        false,
      );
    }
    expect(pages[0].content.length).toBe(9999);
    expect(pages[0].next_offset).toBe(9999);
    expect(pages[1].content.startsWith("🌍")).toBe(true);
  });

  it("pages the sniffed octet-stream path too, not just declared text", async () => {
    // The orchestrator's /api/files/download labels every non-PDF download
    // application/octet-stream, so this — not text/* — is the production
    // path (WARP-1372). Paging that only worked on declared text would be
    // paging that never ran.
    const body = "ünïcøde ".repeat(3000);
    const get = servesText(body, "application/octet-stream");
    const { text, pages } = await readToEnd(get, "/notes/sniffed.md");
    expect(text).toBe(body);
    expect(pages.length).toBeGreaterThan(1);
  });

  it("honours an explicit offset without re-reading from the start", async () => {
    const body = "0123456789".repeat(2000); // 20,000 chars
    const page = await readPage(servesText(body), "/notes/x.txt", 15000);
    expect(page.offset).toBe(15000);
    expect(page.content).toBe(body.slice(15000));
    expect(page.truncated).toBe(false);
    expect(page.next_offset).toBeNull();
  });

  it("rejects a malformed offset before spending a download", async () => {
    for (const offset of [-1, 1.5, "10", null, NaN]) {
      const get = vi.fn();
      const r = await readFile.handler({ path: "/a.txt", offset }, ctxWith(get));
      expect(r.ok, `offset ${String(offset)} should be refused`).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
      expect(get).not.toHaveBeenCalled();
    }
  });

  it("rejects an offset past the end with a message naming the real length", async () => {
    const r = await readFile.handler(
      { path: "/a.txt", offset: 99999 },
      ctxWith(servesText("short file")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ARGS");
      expect(r.error.message).toContain("10");
    }
  });

  it("serves an empty file as a complete, exhausted read", async () => {
    const page = await readPage(servesText(""), "/empty.txt");
    expect(page.content).toBe("");
    expect(page.truncated).toBe(false);
    expect(page.next_offset).toBeNull();
    expect(page.chars_total).toBe(0);
    expect(page.bytes_total).toBe(0);
  });
});

// ── WARP-2194: a PDF's full text lives in read_document_text (WARP-2057),
// which reassembles the file-indexer's ordered chunks. search_content
// answers a different question — the passages most similar to a query,
// ranked and capped — so pointing a "read this whole document" intent
// there is what produced summaries built on the top few snippets.
describe("read_file — binary redirect names read_document_text (WARP-2194)", () => {
  it("points a declared-binary refusal at read_document_text", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        new Response("%PDF-1.7", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      );
    const r = await readFile.handler({ path: "/Docs/quote.pdf" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const note = (r.data as { error: string }).error;
      expect(note).toContain("application/pdf");
      expect(note).toContain("read_document_text");
      expect(note).not.toContain("search_content");
    }
  });

  it("points a sniffed-binary refusal at read_document_text", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x00, 0x01]);
    const get = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const r = await readFile.handler({ path: "/photo.png" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { error: string }).error).toContain("read_document_text");
  });

  // The description is the ONLY thing the model reads when deciding
  // whether to call again — an accurate handler with a silent description
  // still produces a confident summary of the first 10,000 characters.
  it("states the paging contract in the tool description", () => {
    const d = readFile.description;
    expect(d).toContain("offset");
    expect(d).toContain("next_offset");
    expect(d).toMatch(/null/);
    expect(d).toContain("read_document_text");
    expect(d).not.toContain("search_content");
  });
});

// ── WARP-2194 (review finding): paging must not make the body read
// unconditional. A DECLARED binary has always returned the refusal WITHOUT
// the body ever being read — `arrayBuffer()` lived inside the undeclared/
// sniff branch. Hoisting the read above the content-type branches downloads
// and buffers an entire video into the tool host's heap purely to discard it
// a few lines later, on a request that cannot succeed. There is no upstream
// bound to fall back on: the orchestrator's GET /api/files/download pipes
// `ncDownloadFile`'s stream through with no size cap, and `read_file` takes
// an arbitrary model-supplied path. The cost is invisible in the response
// shape, which is exactly why it needs an assertion.
describe("read_file — never buffers a body it cannot use (WARP-2194)", () => {
  /** A Response whose body reads are spies, so "was it downloaded?" is
   *  observable rather than inferred from a payload that looks identical
   *  either way. */
  function spyingResponse(contentType: string, body = "") {
    const encoded = new TextEncoder().encode(body);
    // `.slice()` gives an exactly-sized buffer; a TextEncoder view's own
    // buffer is not promised to be tight.
    const arrayBuffer = vi.fn(async () => encoded.slice().buffer);
    const text = vi.fn(async () => body);
    return {
      arrayBuffer,
      text,
      res: {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": contentType }),
        arrayBuffer,
        text,
      } as unknown as Response,
    };
  }

  for (const contentType of [
    "application/pdf",
    "video/mp4",
    "image/png",
    "application/zip",
  ]) {
    it(`refuses ${contentType} without downloading it`, async () => {
      const { res, arrayBuffer, text } = spyingResponse(contentType, "x".repeat(64));
      const get = vi.fn().mockResolvedValue(res);
      const r = await readFile.handler({ path: "/Media/large" }, ctxWith(get));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((r.data as { error: string }).error).toContain(contentType);
        expect((r.data as { error: string }).error).toContain("read_document_text");
      }
      expect(arrayBuffer, "declared binary must not be buffered").not.toHaveBeenCalled();
      expect(text, "declared binary must not be buffered").not.toHaveBeenCalled();
    });
  }

  it("reads the body exactly once on the declared-text path", async () => {
    const { res, arrayBuffer } = spyingResponse("text/plain", "hello");
    const get = vi.fn().mockResolvedValue(res);
    const r = await readFile.handler({ path: "/notes/x.txt" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { content: string }).content).toBe("hello");
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it("reads the body exactly once on the sniffed octet-stream path", async () => {
    const { res, arrayBuffer } = spyingResponse("application/octet-stream", "# notes");
    const get = vi.fn().mockResolvedValue(res);
    const r = await readFile.handler({ path: "/notes/x.md" }, ctxWith(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { content: string }).content).toBe("# notes");
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });
});
