import { describe, it, expect } from "vitest";
import { sanitizePmHtml, extractMentionIds } from "./sanitize-html.js";

describe("sanitizePmHtml", () => {
  it("strips <script> tags and their contents", () => {
    const out = sanitizePmHtml("<p>hi</p><script>alert(document.cookie)</script>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(document.cookie)");
    expect(out).toContain("<p>hi</p>");
  });

  it("strips event-handler attributes (onerror, onclick)", () => {
    const out = sanitizePmHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(1)");
  });

  it("strips <img> entirely (not on the allowlist)", () => {
    const out = sanitizePmHtml('<img src="x" onerror="alert(1)">after');
    expect(out).not.toContain("<img");
    expect(out).toContain("after");
  });

  // GHSA-jxwj-j7wr-gfrw: raw-text closing tags inside a foreign namespace
  // must not turn the following markup into an executable stored payload.
  it.each([
    '<svg><textarea></textarea/><img src=x onerror=alert(1)></svg>',
    '<math><textarea></textarea/><img src=x onerror=alert(1)></math>',
    '<svg><xmp></xmp/><img src=x onerror=alert(1)></svg>',
  ])("rejects foreign raw-text mutation-XSS markup: %s", (html) => {
    const out = sanitizePmHtml(html);
    expect(out).not.toMatch(/<(?:svg|math|textarea|xmp|img)\b/i);
    expect(out).not.toMatch(/<[^>]+\bon(?:error|load)\s*=/i);
  });

  // GHSA-g8qq-57p8-ggw5: the wrapper never permits SVG animation, even
  // when the URI list starts with a safe fragment before javascript:.
  it.each(["animate", "set"])("rejects SVG %s URL-policy bypasses", (tag) => {
    const out = sanitizePmHtml(
      `<svg><a><${tag} attributeName="href" values="#safe;javascript:alert(1)" ` +
        `dur=".01s" fill="freeze"></${tag}><text>Click me</text></a></svg>`,
    );
    expect(out).not.toMatch(/<(?:svg|animate|set|text)\b/i);
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("attributeName");
  });

  it("strips <iframe>", () => {
    const out = sanitizePmHtml('<iframe src="https://evil.example"></iframe>text');
    expect(out).not.toContain("<iframe");
    expect(out).toContain("text");
  });

  it("strips style attributes and <style> blocks", () => {
    const out = sanitizePmHtml('<p style="position:fixed">x</p><style>body{display:none}</style>');
    expect(out).not.toContain("style=");
    expect(out).not.toContain("<style");
    expect(out).toContain("x");
  });

  it("keeps basic formatting tags on the allowlist", () => {
    const html =
      "<p>para</p><strong>b</strong><em>i</em><ul><li>one</li></ul><ol><li>two</li></ol>" +
      "<code>c</code><pre>p</pre><blockquote>q</blockquote><h1>h</h1><h2>h2</h2><h3>h3</h3><br>";
    const out = sanitizePmHtml(html);
    for (const tag of ["<p>", "<strong>", "<em>", "<ul>", "<li>", "<ol>", "<code>", "<pre>", "<blockquote>", "<h1>", "<h2>", "<h3>", "<br"]) {
      expect(out).toContain(tag);
    }
  });

  it("keeps safe <a href> links but drops javascript: hrefs", () => {
    const safe = sanitizePmHtml('<a href="https://example.com">link</a>');
    expect(safe).toContain('href="https://example.com"');
    expect(safe).toContain(">link</a>");

    const evil = sanitizePmHtml('<a href="javascript:alert(1)">x</a>');
    expect(evil).not.toContain("javascript:");
  });

  it("preserves <br> line breaks produced by the dashboard newline handling", () => {
    const out = sanitizePmHtml("<p>line one<br>line two</p>");
    expect(out).toContain("<br");
    expect(out).toContain("line one");
    expect(out).toContain("line two");
  });

  it("passes through plain escaped text unchanged in meaning", () => {
    const out = sanitizePmHtml("<p>a &amp; b &lt; c</p>");
    expect(out).toContain("&amp;");
    expect(out).toContain("&lt;");
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizePmHtml("")).toBe("");
  });
});

