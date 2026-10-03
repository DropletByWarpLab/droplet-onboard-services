/**
 * The text-safety helpers: what the signed audit chain can store byte-for-byte
 * (`chainSafeText`) and what person-controlled text may carry when it is
 * rendered (`hasUnsafeDisplayChars` / `stripUnsafeDisplayChars`).
 */
import { describe, it, expect } from "vitest";
import { chainSafeText, hasUnsafeDisplayChars, stripUnsafeDisplayChars } from "./text-safety.js";

describe("chainSafeText", () => {
  it("accepts storable text and refuses U+0000 and lone surrogates", () => {
    expect(chainSafeText("Front door 😀")).toBe(true);
    expect(chainSafeText("")).toBe(true);
    expect(chainSafeText("a\u0000")).toBe(false);
    expect(chainSafeText("\uD83D")).toBe(false);
    expect(chainSafeText("\uDE00\uD83D")).toBe(false);
  });
});

describe("hasUnsafeDisplayChars", () => {
  it("accepts ordinary text, including ZWJ / ZWNJ and the LRM / RLM marks", () => {
    expect(hasUnsafeDisplayChars("Front desk")).toBe(false);
    expect(hasUnsafeDisplayChars("")).toBe(false);
    expect(hasUnsafeDisplayChars("👩‍👩‍👧")).toBe(false);
    expect(hasUnsafeDisplayChars("می‌خواهم")).toBe(false);
    expect(hasUnsafeDisplayChars("a‎b‏c")).toBe(false);
  });

  it("refuses controls, line and paragraph separators, bidi embeddings / overrides / isolates and U+FEFF", () => {
    for (const bad of ["a\u0000b", "a\tb", "a\nb", "a\u0085b", "a b", "a b", "a‮b", "a‪b", "a⁦b", "a⁩b", "﻿a"]) {
      expect(hasUnsafeDisplayChars(bad), JSON.stringify(bad)).toBe(true);
    }
  });
});

describe("stripUnsafeDisplayChars", () => {
  it("removes exactly the characters hasUnsafeDisplayChars refuses and leaves the rest alone", () => {
    expect(stripUnsafeDisplayChars("Front‮ desk\n")).toBe("Front desk");
    expect(stripUnsafeDisplayChars("﻿a b⁩c")).toBe("abc");
    expect(stripUnsafeDisplayChars("a‍b‌c‎d")).toBe("a‍b‌c‎d");
    expect(stripUnsafeDisplayChars("plain 😀")).toBe("plain 😀");
    expect(stripUnsafeDisplayChars("")).toBe("");
  });

  it("is idempotent, and its output never trips hasUnsafeDisplayChars", () => {
    const dirty = "a\u0000b‮c⁦d\nÉ﻿";
    const once = stripUnsafeDisplayChars(dirty);
    expect(stripUnsafeDisplayChars(once)).toBe(once);
    expect(hasUnsafeDisplayChars(once)).toBe(false);
  });
});
