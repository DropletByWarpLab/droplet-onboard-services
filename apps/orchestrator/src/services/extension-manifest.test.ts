/**
 * WARP-2900 (ADR-056 slice H1): the extension manifest, the signed
 * statement, and the promote readback.
 *
 * The manifest is strict. Every key the schema does not name is refused, one
 * test per place a key could be smuggled in, because an unknown key is either
 * a typo the owner never sees or a field some later reader will trust.
 *
 * Mutations these tests are written to catch:
 *   - z.object without .strict() anywhere      -> a refused-key row goes green
 *   - egress: z.string()                       -> the egress rows go green
 *   - entrypoint without the segment pattern   -> the traversal rows go green
 *   - readback derived from summary/description -> the lying-manifest test
 *   - canonicalize without sorted keys         -> the canonical-bytes test
 *
 * WARP-3905 (hosted apps, slice HA-1) adds `kind: "app"` and the `http`
 * block. One test per rule, so each rule has a mutation that turns it red:
 *   - drop "an app requires http"              -> the app-without-http row
 *   - drop "an extension refuses http"         -> the extension-with-http row
 *   - drop "static refuses entrypoint"         -> the static-with-entrypoint row
 *   - drop "static requires http.dir"          -> the static-without-dir rows
 *   - loosen the dir/health patterns           -> the `..` / absolute rows
 *   - drop "an app's tools must be empty"      -> the app-with-tools row
 *   - drop .strict() on the http block         -> the port rows
 *   - build the app sentence from `summary`    -> the lying-summary test
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  buildExtensionStatement,
  canonicalJson,
  deriveExtensionSlug,
  deriveReadback,
  EXTENSION_KIND,
  EXTENSION_MANIFEST_KINDS,
  EXTENSION_RUNTIMES,
  EXTENSION_SLUG_HASH_HEX,
  EXTENSION_SLUG_MAX_LENGTH,
  extensionManifestSchema,
  extensionStatementSchema,
  manifestSha256,
  parseExtensionManifest,
  type ExtensionManifest,
} from "./extension-manifest.js";

function validManifest(): ExtensionManifest {
  return {
    schemaVersion: 1,
    id: "word-count",
    name: "Word count",
    version: "0.1.0",
    kind: "extension",
    runtime: "node20",
    entrypoint: "dist/index.js",
    provides: {
      tools: [
        {
          name: "word_count",
          description: "Count the words in a piece of text.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          export: "run",
          classificationProposal: { requiresWrite: false, requiresConfirmation: false },
        },
      ],
      routineDrafts: [],
      proposedGrants: [],
    },
    resources: { memoryMb: 128, processes: 1 },
    egress: "none",
  };
}

type Json = Record<string, unknown>;
const clone = (): Json => JSON.parse(JSON.stringify(validManifest())) as Json;
const at = (o: Json, ...path: (string | number)[]): Json => {
  let cur: unknown = o;
  for (const k of path) cur = (cur as Record<string | number, unknown>)[k];
  return cur as Json;
};

describe("extension manifest schema (strict)", () => {
  it("accepts the reference manifest", () => {
    expect(extensionManifestSchema.safeParse(validManifest()).success).toBe(true);
  });

  it("accepts an optional free-text summary", () => {
    const m = { ...validManifest(), summary: "Counts words." };
    expect(extensionManifestSchema.safeParse(m).success).toBe(true);
  });

  const smuggled: Array<[string, (m: Json) => void]> = [
    ["an unknown top-level key", (m) => (m.network = "lan")],
    ["an unknown key in provides", (m) => (at(m, "provides").routines = [])],
    ["an unknown key in a tool", (m) => (at(m, "provides", "tools", 0).annotations = { readOnlyHint: true })],
    [
      "an unknown key in classificationProposal",
      (m) => (at(m, "provides", "tools", 0, "classificationProposal").denied = false),
    ],
    ["an unknown key in resources", (m) => (at(m, "resources").cpu = 2)],
    [
      "an unknown key in a routine draft",
      (m) =>
        (at(m, "provides").routineDrafts = [
          { slug: "daily", name: "Daily", steps: [{ tool: "x" }], cron: "* * * * *" },
        ]),
    ],
    [
      "an unknown key in a proposed grant",
      (m) =>
        (at(m, "provides").proposedGrants = [
          { role: "front-desk", domain: "files", level: "view", expires: "never" },
        ]),
    ],
    ["the legacy footprint block", (m) => (m.footprint = { memoryMb: 128 })],
  ];
  it.each(smuggled)("refuses %s", (_label, mutate) => {
    const m = clone();
    mutate(m);
    expect(extensionManifestSchema.safeParse(m).success).toBe(false);
  });

  const missing: Array<[string, (m: Json) => void]> = [
    ["kind", (m) => delete m.kind],
    ["runtime", (m) => delete m.runtime],
    ["entrypoint", (m) => delete m.entrypoint],
    ["egress", (m) => delete m.egress],
    ["resources", (m) => delete m.resources],
    ["provides.routineDrafts", (m) => delete at(m, "provides").routineDrafts],
    ["a tool's export", (m) => delete at(m, "provides", "tools", 0).export],
    [
      "a tool's classificationProposal",
      (m) => delete at(m, "provides", "tools", 0).classificationProposal,
    ],
  ];
  it.each(missing)("refuses a manifest missing %s", (_label, mutate) => {
    const m = clone();
    mutate(m);
    expect(extensionManifestSchema.safeParse(m).success).toBe(false);
  });

  it.each([["some"], ["lan"], ["internet"], [""], [null], [["none"]]])(
    "refuses egress %j (only the literal 'none' exists in v1)",
    (egress) => {
      const m = clone();
      m.egress = egress;
      expect(extensionManifestSchema.safeParse(m).success).toBe(false);
    },
  );

  it.each([
    ["/etc/passwd"],
    ["../outside.js"],
    ["dist/../../outside.js"],
    ["dist/./index.js"],
    ["./index.js"],
    [".hidden/index.js"],
    ["dist\\index.js"],
    ["C:/index.js"],
    [""],
    ["dist//index.js"],
    ["dist/"],
  ])("refuses entrypoint %j", (entrypoint) => {
    const m = clone();
    m.entrypoint = entrypoint;
    expect(extensionManifestSchema.safeParse(m).success).toBe(false);
  });

  it.each([["tool.py"], ["dist/index.js"], ["src/lib/main.mjs"], ["a..b/tool.py"]])(
    "accepts relative entrypoint %j",
    (entrypoint) => {
      const m = clone();
      m.entrypoint = entrypoint;
      expect(extensionManifestSchema.safeParse(m).success).toBe(true);
    },
  );

  it.each([["node18"], ["python311"], ["deno"], ["NODE20"]])(
    "refuses runtime %j",
    (runtime) => {
      const m = clone();
      m.runtime = runtime;
      expect(extensionManifestSchema.safeParse(m).success).toBe(false);
    },
  );

  it.each([["release"], ["connector"], ["Extension"]])("refuses kind %j", (kind) => {
    const m = clone();
    m.kind = kind;
    expect(extensionManifestSchema.safeParse(m).success).toBe(false);
  });

  it.each([["1.0"], ["v1.0.0"], ["1.0.0-"], ["1.0.0+build"], ["latest"], ["1.0.0-be ta"]])(
    "refuses version %j (the sandbox tags proposal/<semver>)",
    (version) => {
      const m = clone();
      m.version = version;
      expect(extensionManifestSchema.safeParse(m).success).toBe(false);
    },
  );

  it.each([["0.1.0"], ["10.20.30"], ["1.0.0-beta.1"]])("accepts version %j", (version) => {
    const m = clone();
    m.version = version;
    expect(extensionManifestSchema.safeParse(m).success).toBe(true);
  });

  it("refuses more than one process and a memory budget out of range", () => {
    for (const resources of [
      { memoryMb: 128, processes: 2 },
      { memoryMb: 0, processes: 1 },
      { memoryMb: 1.5, processes: 1 },
      { memoryMb: 100000, processes: 1 },
    ]) {
      const m = clone();
      m.resources = resources;
      expect(extensionManifestSchema.safeParse(m).success, JSON.stringify(resources)).toBe(false);
    }
  });

  it("refuses a tool inputSchema that is not an object schema", () => {
    const m = clone();
    at(m, "provides", "tools", 0).inputSchema = { type: "string" };
    expect(extensionManifestSchema.safeParse(m).success).toBe(false);
  });

  it("refuses an export that is not a plain identifier", () => {
    const m = clone();
    at(m, "provides", "tools", 0).export = "default; process.exit()";
    expect(extensionManifestSchema.safeParse(m).success).toBe(false);
  });
});

describe("parseExtensionManifest (schema + the checks JSON Schema cannot say)", () => {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8");

  it("parses valid manifest bytes", () => {
    const r = parseExtensionManifest(enc(validManifest()));
    expect(r.ok).toBe(true);
  });

  it("refuses bytes that are not JSON", () => {
    expect(parseExtensionManifest(Buffer.from("{nope", "utf8")).ok).toBe(false);
  });

  it("refuses two tools with the same name", () => {
    const m = validManifest();
    m.provides.tools.push({ ...m.provides.tools[0] });
    const r = parseExtensionManifest(enc(m));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/duplicate tool name/);
  });

  it("refuses two routine drafts with the same slug", () => {
    const m = validManifest();
    const draft = { slug: "daily", name: "Daily", steps: [{ tool: "word_count" }] };
    m.provides.routineDrafts.push(draft, { ...draft });
    expect(parseExtensionManifest(enc(m)).ok).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and emits no whitespace", () => {
    // MUTATION: JSON.stringify without the key sort -> not equal.
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("refuses values JSON cannot round-trip", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: 1n } as unknown as Record<string, unknown>)).toThrow();
  });
});

describe("the signed statement", () => {
  const manifestBytes = Buffer.from(JSON.stringify(validManifest()), "utf8");
  const fields = {
    extensionId: "word-count",
    workspaceId: "word-count",
    version: "0.1.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    tree: "89abcdef0123456789abcdef0123456789abcdef",
    manifestSha256: manifestSha256(manifestBytes),
  };

  it("is canonical JSON binding kind, usage, commit, tree and the manifest digest", () => {
    const bytes = buildExtensionStatement(fields);
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    expect(parsed).toEqual({
      kind: "extension",
      keyUsage: "extension",
      schemaVersion: 1,
      ...fields,
    });
    expect(bytes.toString("utf8")).toBe(canonicalJson(parsed));
    expect(extensionStatementSchema.safeParse(parsed).success).toBe(true);
  });

  it("manifestSha256 is the hex sha256 of the exact bytes", () => {
    expect(manifestSha256(manifestBytes)).toBe(
      createHash("sha256").update(manifestBytes).digest("hex"),
    );
  });

  it.each([
    ["commit", "abc"],
    ["tree", "Z".repeat(40)],
    ["manifestSha256", "0".repeat(63)],
    ["extensionId", "Has Spaces"],
    ["extensionId", "x".repeat(EXTENSION_SLUG_MAX_LENGTH + 1)],
    ["version", "1.0"],
  ])("refuses to build a statement with a bad %s", (key, value) => {
    expect(() => buildExtensionStatement({ ...fields, [key]: value })).toThrow();
  });

  it("the statement schema is strict too", () => {
    const parsed = JSON.parse(buildExtensionStatement(fields).toString("utf8")) as Json;
    expect(extensionStatementSchema.safeParse({ ...parsed, extra: 1 }).success).toBe(false);
    expect(extensionStatementSchema.safeParse({ ...parsed, kind: "release" }).success).toBe(false);
    expect(extensionStatementSchema.safeParse({ ...parsed, keyUsage: "release" }).success).toBe(
      false,
    );
  });
});

describe("deriveExtensionSlug (multiplexer server ids cap at 32 = 'ext-' + 28)", () => {
  it("keeps a short workspace id as is", () => {
    expect(deriveExtensionSlug("word-count")).toBe("word-count");
  });

  it("truncates a long id with a stable hash suffix, within the cap", () => {
    const long = "a-very-long-workspace-identifier-that-exceeds-the-cap";
    const slug = deriveExtensionSlug(long);
    expect(slug.length).toBeLessThanOrEqual(EXTENSION_SLUG_MAX_LENGTH);
    expect(slug).toMatch(new RegExp(`^[a-z0-9][a-z0-9-]*-[0-9a-f]{${EXTENSION_SLUG_HASH_HEX}}$`));
    expect(deriveExtensionSlug(long)).toBe(slug);
    expect(`ext-${slug}`).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
  });

  it("two long ids sharing a prefix get different slugs", () => {
    const base = "shared-prefix-that-is-long-enough-to-be-cut-";
    expect(deriveExtensionSlug(`${base}one`)).not.toBe(deriveExtensionSlug(`${base}two`));
  });

  it("the hash suffix is at least 40 bits", () => {
    // MUTATION: shrink the suffix back to 4 hex -> red.
    expect(EXTENSION_SLUG_HASH_HEX).toBeGreaterThanOrEqual(10);
  });

  it("a short id equal to another id's hashed slug does not take that slug", () => {
    // Review finding (WARP-2900 H1): with identity for short ids and
    // '<head>-<hex>' for long ones, a short id spelled like a long id's slug
    // mapped to the same slug, so two workspaces shared one extensionId.
    // MUTATION: return any id of <= 27 chars as is -> red.
    const long = "acme-front-desk-intake-automation-v2";
    const slugOfLong = deriveExtensionSlug(long);
    expect(slugOfLong.length).toBeLessThanOrEqual(EXTENSION_SLUG_MAX_LENGTH);
    expect(deriveExtensionSlug(slugOfLong)).not.toBe(slugOfLong);
  });

  it("a short id already shaped like a hashed slug is hashed too; other short ids keep their name", () => {
    const shaped = `word-count-${"a".repeat(EXTENSION_SLUG_HASH_HEX)}`;
    expect(shaped.length).toBeLessThanOrEqual(EXTENSION_SLUG_MAX_LENGTH);
    const slug = deriveExtensionSlug(shaped);
    expect(slug).not.toBe(shaped);
    expect(slug.length).toBeLessThanOrEqual(EXTENSION_SLUG_MAX_LENGTH);
    expect(deriveExtensionSlug("word-count-v2")).toBe("word-count-v2");
    const max = "x".repeat(EXTENSION_SLUG_MAX_LENGTH);
    expect(deriveExtensionSlug(max)).toBe(max);
  });

  it("refuses an id that is not a workspace id", () => {
    expect(() => deriveExtensionSlug("Bad_Id")).toThrow();
    expect(() => deriveExtensionSlug("")).toThrow();
  });
});

describe("deriveReadback (what the owner confirms at promote)", () => {
  it("counts from provides/resources/egress only", () => {
    const m = validManifest();
    m.provides.routineDrafts = [{ slug: "daily", name: "Daily", steps: [{ tool: "word_count" }] }];
    m.provides.proposedGrants = [{ role: "front-desk", domain: "files", level: "view" }];
    const r = deriveReadback(m);
    expect(r.tools.total).toBe(1);
    // Every extension tool imports as write + confirm until an owner reviews
    // it (WARP-2426), whatever the manifest proposes.
    expect(r.tools.startsAsWriteWithConfirmation).toBe(1);
    expect(r.tools.proposedReadOnly).toBe(1);
    expect(r.routineDrafts).toBe(1);
    expect(r.proposedGrants).toBe(1);
    expect(r.memoryMb).toBe(128);
    expect(r.egress).toBe("reaches nothing outside the box");
    expect(r.lines).toEqual([
      "1 tool, which starts as write with confirmation until you review it",
      "1 routine draft seeded",
      "1 access grant proposed",
      "reaches nothing outside the box",
      "memory budget 128 MB",
    ]);
  });

  it("ignores a summary and tool descriptions that lie", () => {
    // MUTATION: derive any count or line from summary/description -> red.
    const honest = validManifest();
    const lying: ExtensionManifest = {
      ...validManifest(),
      summary: "Read-only and harmless. Provides 0 tools. Reaches the internet: no.",
      provides: {
        ...validManifest().provides,
        tools: [
          {
            ...validManifest().provides.tools[0],
            description: "read-only, harmless, 0 writes, trusted by Warp Lab",
          },
        ],
      },
    };
    expect(deriveReadback(lying)).toEqual(deriveReadback(honest));
    const text = JSON.stringify(deriveReadback(lying));
    expect(text).not.toMatch(/harmless|trusted|internet/);
  });

  it("uses plural forms", () => {
    const m = validManifest();
    m.provides.tools.push({ ...m.provides.tools[0], name: "char_count" });
    expect(deriveReadback(m).lines[0]).toBe(
      "2 tools, which start as write with confirmation until you review them",
    );
    expect(deriveReadback(m).lines[1]).toBe("0 routine drafts seeded");
  });
});

// ─── hosted apps (WARP-3905, slice HA-1) ─────────────────────────────────

/** A node20 app: the entrypoint IS the HTTP server. */
function appManifest(): Json {
  return {
    schemaVersion: 1,
    id: "shop-dashboard",
    name: "Shop dashboard",
    version: "1.0.0",
    kind: "app",
    runtime: "node20",
    entrypoint: "dist/server.js",
    http: { health: "/healthz" },
    provides: {
      tools: [],
      routineDrafts: [],
      proposedGrants: [{ role: "member", domain: "app:shop-dashboard", level: "use" }],
    },
    resources: { memoryMb: 256, processes: 1 },
    egress: "none",
  };
}

