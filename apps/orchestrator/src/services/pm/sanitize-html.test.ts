import { describe, it, expect } from "vitest";
import { sanitizePmHtml } from "./sanitize-html.js";

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
