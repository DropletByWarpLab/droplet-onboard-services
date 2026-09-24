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
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  buildExtensionStatement,
  canonicalJson,
  deriveExtensionSlug,
  deriveReadback,
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