/** A static app: the sandbox serves `http.dir` itself, no process. */
function staticAppManifest(): Json {
  const m = appManifest();
  m.runtime = "static";
  delete m.entrypoint;
  m.http = { health: "/", dir: "dist", spa: true };
  return m;
}

/** The dot-joined issue paths the schema reports, or null when it accepts. */
function issuePaths(m: unknown): string[] | null {
  const r = extensionManifestSchema.safeParse(m);
  return r.success ? null : r.error.issues.map((i) => i.path.join("."));
}

describe("kind and runtime vocabulary", () => {
  it("names the manifest kinds apart from the statement kind", () => {
    // The signed statement's kind stays "extension" for every manifest kind:
    // the box key signs one statement shape (extension-verify.ts).
    expect([...EXTENSION_MANIFEST_KINDS]).toEqual(["extension", "app"]);
    expect(EXTENSION_KIND).toBe("extension");
    expect([...EXTENSION_RUNTIMES]).toEqual(["node20", "python312", "static"]);
  });
});

describe("hosted apps: the manifest rules (one test per rule)", () => {
  it("accepts a node20 app, a python312 app, and a static app", () => {
    expect(issuePaths(appManifest())).toBeNull();
    const py = appManifest();
    py.runtime = "python312";
    py.entrypoint = "server.py";
    expect(issuePaths(py)).toBeNull();
    expect(issuePaths(staticAppManifest())).toBeNull();
    const rootDir = staticAppManifest();
    rootDir.http = { health: "/", dir: "." };
    expect(issuePaths(rootDir)).toBeNull();
  });

  it("an app without http is refused", () => {
    // MUTATION: drop the 'kind app requires http' rule -> green.
    const m = appManifest();
    delete m.http;
    expect(issuePaths(m)).toContain("http");
  });

  it("an extension with http is refused", () => {
    // MUTATION: drop the 'kind extension refuses http' rule -> green.
    const m = clone();
    m.http = { health: "/healthz" };
    expect(issuePaths(m)).toContain("http");
  });

  it("a static app with an entrypoint is refused", () => {
    // MUTATION: drop 'static refuses entrypoint' -> green.
    const m = staticAppManifest();
    m.entrypoint = "dist/server.js";
    expect(issuePaths(m)).toContain("entrypoint");
  });

  it("a static app without http.dir is refused", () => {
    // MUTATION: drop 'static requires http.dir' -> green.
    const noDir = staticAppManifest();
    noDir.http = { health: "/", spa: true };
    expect(issuePaths(noDir)).toContain("http.dir");
    // Without http at all the app rule fires; the static rule must not hide
    // behind it, and the manifest is refused either way.
    const noHttp = staticAppManifest();
    delete noHttp.http;
    expect(issuePaths(noHttp)).not.toBeNull();
  });

  it("static is only valid for an app", () => {
    // MUTATION: allow runtime static on kind extension -> green.
    const m = clone();
    m.runtime = "static";
    delete m.entrypoint;
    expect(issuePaths(m)).toContain("runtime");
  });

  it.each([["node20"], ["python312"]])(
    "a %s app without an entrypoint is refused (the entrypoint is the server)",
    (runtime) => {
      const m = appManifest();
      m.runtime = runtime;
      delete m.entrypoint;
      expect(issuePaths(m)).toContain("entrypoint");
    },
  );

  it("an extension without an entrypoint is still refused", () => {
    const m = clone();
    delete m.entrypoint;
    expect(issuePaths(m)).toContain("entrypoint");
  });

  it("http.dir and http.spa are static only", () => {
    const withDir = appManifest();
    withDir.http = { health: "/healthz", dir: "public" };
    expect(issuePaths(withDir)).toContain("http.dir");
    const withSpa = appManifest();
    withSpa.http = { health: "/healthz", spa: true };
    expect(issuePaths(withSpa)).toContain("http.spa");
  });

  it.each([
    ["../outside"],
    ["dist/../outside"],
    ["dist/.."],
    [".."],
    ["a..b"],
    ["/abs"],
    ["/"],
    ["./dist"],
    ["dist/"],
    ["dist//site"],
    ["dist\\site"],
    ["C:/site"],
    [""],
    ["x".repeat(257)],
  ])("refuses http.dir %j", (dir) => {
    const m = staticAppManifest();
    (m.http as Json).dir = dir;
    expect(issuePaths(m)).toContain("http.dir");
  });

  it.each([["."], ["dist"], ["public/site"], ["_site"], ["build-1.2"]])("accepts http.dir %j", (dir) => {
    const m = staticAppManifest();
    (m.http as Json).dir = dir;
    expect(issuePaths(m)).toBeNull();
  });

  it.each([
    ["healthz"],
    ["../healthz"],
    ["/../healthz"],
    ["/a/../healthz"],
    ["/healthz/.."],
    ["/a..b"],
    ["/health z"],
    ["/healthz?full=1"],
    ["/healthz#x"],
    ["/healthz\r\nHost: evil"],
    ["/health\\z"],
    ["http://evil.example/healthz"],
    [""],
    ["/".padEnd(257, "a")],
  ])("refuses http.health %j", (health) => {
    const m = appManifest();
    (m.http as Json).health = health;
    expect(issuePaths(m)).toContain("http.health");
  });

  it.each([["/"], ["/healthz"], ["/api/v1/health"], ["/health.json"], ["/".padEnd(256, "a")]])(
    "accepts http.health %j",
    (health) => {
      const m = appManifest();
      (m.http as Json).health = health;
      expect(issuePaths(m)).toBeNull();
    },
  );

  it("http.health is required and spa must be a boolean", () => {
    const noHealth = appManifest();
    noHealth.http = {};
    expect(issuePaths(noHealth)).toContain("http.health");
    const badSpa = staticAppManifest();
    (badSpa.http as Json).spa = "yes";
    expect(issuePaths(badSpa)).toContain("http.spa");
  });

  it("an app's provides.tools must be empty in v1", () => {
    // MUTATION: drop 'an app provides no tools' -> green.
    const m = appManifest();
    at(m, "provides").tools = at(clone(), "provides").tools;
    expect(issuePaths(m)).toContain("provides.tools");
  });

  it("an extension must still provide at least one tool", () => {
    // The min-1 moved from the array to a kind-aware rule; it must survive.
    const m = clone();
    at(m, "provides").tools = [];
    expect(issuePaths(m)).toContain("provides.tools");
  });

  it("an app may still seed routine drafts and propose grants", () => {
    const m = appManifest();
    at(m, "provides").routineDrafts = [{ slug: "nightly", name: "Nightly", steps: [{ tool: "x" }] }];
    expect(issuePaths(m)).toBeNull();
  });

  it.each([
    ["the top level", (m: Json) => (m.port = 8080)],
    ["http", (m: Json) => ((m.http as Json).port = 8080)],
    ["resources", (m: Json) => ((m.resources as Json).port = 8080)],
    ["provides", (m: Json) => ((m.provides as Json).port = 8080)],
    ["a proposed grant", (m: Json) => ((m.provides as Json).proposedGrants = [{ role: "r", domain: "d", port: 1 }])],
  ])("a port key in %s is refused (the box assigns the port)", (_where, mutate) => {
    // MUTATION: drop .strict() on the http block (or any level) -> green.
    const m = appManifest();
    mutate(m);
    expect(issuePaths(m)).not.toBeNull();
    const s = staticAppManifest();
    mutate(s);
    expect(issuePaths(s)).not.toBeNull();
  });

  it("refuses an unknown key in http", () => {
    const m = appManifest();
    (m.http as Json).host = "0.0.0.0";
    expect(issuePaths(m)).not.toBeNull();
  });

  it.each([["some"], ["lan"], ["internet"], [null]])(
    "an app's egress stays the literal none: refuses %j",
    (egress) => {
      const m = appManifest();
      m.egress = egress;
      expect(issuePaths(m)).toContain("egress");
    },
  );

  it("still refuses a kind that is neither extension nor app", () => {
    const m = appManifest();
    m.kind = "service";
    expect(issuePaths(m)).toContain("kind");
  });

  it("an app keeps the one-process, memory-range resources rule", () => {
    const m = staticAppManifest();
    (m.resources as Json).processes = 2;
    expect(issuePaths(m)).toContain("resources.processes");
    const low = appManifest();
    (low.resources as Json).memoryMb = 8;
    expect(issuePaths(low)).toContain("resources.memoryMb");
  });
});

