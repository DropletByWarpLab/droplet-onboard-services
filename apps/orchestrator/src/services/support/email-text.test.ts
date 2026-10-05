/**
 * WARP-3529 — the two translations between a ticket's HTML and an email's text.
 *
 * Outbound mail stays plain text (the indexer's WARP-3267 ruling), so a public
 * reply — written and stored as the PM allowlist's HTML — is turned into text
 * from the SANITIZED HTML, never from what a client sent. Inbound mail goes the
 * other way: a stranger's HTML or text becomes the PM allowlist's HTML before it
 * is stored, because the dashboard renders it with dangerouslySetInnerHTML.
 */
import { describe, it, expect } from "vitest";
import {
  INBOUND_HTML_MAX,
  PLAIN_TEXT_MAX,
  htmlToPlainText,
  inboundBodyHtml,
  textToHtml,
} from "./email-text.js";

describe("htmlToPlainText", () => {
  it.each([
    ["<p>One</p><p>Two</p>", "One\n\nTwo"],
    ["<p>Line 1<br>Line 2</p>", "Line 1\nLine 2"],
    ["<p>Tom &amp; Jerry &lt;3 &quot;x&quot;</p>", 'Tom & Jerry <3 "x"'],
    ["<p><strong>Bold</strong> and <em>italic</em> and <code>code</code></p>", "Bold and italic and code"],
    ["<h2>Heading</h2><p>Body</p>", "Heading\n\nBody"],
    ["<ul><li>One</li><li>Two</li></ul>", "- One\n- Two"],
    ["<ol><li>One</li><li>Two</li></ol>", "1. One\n2. Two"],
    ["<blockquote><p>Quoted</p><p>More</p></blockquote>", "> Quoted\n>\n> More"],
    ["<pre>a\n  b</pre>", "a\n  b"],
    ["<p>Before</p><ul><li>One</li></ul><p>After</p>", "Before\n\n- One\n\nAfter"],
  ])("%s", (html, text) => expect(htmlToPlainText(html)).toBe(text));

  describe("links", () => {
    it("writes the address after the words that carry it", () => {
      expect(htmlToPlainText('<p>See <a href="https://x.example/a">our page</a>.</p>')).toBe(
        "See our page (https://x.example/a).",
      );
    });

    it("writes the address once when it is the link text", () => {
      expect(htmlToPlainText('<p><a href="https://x.example">https://x.example</a></p>')).toBe("https://x.example");
      expect(htmlToPlainText('<p><a href="mailto:a@b.example">a@b.example</a></p>')).toBe("a@b.example");
    });

    it("keeps only the words of a link whose scheme the allowlist drops", () => {
      expect(htmlToPlainText('<p><a href="javascript:alert(1)">click</a></p>')).toBe("click");
    });
  });

  describe("it works from the sanitized HTML, not from what was sent", () => {
    it("drops script and style together with their contents", () => {
      expect(htmlToPlainText("<script>alert(1)</script><style>p{}</style><p>Hi</p>")).toBe("Hi");
    });

    it("drops markup the allowlist does not know, and keeps its text", () => {
      expect(htmlToPlainText('<div onclick="x()"><span style="color:red">Hi</span></div>')).toBe("Hi");
    });

    it("never leaves a tag behind", () => {
      const out = htmlToPlainText('<p>a<img src="https://track.example/p.gif"><iframe src="x"></iframe>b</p>');
      expect(out).toBe("ab");
      expect(out).not.toMatch(/<|>/);
    });
  });

  it("collapses runs of blank lines and trims the ends", () => {
    expect(htmlToPlainText("<p></p><p>A</p><p></p><p></p><p>B</p><p></p>")).toBe("A\n\nB");
  });

  it("returns an empty string for nothing", () => {
    expect(htmlToPlainText("")).toBe("");
    expect(htmlToPlainText("<p></p>")).toBe("");
  });

  it("never contains a carriage return", () => {
    expect(htmlToPlainText("<p>a\r\nb</p>")).not.toContain("\r");
  });

  it("is bounded by PLAIN_TEXT_MAX only by refusing to be longer: the caller checks", () => {
    expect(PLAIN_TEXT_MAX).toBe(64_000);
  });
});

describe("textToHtml", () => {
  it("makes paragraphs of blank-line runs and breaks of single newlines", () => {
    expect(textToHtml("Hi Dana,\n\nLine one\nline two")).toBe("<p>Hi Dana,</p><p>Line one<br>line two</p>");
  });

  it("escapes everything a parser would take for markup", () => {
    expect(textToHtml('<script>alert("x")</script> & co')).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</p>",
    );
  });

  it("is empty for blank input", () => {
    expect(textToHtml("  \n\n ")).toBe("");
  });

  it("round-trips through htmlToPlainText", () => {
    const text = "Hi Dana,\n\nWe fixed <it> & more.\nThanks";
    expect(htmlToPlainText(textToHtml(text))).toBe(text);
  });
});

describe("inboundBodyHtml", () => {
  it("prefers the HTML part, sanitized", () => {
    expect(inboundBodyHtml("plain", "<p>Hello <b>there</b></p><script>x()</script>")).toBe("<p>Hello there</p>");
  });

  it("keeps allowed formatting and links, drops the rest", () => {
    const out = inboundBodyHtml(null, '<p><strong>Hi</strong> <a href="https://x.example" onclick="y()">link</a></p>');
    expect(out).toBe('<p><strong>Hi</strong> <a href="https://x.example">link</a></p>');
  });

  it("never lets a remote image through (no tracking pixel is fetched by the dashboard)", () => {
    expect(inboundBodyHtml(null, '<p>Hi<img src="https://track.example/p.gif"></p>')).toBe("<p>Hi</p>");
  });

  it("uses the text part when the HTML says nothing once sanitized", () => {
    expect(inboundBodyHtml("Real words", '<img src="cid:logo">')).toBe("<p>Real words</p>");
  });

  it("makes escaped paragraphs of a text-only message", () => {
    expect(inboundBodyHtml("Hi,\n\nI am <b>stuck</b>\nHelp", null)).toBe("<p>Hi,</p><p>I am &lt;b&gt;stuck&lt;/b&gt;<br>Help</p>");
  });

  it("is null when there is nothing to show", () => {
    expect(inboundBodyHtml(null, null)).toBeNull();
    expect(inboundBodyHtml("  ", "<p> </p>")).toBeNull();
    expect(inboundBodyHtml("", '<img src="x">')).toBeNull();
  });

  it("shortens an enormous message and says so, rather than store megabytes in a comment", () => {
    const huge = `<p>${"word ".repeat(60_000)}</p>`;
    const out = inboundBodyHtml("word ".repeat(60_000), huge)!;
    expect(out.length).toBeLessThanOrEqual(INBOUND_HTML_MAX);
    expect(out).toContain("shortened");
    expect(out).toContain("mailbox");
    expect(out).not.toMatch(/<(?!\/?p>|br>)/);
  });
});
