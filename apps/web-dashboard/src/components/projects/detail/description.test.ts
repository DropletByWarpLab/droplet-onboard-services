// WARP-3520 -- the plain description editor's round trip: text in, sanitized
// paragraphs stored, text back out — and the check that says when a save would
// flatten formatting somebody else wrote.

import { describe, it, expect } from "vitest";
import { descriptionIsPlain, descriptionToText, textToDescriptionHtml } from "./description";

describe("textToDescriptionHtml", () => {
  it("is null for an empty description, so the API clears it", () => {
    for (const blank of ["", "   ", "\n\n", "\r\n"]) expect(textToDescriptionHtml(blank)).toBeNull();
  });

  it("makes a paragraph per blank-line block and a <br> per single newline", () => {
    expect(textToDescriptionHtml("One\ntwo\n\nThree")).toBe("<p>One<br>two</p><p>Three</p>");
    expect(textToDescriptionHtml("a\r\n\r\nb")).toBe("<p>a</p><p>b</p>");
  });

  it("escapes markup rather than storing it", () => {
    expect(textToDescriptionHtml("<script>boom</script> & more")).toBe(
      "<p>&lt;script&gt;boom&lt;/script&gt; &amp; more</p>",
    );
  });
});

describe("descriptionToText", () => {
  it("is empty for no description", () => {
    expect(descriptionToText(null)).toBe("");
    expect(descriptionToText("")).toBe("");
  });

  it("restores paragraphs, line breaks and entities", () => {
    expect(descriptionToText("<p>One<br>two</p><p>Three &amp; four &lt;5&gt;</p>")).toBe("One\ntwo\n\nThree & four <5>");
  });

  it("keeps the shape of a list and drops tags it cannot show", () => {
    expect(descriptionToText("<p>Intro</p><ul><li>One</li><li>Two</li></ul>")).toBe("Intro\n\n- One\n- Two");
    expect(descriptionToText('<p>See <a href="https://x.test">this</a> and <strong>that</strong></p>')).toBe(
      "See this and that",
    );
  });

  it("round-trips plain text through the stored form", () => {
    for (const text of ["Just one line", "Two\nlines", "Para one\n\nPara two\nwith a break", "5 < 6 & 7 > 3"]) {
      expect(descriptionToText(textToDescriptionHtml(text))).toBe(text);
    }
  });

  it("drops unterminated tags while keeping encoded markup as plain editor text", () => {
    expect(descriptionToText("<p>Kept</p><script")).toBe("Kept");
    const plain = descriptionToText("<p>&lt;script&gt;literal&lt;/script&gt;</p>");
    expect(plain).toBe("<script>literal</script>");
    expect(textToDescriptionHtml(plain)).toBe("<p>&lt;script&gt;literal&lt;/script&gt;</p>");
  });
});

describe("descriptionIsPlain", () => {
  it("is true for nothing and for paragraphs and breaks only", () => {
    expect(descriptionIsPlain(null)).toBe(true);
    expect(descriptionIsPlain("<p>a<br>b</p><p>c</p>")).toBe(true);
    expect(descriptionIsPlain("<p>a<br/>b</p>")).toBe(true);
  });

  it("is false once anything else is in it, because a save would flatten it", () => {
    for (const html of [
      "<p><strong>bold</strong></p>",
      "<ul><li>x</li></ul>",
      '<p><a href="https://x.test">link</a></p>',
      "<h2>Heading</h2>",
      "<blockquote>q</blockquote>",
    ]) {
      expect(descriptionIsPlain(html), html).toBe(false);
    }
  });
});