describe("parseExtensionManifest with apps", () => {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8");

  it("parses app bytes and keeps the http block", () => {
    const r = parseExtensionManifest(enc(staticAppManifest()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.kind).toBe("app");
      expect(r.manifest.http).toEqual({ health: "/", dir: "dist", spa: true });
    }
  });

  it("names the rule it broke", () => {
    const m = appManifest();
    delete m.http;
    const r = parseExtensionManifest(enc(m));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/http/);
  });

  it("the signed statement is unchanged for an app, and the digest covers the new fields", () => {
    const base = enc(appManifest());
    const moved = appManifest();
    (moved.http as Json).health = "/ready";
    const a = JSON.parse(
      buildExtensionStatement({
        extensionId: "shop-dashboard",
        workspaceId: "shop-dashboard",
        version: "1.0.0",
        commit: "0123456789abcdef0123456789abcdef01234567",
        tree: "89abcdef0123456789abcdef0123456789abcdef",
        manifestSha256: manifestSha256(base),
      }).toString("utf8"),
    ) as Json;
    // The same statement shape an extension gets: kind "extension", no new key.
    expect(Object.keys(a).sort()).toEqual([
      "commit",
      "extensionId",
      "keyUsage",
      "kind",
      "manifestSha256",
      "schemaVersion",
      "tree",
      "version",
      "workspaceId",
    ]);
    expect(a.kind).toBe("extension");
    expect(manifestSha256(enc(moved))).not.toBe(manifestSha256(base));
  });
});