// WARP-3519 (WS-2) — @mentions. The allowlist grows by exactly one attribute on
// exactly one tag, and the id it carries is validated by SHAPE: it is parsed
// back out of the stored html to decide who gets notified, so everything else
// about the span (class, style, handlers, a hostile id) must not survive.
describe("sanitizePmHtml — @mention spans (WARP-3519)", () => {
  const ID = "0d9c5c1e-2f4a-4b6d-8e10-3a5c7e9b1d2f";

  it("keeps <span data-mention-id> and its @Name text", () => {
    const out = sanitizePmHtml(`<p>hi <span data-mention-id="${ID}">@Ana</span></p>`);
    expect(out).toBe(`<p>hi <span data-mention-id="${ID}">@Ana</span></p>`);
  });

  it("strips every other attribute from the mention span", () => {
    const out = sanitizePmHtml(
      `<p><span data-mention-id="${ID}" class="x" style="position:fixed" onclick="steal()" id="y">@Ana</span></p>`,
    );
    expect(out).toBe(`<p><span data-mention-id="${ID}">@Ana</span></p>`);
  });

  it("unwraps a plain <span> to its text — spans are allowed ONLY as mentions", () => {
    const out = sanitizePmHtml('<p><span style="color:red">plain</span> text</p>');
    expect(out).toBe("<p>plain text</p>");
  });

  it.each([
    ["an empty id", '<span data-mention-id="">@x</span>'],
    ["an id with a quote", '<span data-mention-id="a&quot; onmouseover=&quot;alert(1)">@x</span>'],
    ["an id with markup", '<span data-mention-id="&lt;img src=x&gt;">@x</span>'],
    ["an id with a space", '<span data-mention-id="a b">@x</span>'],
    ["an over-long id", `<span data-mention-id="${"a".repeat(65)}">@x</span>`],
  ])("unwraps a mention span carrying %s", (_label, html) => {
    const out = sanitizePmHtml(`<p>${html}</p>`);
    expect(out).toBe("<p>@x</p>");
    expect(out).not.toContain("data-mention-id");
  });

  it("drops data-mention-id from every OTHER tag", () => {
    const out = sanitizePmHtml(
      `<p data-mention-id="${ID}">x</p><a href="https://e.example" data-mention-id="${ID}">l</a>`,
    );
    expect(out).not.toContain("data-mention-id");
  });

  it("with allowedMentionIds, unwraps a mention of anyone not in the set (text kept)", () => {
    const html = `<p><span data-mention-id="u-1">@Ana</span> and <span data-mention-id="u-2">@Ben</span></p>`;
    const out = sanitizePmHtml(html, { allowedMentionIds: new Set(["u-1"]) });
    expect(out).toBe('<p><span data-mention-id="u-1">@Ana</span> and @Ben</p>');
  });

  it("with an EMPTY allowedMentionIds set, unwraps every mention", () => {
    const out = sanitizePmHtml('<p><span data-mention-id="u-1">@Ana</span></p>', {
      allowedMentionIds: new Set(),
    });
    expect(out).toBe("<p>@Ana</p>");
  });

  // A dropped mention followed by a KEPT one at the same depth closed the kept
  // one as `</x-unwrap>` when spans were dropped by renaming them: sanitize-html
  // keeps its rename bookkeeping per depth and never clears it for a dropped tag.
  // Found by the real-Postgres suite (pm-collaboration.pg.test.ts), pinned here.
  it("a dropped mention BEFORE a kept one leaves the kept one well-formed", () => {
    const html =
      '<p><span data-mention-id="bad id">@Dee</span> <span data-mention-id="u-1">@Cara</span> <span data-mention-id="u-2">@Gus</span></p>';
    expect(sanitizePmHtml(html, { allowedMentionIds: new Set(["u-1"]) })).toBe(
      '<p>@Dee <span data-mention-id="u-1">@Cara</span> @Gus</p>',
    );
    expect(sanitizePmHtml(html)).toBe(
      '<p>@Dee <span data-mention-id="u-1">@Cara</span> <span data-mention-id="u-2">@Gus</span></p>',
    );
  });

  it("alternating dropped and kept mentions all close correctly", () => {
    const span = (id: string) => `<span data-mention-id="${id}">@${id}</span>`;
    const html = `<p>${span("a b")}${span("u-1")}${span("c d")}${span("u-2")}${span("e f")}</p>`;
    const out = sanitizePmHtml(html);
    expect(out).toBe(`<p>@a b${span("u-1")}@c d${span("u-2")}@e f</p>`);
    expect(out).not.toContain("x-unwrap");
  });

  it("is idempotent: sanitizing the output again changes nothing", () => {
    const once = sanitizePmHtml(`<p>a <span data-mention-id="${ID}" class="z">@Ana</span></p>`);
    expect(sanitizePmHtml(once)).toBe(once);
  });
});

describe("extractMentionIds (WARP-3519)", () => {
  it("returns the ids in document order, de-duplicated", () => {
    const html =
      '<p><span data-mention-id="u-2">@B</span> <span data-mention-id="u-1">@A</span> <span data-mention-id="u-2">@B</span></p>';
    expect(extractMentionIds(html)).toEqual(["u-2", "u-1"]);
  });

  it("finds a mention nested inside other formatting", () => {
    expect(
      extractMentionIds('<ul><li><strong><span data-mention-id="u-1">@A</span></strong></li></ul>'),
    ).toEqual(["u-1"]);
  });

  it("ignores spans without a valid id and never throws on junk", () => {
    expect(extractMentionIds('<span>x</span><span data-mention-id="bad id">y</span>')).toEqual([]);
    expect(extractMentionIds("")).toEqual([]);
    expect(extractMentionIds("<<<>>>")).toEqual([]);
  });

  it("reads only what SURVIVES sanitization — a span smuggled inside <script> is not a mention", () => {
    expect(
      extractMentionIds('<script><span data-mention-id="u-9">@x</span></script><p>ok</p>'),
    ).toEqual([]);
  });
});
