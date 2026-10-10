/**
 * WARP-3956 — Integrations became Connectors. The old PAGE urls must keep
 * working as permanent redirects, and the mapping must carry the sub-path
 * (Next preserves the query string on its own).
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(join(__dirname, "noop.js"));
const config = require(join(__dirname, "..", "..", "next.config.js")) as {
  redirects: () => Promise<{ source: string; destination: string; permanent: boolean }[]>;
};

/** Minimal `:path*` expansion, enough for these rules. */
function apply(rules: { source: string; destination: string }[], url: string): string | null {
  const [pathname, query] = url.split("?");
  for (const r of rules) {
    const prefix = r.source.replace("/:path*", "");
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const rest = pathname.slice(prefix.length);
      const dest = r.destination.replace("/:path*", rest);
      return query ? `${dest}?${query}` : dest;
    }
  }
  return null;
}

describe("legacy /integrations page redirects", () => {
  it("are all permanent", async () => {
    const rules = await config.redirects();
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r.permanent).toBe(true);
  });

  it.each([
    ["/integrations", "/connectors"],
    ["/integrations/credentials", "/connectors/credentials"],
    ["/integrations/credentials?mcp=atlassian:connected", "/connectors/credentials?mcp=atlassian:connected"],
    ["/integrations?connect=stripe", "/connectors?connect=stripe"],
    ["/integrations/development", "/connectors/development"],
    ["/help/integrations/stripe", "/help/connectors/stripe"],
  ])("%s -> %s", async (from, to) => {
    expect(apply(await config.redirects(), from)).toBe(to);
  });

  it("leaves the new paths and the API alone", async () => {
    const rules = await config.redirects();
    expect(apply(rules, "/connectors")).toBeNull();
    expect(apply(rules, "/api/integrations")).toBeNull();
  });
});