describe("deriveReadback for apps (what the owner confirms at promote)", () => {
  const parseApp = (m: Json): ExtensionManifest => {
    const r = extensionManifestSchema.safeParse(m);
    if (!r.success) throw new Error(r.error.message);
    return r.data;
  };

  it("says what a node20 app is, from kind, runtime, resources, egress and grants", () => {
    const r = deriveReadback(parseApp(appManifest()));
    expect(r.kind).toBe("app");
    expect(r.runtime).toBe("node20");
    expect(r.lines[0]).toBe(
      "Serves a web app · runtime node20 · one process · 256 MB · reaches nothing outside the box · visible to: owner, admin (+ proposed: member)",
    );
    expect(r.lines).toEqual([r.lines[0], "0 routine drafts seeded", "1 access grant proposed"]);
    expect(r.tools).toEqual({ total: 0, startsAsWriteWithConfirmation: 0, proposedReadOnly: 0 });
    expect(r.memoryMb).toBe(256);
    expect(r.egress).toBe("reaches nothing outside the box");
  });

  it("a static app has no process", () => {
    // MUTATION: say 'one process' for static -> red.
    const r = deriveReadback(parseApp(staticAppManifest()));
    expect(r.runtime).toBe("static");
    expect(r.memoryMb).toBe(0);
    expect(r.lines[0]).toContain("no process");
    expect(r.lines[0]).not.toContain("one process");
    expect(r.lines[0]).not.toMatch(/\d+ MB/);
    expect(r.lines[0]).toBe(
      "Serves a web app · runtime static · no process · reaches nothing outside the box · visible to: owner, admin (+ proposed: member)",
    );
  });

  it("an app with no proposed grants is visible to the owner and admins only", () => {
    const m = appManifest();
    at(m, "provides").proposedGrants = [];
    expect(deriveReadback(parseApp(m)).lines[0]).toBe(
      "Serves a web app · runtime node20 · one process · 256 MB · reaches nothing outside the box · visible to: owner, admin",
    );
  });

  it("lists each proposed role once, in order, and never repeats owner or admin", () => {
    const m = appManifest();
    at(m, "provides").proposedGrants = [
      { role: "front-desk", domain: "app:shop-dashboard", level: "view" },
      { role: "admin", domain: "app:shop-dashboard", level: "use" },
      { role: "member", domain: "app:shop-dashboard", level: "use" },
      { role: "front-desk", domain: "files" },
    ];
    const r = deriveReadback(parseApp(m));
    expect(r.lines[0]).toContain("visible to: owner, admin (+ proposed: front-desk, member)");
    expect(r.lines[2]).toBe("4 access grants proposed");
  });

  it("ignores a summary that lies about the app", () => {
    // MUTATION: build any part of the sentence from summary -> red.
    const honest = appManifest();
    const lying = { ...appManifest(), summary: "Static page. No process. Reaches the internet: yes. Visible to everyone." };
    expect(deriveReadback(parseApp(lying))).toEqual(deriveReadback(parseApp(honest)));
    expect(JSON.stringify(deriveReadback(parseApp(lying)))).not.toMatch(/Static page|internet|everyone/);
    // And the other way: a static app whose summary claims a server.
    const staticLying = { ...staticAppManifest(), summary: "A Node server that listens on port 3000 and uses 4 GB." };
    const out = deriveReadback(parseApp(staticLying));
    expect(out.lines[0]).toContain("no process");
    expect(JSON.stringify(out)).not.toMatch(/Node server|3000|4 GB/);
  });

  it("an extension's readback is unchanged and now carries its kind and runtime", () => {
    const r = deriveReadback(validManifest());
    expect(r.kind).toBe("extension");
    expect(r.runtime).toBe("node20");
    expect(r.lines).toEqual([
      "1 tool, which starts as write with confirmation until you review it",
      "0 routine drafts seeded",
      "0 access grants proposed",
      "reaches nothing outside the box",
      "memory budget 128 MB",
    ]);
  });
});
