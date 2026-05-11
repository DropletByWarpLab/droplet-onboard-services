import { describe, it, expect } from "vitest";

import { trimDisplayPath } from "@/app/knowledge/displayPath";

/**
 * WARP-294 — RecentlyIndexedTab leaks internal Nextcloud paths to the
 * user. The trimmer strips known server-side prefixes (`/admin/files/`,
 * `/private/`, leading slash) and keeps just enough lineage that the
 * user has context — typically the last two path segments.
 */

describe("trimDisplayPath (WARP-294)", () => {
  it("strips the /admin/files/ Nextcloud prefix", () => {
    expect(
      trimDisplayPath("/admin/files/private/Knowledge/notes.md"),
    ).toBe("Knowledge/notes.md");
  });

  it("strips a /private/ prefix", () => {
    expect(trimDisplayPath("/private/Knowledge/notes.md")).toBe(
      "Knowledge/notes.md",
    );
  });

  it("keeps the basename for shallow paths", () => {
    expect(trimDisplayPath("notes.md")).toBe("notes.md");
    expect(trimDisplayPath("/notes.md")).toBe("notes.md");
  });

  it("preserves the last two segments for deeply-nested paths", () => {
    expect(
      trimDisplayPath("/admin/files/private/Sub/Folder/deep/file.md"),
    ).toBe("deep/file.md");
  });

  it("never returns a path containing /admin or /private prefixes", () => {
    const result = trimDisplayPath("/admin/files/private/x/y/z.md");
    expect(result).not.toMatch(/^\/admin/);
    expect(result).not.toMatch(/^\/private/);
    expect(result).not.toMatch(/^\//);
  });

  it("handles edge cases (empty string, single slash, undefined-ish)", () => {
    expect(trimDisplayPath("")).toBe("");
    expect(trimDisplayPath("/")).toBe("");
  });
});
