/**
 * WARP-2900 (ADR-056 slice H1): docs/schemas/extension-manifest.schema.json
 * and the zod `extensionManifestSchema` must agree.
 *
 * The JSON Schema is what a non-TypeScript reader (the sandbox, a template
 * author, a reviewer) sees; the zod schema is what the orchestrator enforces.
 * One corpus runs through both, and every case must get the same verdict
 * from each AND the verdict the corpus expects. A key added to one schema
 * and not the other turns a row red.
 *
 * Out of scope on purpose: duplicate tool names / routine slugs, which JSON
 * Schema cannot express and parseExtensionManifest checks separately.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { extensionManifestSchema } from "./extension-manifest.js";
import { REPO_ROOT } from "../__tests__/helpers/test-paths.js";

const SCHEMA_PATH = path.join(REPO_ROOT, "docs", "schemas", "extension-manifest.schema.json");

type Json = Record<string, unknown>;

function base(): Json {
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
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
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

const tool0 = (m: Json): Json =>
  ((m.provides as Json).tools as Json[])[0];

/** [label, mutate, expected-valid] */
const CORPUS: Array<[string, (m: Json) => void, boolean]> = [
  ["the reference manifest", () => {}, true],
  ["with a summary", (m) => (m.summary = "Counts words."), true],
  ["python runtime", (m) => ((m.runtime = "python312"), (m.entrypoint = "tool.py")), true],
  ["prerelease version", (m) => (m.version = "1.2.3-rc.1"), true],
  [
    "a routine draft and a grant",
    (m) => {
      const p = m.provides as Json;
      p.routineDrafts = [
        { slug: "daily", name: "Daily", description: "d", category: "ops", steps: [{ tool: "word_count" }] },
      ];
      p.proposedGrants = [{ role: "front-desk", domain: "files", level: "use" }];
    },
    true,
  ],
  ["a grant without a level", (m) => ((m.provides as Json).proposedGrants = [{ role: "r", domain: "files" }]), true],
  ["an open inputSchema vocabulary", (m) => (tool0(m).inputSchema = { type: "object", additionalProperties: false, $comment: "x" }), true],
  ["memory at the floor", (m) => ((m.resources as Json).memoryMb = 16), true],
  ["memory at the ceiling", (m) => ((m.resources as Json).memoryMb = 4096), true],

  ["an unknown top-level key", (m) => (m.network = "lan"), false],
  ["an unknown provides key", (m) => ((m.provides as Json).routines = []), false],
  ["an unknown tool key", (m) => (tool0(m).annotations = { readOnlyHint: true }), false],
  ["an unknown classification key", (m) => ((tool0(m).classificationProposal as Json).denied = true), false],
  ["an unknown resources key", (m) => ((m.resources as Json).cpu = 1), false],
  ["an unknown routine-draft key", (m) => ((m.provides as Json).routineDrafts = [{ slug: "a", name: "A", steps: [{}], cron: "x" }]), false],
  ["an unknown grant key", (m) => ((m.provides as Json).proposedGrants = [{ role: "r", domain: "d", x: 1 }]), false],
  ["legacy footprint", (m) => (m.footprint = { memoryMb: 1 }), false],
  ["missing kind", (m) => delete m.kind, false],
  ["missing runtime", (m) => delete m.runtime, false],
  ["missing egress", (m) => delete m.egress, false],
  ["missing routineDrafts", (m) => delete (m.provides as Json).routineDrafts, false],
  ["missing export", (m) => delete tool0(m).export, false],
  ["egress lan", (m) => (m.egress = "lan"), false],
  ["egress some", (m) => (m.egress = "some"), false],
  ["kind release", (m) => (m.kind = "release"), false],
  ["schemaVersion 2", (m) => (m.schemaVersion = 2), false],
  ["runtime node18", (m) => (m.runtime = "node18"), false],
  ["absolute entrypoint", (m) => (m.entrypoint = "/etc/passwd"), false],
  ["dot-dot entrypoint", (m) => (m.entrypoint = "dist/../../x.js"), false],
  ["dot entrypoint", (m) => (m.entrypoint = "./index.js"), false],
  ["backslash entrypoint", (m) => (m.entrypoint = "dist\\index.js"), false],
  ["empty-segment entrypoint", (m) => (m.entrypoint = "dist//index.js"), false],
  ["bad version", (m) => (m.version = "v1.0.0"), false],
  ["bad id", (m) => (m.id = "Word_Count"), false],
  ["two processes", (m) => ((m.resources as Json).processes = 2), false],
  ["fractional memory", (m) => ((m.resources as Json).memoryMb = 1.5), false],
  ["memory below the floor", (m) => ((m.resources as Json).memoryMb = 15), false],
  ["memory above the ceiling", (m) => ((m.resources as Json).memoryMb = 4097), false],
  ["no tools", (m) => ((m.provides as Json).tools = []), false],
  ["non-object inputSchema", (m) => (tool0(m).inputSchema = { type: "string" }), false],
  ["export with punctuation", (m) => (tool0(m).export = "run()"), false],
  ["tool name with a dash", (m) => (tool0(m).name = "word-count"), false],
  ["grant level admin", (m) => ((m.provides as Json).proposedGrants = [{ role: "r", domain: "d", level: "admin" }]), false],
  ["routine draft without steps", (m) => ((m.provides as Json).routineDrafts = [{ slug: "a", name: "A", steps: [] }]), false],
  ["summary not a string", (m) => (m.summary = 1), false],
];

describe("extension manifest: JSON Schema <-> zod drift (WARP-2900)", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as object;
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);

  it.each(CORPUS)("%s", (_label, mutate, expected) => {
    const m = base();
    mutate(m);
    const zodOk = extensionManifestSchema.safeParse(m).success;
    const jsonOk = validate(m) as boolean;
    expect({ zod: zodOk, jsonSchema: jsonOk }).toEqual({ zod: expected, jsonSchema: expected });
  });

  it("names exactly the same top-level keys", () => {
    const jsonKeys = Object.keys((schema as { properties: Json }).properties).sort();
    const zodKeys = Object.keys(extensionManifestSchema.shape).sort();
    expect(jsonKeys).toEqual(zodKeys);
  });
});
