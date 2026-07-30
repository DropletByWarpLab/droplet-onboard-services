import { describe, it, expect } from "vitest";
import { validateNcPath } from "../../../src/handlers/files/_paths.js";

function okPath(input: string): string {
  const v = validateNcPath(input);
  if (!v.ok) throw new Error(`expected ${JSON.stringify(input)} to validate, got: ${v.error}`);
  return v.path;
}

describe("validateNcPath separator normalization (WARP-1373)", () => {
  // gpt-oss writes directory paths with a trailing slash constantly; the
  // trailing separator used to read as an empty final segment and got
  // rejected with INVALID_PATH "empty path segment".
  it("treats /A/B/ as equivalent to /A/B", () => {
    expect(okPath("/A/B/")).toBe("/A/B");
    expect(okPath("/A/B/")).toBe(okPath("/A/B"));
  });

  it("accepts the exact path from the staging-suite report", () => {
    expect(okPath("/Home/Maintenance/")).toBe("/Home/Maintenance");
  });

  it("keeps root as / with or without a trailing slash", () => {
    expect(okPath("/")).toBe("/");
    expect(okPath("//")).toBe("/");
    expect(okPath("///")).toBe("/");
  });

  it("collapses duplicate separators", () => {
    expect(okPath("/A//B")).toBe("/A/B");
    expect(okPath("//A//B//")).toBe("/A/B");
    expect(okPath("/A///B/")).toBe("/A/B");
  });

  it("still prepends / to a relative path, trailing slash and all", () => {
    expect(okPath("A/B")).toBe("/A/B");
    expect(okPath("A/B/")).toBe("/A/B");
  });

  it("reports whether the caller wrote a trailing separator", () => {
    const dir = validateNcPath("/A/B/");
    expect(dir.ok && dir.trailingSlash).toBe(true);
    const file = validateNcPath("/A/B");
    expect(file.ok && file.trailingSlash).toBe(false);
    const root = validateNcPath("/");
    expect(root.ok && root.trailingSlash).toBe(false);
  });
});

describe("validateNcPath traversal guard (WARP-938) is unaffected", () => {
  for (const bad of [
    "/../etc/passwd",
    "/foo/../../bar",
    "/A/../B",
    // The same traversals spelled with a trailing slash — stripping the
    // separator must not open a bypass.
    "/A/../",
    "/A/B/../",
    "/../",
    "/foo/..//",
    // Percent-encoded traversal, with and without a trailing slash.
    "/Notes/%2e%2e/admin",
    "/Notes/%2e%2e/",
    "/Notes/%2E%2E/admin/x",
    "/Notes/%252e%252e/admin/x",
    // Backslash-separated traversal.
    "/Notes/..\\admin",
    "/Notes/..\\",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      const v = validateNcPath(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toBe("path traversal not allowed");
    });
  }

  it("keeps the other guards intact", () => {
    expect(validateNcPath(undefined)).toEqual({ ok: false, error: "path must be a string" });
    expect(validateNcPath("")).toEqual({ ok: false, error: "path is required" });
    expect(validateNcPath("/" + "a".repeat(4096))).toEqual({ ok: false, error: "path too long" });
    expect(validateNcPath("/x\0y")).toEqual({ ok: false, error: "null byte in path" });
    expect(validateNcPath("/Notes/%zz")).toEqual({
      ok: false,
      error: "malformed percent-encoding in path",
    });
  });

  it("does not let a trailing slash smuggle a hidden dot-dot past decoding", () => {
    // '%2e%2e%2f' decodes to '../' — the decoded form must be rejected
    // before normalization ever sees it.
    const v = validateNcPath("/Notes/%2e%2e%2f");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe("path traversal not allowed");
  });
});
