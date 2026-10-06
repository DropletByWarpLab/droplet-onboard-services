import { describe, expect, it } from "vitest";
import { isEmptyCommentHtml } from "./pm-mentions.js";

describe("isEmptyCommentHtml", () => {
  it("ignores an unterminated trailing tag while preserving preceding and escaped text", () => {
    expect(isEmptyCommentHtml("<script")).toBe(true);
    expect(isEmptyCommentHtml("Visible <script")).toBe(false);
    expect(isEmptyCommentHtml("&lt;script")).toBe(false);
  });
});
