/**
 * WARP-2898 (ADR-056 slice K1): the extension compose fragment contract.
 *
 * Four layers, each tested on its own so a mutation to any one of them turns
 * its own rows red (the mutation matrix is in the PR body):
 *
 *   1. the container-block schema: one refusal per compose key WARP-2924
 *      lists, plus limits, environment and image refusals;
 *   2. the serializer: a golden output, and a pass-through matrix proving no
 *      hostile string in any input field reaches the written YAML;
 *   3. the shape re-parse: YAML adversaries (duplicate keys, anchors, merge
 *      keys, tags, several documents) and hand-edited overrides that carry a
 *      forbidden key or a widened value for a key the serializer emits;
 *   4. the constants: ceilings stay inside H1's manifest bounds.
 *
 * The AC key list below is a LITERAL copied from WARP-2924, not imported from
 * the module: deleting an entry from FORBIDDEN_SERVICE_KEYS must turn its row
 * red, which an imported list could never do.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { EXTENSION_MEMORY_MB_MAX, EXTENSION_MEMORY_MB_MIN } from "../extension-manifest.js";
import { REPO_ROOT } from "../../__tests__/helpers/test-paths.js";
import {
  EXT_MAX_CPUS,
  EXT_MAX_MEMORY_MB,
  EXT_MAX_PIDS,
  EXT_MIN_MEMORY_MB,
  EXT_OVERRIDE_MAX_BYTES,
  ExtensionFragmentError,
  FORBIDDEN_SERVICE_KEYS,
  REGISTRY_HOST,
  assertExtensionOverrideShape,
  parseExtensionContainer,
  renderExtensionOverride,
  type ExtensionFragmentRefusal,
} from "./extension-fragment.js";

// ─── fixtures ────────────────────────────────────────────────────────────

const ID = "word-count";
const DIGEST = "a".repeat(64);
const IMAGE = `${REGISTRY_HOST}/ext/${ID}@sha256:${DIGEST}`;

/** The real base service names: the fragment must coexist with them. */
const BASE: string[] = Object.keys(
  (parseYaml(readFileSync(path.join(REPO_ROOT, "docker", "docker-compose.yml"), "utf8")) as {
    services: Record<string, unknown>;
  }).services,
);

function validContainer(): Record<string, unknown> {
  return {
    image: IMAGE,
    environment: { LOG_LEVEL: "info", NODE_ENV: "production" },
    limits: { memoryMb: 256, cpus: 0.5, pids: 64 },
  };
}

function render(container: unknown = validContainer(), extensionId = ID): string {
  return renderExtensionOverride({ extensionId, target: "release", container, baseServices: BASE });
}

const GOLDEN = [
  "# WARP-2898 — GENERATED compose override (release) for extension",
  "# word-count. Written only by update-agent/extension-fragment.ts from a",
  "# verified manifest; every key below is fixed by the platform or bounded by",
  "# its schema. DO NOT EDIT.",
  "services:",
  "  ext-word-count:",
  `    image: ${IMAGE}`,
  "    environment:",
  "      LOG_LEVEL: info",
  "      NODE_ENV: production",
  "    mem_limit: 256m",
  "    cpus: 0.50",
  "    pids_limit: 64",
  "    networks:",
  "      - droplet-internal",
  "    read_only: true",
  "    cap_drop:",
  "      - ALL",
  "    security_opt:",
  "      - no-new-privileges:true",
  "    volumes:",
  "      - ext-word-count-data:/data",
  "volumes:",
  "  ext-word-count-data:",
  "",
].join("\n");

/** Assert `fn` throws an ExtensionFragmentError with this code (and message). */
function expectRefusal(fn: () => unknown, code: ExtensionFragmentRefusal, message?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected a refusal, got none").toBeInstanceOf(ExtensionFragmentError);
  const e = caught as ExtensionFragmentError;
  expect(e.code, e.message).toBe(code);
  if (message) expect(e.message).toMatch(message);
}

/** The golden text with one exact substring replaced (which must exist). */
function tamper(from: string, to: string): string {
  expect(GOLDEN.includes(from), `fixture drift: ${JSON.stringify(from)}`).toBe(true);
  return GOLDEN.replace(from, to);
}

const shape = (text: string, extensionId = ID, baseServices: readonly string[] = BASE): void =>
  assertExtensionOverrideShape(text, { extensionId, baseServices });

// ─── the WARP-2924 key list (literal on purpose) ─────────────────────────

/** Every key WARP-2924 names, with a hostile value an author might send. */
const AC_FORBIDDEN: Array<[string, unknown]> = [
  ["ports", ["0.0.0.0:8080:8080"]],
  ["volumes", ["/:/host"]],
  ["privileged", true],
  ["network_mode", "host"],
  ["devices", ["/dev/mem:/dev/mem"]],
  ["cap_add", ["SYS_ADMIN"]],
  ["pid", "host"],
  ["ipc", "host"],
  ["sysctls", { "net.ipv4.ip_forward": 1 }],
  ["extra_hosts", ["db:10.0.0.1"]],
  ["userns_mode", "host"],
  ["cgroup_parent", "/"],
  ["ulimits", { nofile: 1048576 }],
  ["tmpfs", ["/tmp:exec"]],
  ["env_file", ["/etc/droplet/.env"]],
  ["secrets", ["postgres_password"]],
  ["configs", ["nginx"]],
  ["labels", { "com.docker.compose.project": "droplet" }],
  ["build", { context: "/" }],
  ["command", ["sh", "-c", "id"]],
  ["entrypoint", ["/bin/sh"]],
  ["depends_on", ["db"]],
  ["container_name", "droplet-orchestrator"],
  ["read_only", false],
  ["cap_drop", []],
  ["networks", ["default"]],
  ["security_opt", ["seccomp=unconfined"]],
];

// ═════════════════════════════════════════════════════════════════════════
// 1. the container-block schema
// ═════════════════════════════════════════════════════════════════════════

describe("extension container block: forbidden compose keys (WARP-2924 list)", () => {
  it.each(AC_FORBIDDEN)("refuses container.%s by name, with its reason", (key, value) => {
    const c = { ...validContainer(), [key]: value };
    expectRefusal(() => parseExtensionContainer(c), "forbidden_key", new RegExp(`container\\.${key} is refused: .+`));
  });

  it("refuses an unknown top-level key with a self-describing error", () => {
    const c = { ...validContainer(), stdin_open: true };
    expectRefusal(() => parseExtensionContainer(c), "container_invalid", /container: Unrecognized key\(s\) in object: 'stdin_open'/);
  });

  it("refuses an unknown nested key under limits, naming the path", () => {
    const c = validContainer();
    (c.limits as Record<string, unknown>).shm_size = "1g";
    expectRefusal(() => parseExtensionContainer(c), "container_invalid", /container\.limits: Unrecognized key\(s\) in object: 'shm_size'/);
  });

  it("refuses a non-object container", () => {
    for (const bad of [null, "privileged: true", ["image"], 7]) {
      expectRefusal(() => parseExtensionContainer(bad), "container_invalid");
    }
  });

  it("accepts the valid block and returns the typed container", () => {
    expect(parseExtensionContainer(validContainer())).toEqual(validContainer());
  });

  it("environment is optional", () => {
    const c = validContainer();
    delete c.environment;
    expect(parseExtensionContainer(c).environment).toBeUndefined();
  });
});

describe("extension container block: limits are mandatory and bounded", () => {
  it.each(["memoryMb", "cpus", "pids"])("refuses a missing limits.%s", (key) => {
    const c = validContainer();
    delete (c.limits as Record<string, unknown>)[key];
    expectRefusal(() => parseExtensionContainer(c), "container_invalid", new RegExp(`container\\.limits\\.${key}: Required`));
  });

  it("refuses a missing limits block", () => {
    const c = validContainer();
    delete c.limits;
    expectRefusal(() => parseExtensionContainer(c), "container_invalid", /container\.limits: Required/);
  });

  it.each([
    ["memoryMb", EXT_MAX_MEMORY_MB + 1],
    ["cpus", EXT_MAX_CPUS + 0.01],
    ["pids", EXT_MAX_PIDS + 1],
  ])("refuses limits.%s above its EXT_MAX_* ceiling (%s)", (key, value) => {
    const c = validContainer();
    (c.limits as Record<string, unknown>)[key] = value;
    expectRefusal(() => parseExtensionContainer(c), "container_invalid", new RegExp(`container\\.limits\\.${key}`));
  });

  it.each([
    ["memoryMb", 0],
    ["memoryMb", EXT_MIN_MEMORY_MB - 1],
    ["cpus", 0],
    ["cpus", -1],
    ["pids", 0],
    ["pids", -1],
  ])("refuses limits.%s = %s (0 or below is unlimited to docker)", (key, value) => {
    const c = validContainer();
    (c.limits as Record<string, unknown>)[key] = value;
    expectRefusal(() => parseExtensionContainer(c), "container_invalid", new RegExp(`container\\.limits\\.${key}`));
  });

  it("refuses non-integer memory and pids, and cpus finer than 0.01", () => {
    for (const [key, value] of [["memoryMb", 256.5], ["pids", 64.5], ["cpus", 0.333]] as const) {
      const c = validContainer();
      (c.limits as Record<string, unknown>)[key] = value;
      expectRefusal(() => parseExtensionContainer(c), "container_invalid", new RegExp(`container\\.limits\\.${key}`));
    }
  });

  it("refuses a limit given as a string", () => {
    const c = validContainer();
    (c.limits as Record<string, unknown>).memoryMb = "256m";
    expectRefusal(() => parseExtensionContainer(c), "container_invalid");
  });
});

describe("extension container block: environment is allowlisted and literal", () => {
  it.each(["NODE_OPTIONS", "LD_PRELOAD", "PYTHONPATH", "SERVICE_TOKEN_EXT_WORD_COUNT", "PATH"])(
    "refuses the off-allowlist key %s",
    (key) => {
      const c = { ...validContainer(), environment: { [key]: "x" } };
      expectRefusal(() => parseExtensionContainer(c), "container_invalid", new RegExp(`container\\.environment\\.${key}`));
    },
  );

  it.each([
    ["${HOST_ROOT}", "compose interpolation"],
    ["$HOME", "bare interpolation"],
    ["info\n    privileged: true", "newline injection"],
    ["a b", "whitespace"],
    ['"quoted"', "quote"],
    ["x#comment", "comment"],
    ["[a]", "flow sequence"],
    ["{a: b}", "flow mapping"],
    ["", "empty (YAML null)"],
    ["1", "number"],
    ["2026-09-23", "timestamp"],
    ["~", "YAML null"],
    ["true", "YAML bool"],
    ["Yes", "YAML 1.1 bool"],
    ["off", "YAML 1.1 bool"],
    ["null", "YAML null word"],
    [`a${"b".repeat(128)}`, "over the length cap"],
  ])("refuses the environment value %j (%s)", (value) => {
    const c = { ...validContainer(), environment: { LOG_LEVEL: value } };
    expectRefusal(() => parseExtensionContainer(c), "container_invalid", /container\.environment\.LOG_LEVEL/);
  });

  it("accepts letter-initial literals such as a TZ name", () => {
    const c = { ...validContainer(), environment: { TZ: "Europe/Paris", LOG_LEVEL: "debug" } };
    expect(parseExtensionContainer(c).environment).toEqual({ TZ: "Europe/Paris", LOG_LEVEL: "debug" });
  });
});

describe("extension container block: the image is the on-box, digest-pinned image", () => {
  it.each([
    [`${REGISTRY_HOST}/ext/${ID}:latest`, "mutable tag"],
    [`${REGISTRY_HOST}/ext/${ID}:0.1.0@sha256:${DIGEST}`, "tag + digest"],
    [`registry.example/ext/${ID}@sha256:${DIGEST}`, "foreign registry host"],
    [`127.0.0.1:5001/ext/${ID}@sha256:${DIGEST}`, "another loopback port"],
    [`sandbox:5000/ext/${ID}@sha256:${DIGEST}`, "compose-DNS host"],
    [`ext/${ID}@sha256:${DIGEST}`, "no registry host (would resolve to a public registry)"],
    [`${REGISTRY_HOST}/library/${ID}@sha256:${DIGEST}`, "outside the ext/ namespace"],
    [`${REGISTRY_HOST}/ext/${ID}@sha256:${"A".repeat(64)}`, "uppercase digest"],
    [`${REGISTRY_HOST}/ext/${ID}@sha256:${"a".repeat(63)}`, "short digest"],
    [`${REGISTRY_HOST}/ext/${ID}@sha512:${"a".repeat(128)}`, "another digest algorithm"],
    [`${REGISTRY_HOST}/ext/${ID}@sha256:${DIGEST}\n    privileged: true`, "newline injection"],
  ])("refuses %j (%s)", (image) => {
    const c = { ...validContainer(), image };
    expectRefusal(() => parseExtensionContainer(c), "container_invalid", /container\.image/);
  });

  it("refuses at render another extension's image (the image is bound to the id)", () => {
    const c = { ...validContainer(), image: `${REGISTRY_HOST}/ext/other@sha256:${DIGEST}` };
    expectRefusal(() => render(c), "image_invalid", /another extension's image/);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. the serializer
// ═════════════════════════════════════════════════════════════════════════

describe("renderExtensionOverride: the emitted override", () => {
  it("emits exactly the golden override", () => {
    expect(render()).toBe(GOLDEN);
  });

  it("the golden override passes its own shape check against the real base services", () => {
    expect(() => shape(GOLDEN)).not.toThrow();
    // Non-vacuous: the real base file was read.
    expect(BASE).toEqual(expect.arrayContaining(["orchestrator", "sandbox"]));
  });

  it("re-parses its own output: a base that already defines ext-<id> is refused at render", () => {
    // Only the shape check knows the base set, so this refusal proves render
    // runs it before returning.
    expectRefusal(
      () => renderExtensionOverride({ extensionId: ID, target: "release", container: validContainer(), baseServices: [...BASE, "ext-word-count"] }),
      "shape_invalid",
      /is a base service/,
    );
  });

  it("omits the environment block when there is none", () => {
    const c = validContainer();
    delete c.environment;
    const out = render(c);
    expect(out).not.toMatch(/environment/);
    expect(() => shape(out)).not.toThrow();
  });

  it("labels the previous target in the header only", () => {
    const out = renderExtensionOverride({ extensionId: ID, target: "previous", container: validContainer(), baseServices: BASE });
    expect(out.split("\n")[0]).toMatch(/\(previous\)/);
    expect(out.split("\n").slice(4)).toEqual(GOLDEN.split("\n").slice(4));
  });

  it.each(["release; privileged: true", "", "latest"])("refuses the target %j", (target) => {
    expectRefusal(
      () => renderExtensionOverride({ extensionId: ID, target: target as "release", container: validContainer(), baseServices: BASE }),
      "shape_invalid",
      /target must be release or previous/,
    );
  });

  it.each([
    "Word-Count",
    "../orchestrator",
    "a b",
    "",
    "-leading",
    "x".repeat(28),
    "word_count",
    "word-count\n    privileged: true",
  ])("refuses the extension id %j", (id) => {
    expectRefusal(() => render(validContainer(), id), "extension_id_invalid");
  });

  it("ext-<id> satisfies the runner's SERVICE_NAME_RE and the multiplexer's 32-char cap", () => {
    const longest = "a".repeat(27);
    const out = render({ ...validContainer(), image: `${REGISTRY_HOST}/ext/${longest}@sha256:${DIGEST}` }, longest);
    const name = `ext-${longest}`;
    expect(out).toContain(`  ${name}:`);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(name.length).toBeLessThanOrEqual(32);
  });
});

describe("renderExtensionOverride: nothing hostile passes through (refuse, never quote)", () => {
  const PAYLOADS = [
    "privileged: true",
    "\n    privileged: true",
    "x\n    privileged: true",
    "${HOST_ROOT}",
    "x\nservices:\n  orchestrator:\n    privileged: true",
    "x #\n    network_mode: host",
    'x"\n    privileged: true',
  ];
  const MARKERS = [/privileged/, /\$\{/, /network_mode/, /orchestrator/];

  /** Every string slot a manifest author controls, with the payload in it. */
  const SLOTS: Array<[string, (p: string) => { container: Record<string, unknown>; id: string }]> = [
    ["image", (p) => ({ container: { ...validContainer(), image: `${IMAGE}${p}` }, id: ID })],
    ["image (prefix)", (p) => ({ container: { ...validContainer(), image: `${p}${IMAGE}` }, id: ID })],
    ["environment value", (p) => ({ container: { ...validContainer(), environment: { LOG_LEVEL: `info${p}` } }, id: ID })],
    ["environment key", (p) => ({ container: { ...validContainer(), environment: { [`LOG_LEVEL${p}`]: "info" } }, id: ID })],
    ["extension id", (p) => ({ container: validContainer(), id: `${ID}${p}` })],
    ["unknown key", (p) => ({ container: { ...validContainer(), [p]: "x" }, id: ID })],
  ];

  for (const [slot, build] of SLOTS) {
    it.each(PAYLOADS)(`${slot}: %j never reaches the written YAML`, (payload) => {
      const { container, id } = build(payload);
      let out: string | undefined;
      try {
        out = render(container, id);
      } catch (err) {
        expect(err).toBeInstanceOf(ExtensionFragmentError);
        return;
      }
      for (const marker of MARKERS) expect(out).not.toMatch(marker);
    });
  }

  it("manifest free text (name, summary, descriptions) has no path into the override", () => {
    // The v2 manifest will carry the container block beside the author's
    // free text; only the block is handed to the serializer.
    const manifest = {
      id: ID,
      name: "x\n    privileged: true",
      summary: "${HOST_ROOT}\nservices:\n  orchestrator: {}",
      container: validContainer(),
    };
    const out = render(manifest.container);
    for (const marker of MARKERS) expect(out).not.toMatch(marker);
    expect(out).toBe(GOLDEN);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. the shape re-parse
// ═════════════════════════════════════════════════════════════════════════

describe("assertExtensionOverrideShape: YAML adversaries", () => {
  it("refuses a duplicate key", () => {
    const text = tamper("    read_only: true\n", "    read_only: true\n    read_only: false\n");
    expectRefusal(() => shape(text), "yaml_adversary", /duplicate mapping key/);
  });

  it("refuses a duplicate service key", () => {
    const text = `${GOLDEN.replace("volumes:\n  ext-word-count-data:\n", "")}  ext-word-count:\n    privileged: true\nvolumes:\n  ext-word-count-data:\n`;
    expectRefusal(() => shape(text), "yaml_adversary", /duplicate mapping key/);
  });

  it("refuses an anchor", () => {
    const text = tamper("    networks:\n", "    networks: &net\n");
    expectRefusal(() => shape(text), "yaml_adversary", /anchors and aliases/);
  });

  it("refuses an alias (and the anchor it needs)", () => {
    const text = tamper("    cap_drop:\n      - ALL\n", "    cap_drop: &drop\n      - ALL\n") + "x-reuse: *drop\n";
    expectRefusal(() => shape(text), "yaml_adversary", /anchors and aliases/);
  });

  it("refuses a merge key", () => {
    const text = tamper("    read_only: true\n", "    read_only: true\n    <<: {privileged: true}\n");
    expectRefusal(() => shape(text), "yaml_adversary", /merge keys/);
  });

  it("refuses an explicit core tag", () => {
    const text = tamper("    pids_limit: 64\n", "    pids_limit: !!int 64\n");
    expectRefusal(() => shape(text), "yaml_adversary", /explicit tags are refused \(tag:yaml.org,2002:int\)/);
  });

  it("refuses compose's !override / !reset tags (unresolved to a YAML parser)", () => {
    const text = tamper("    networks:\n      - droplet-internal\n", "    networks: !override\n      - droplet-internal\n");
    expectRefusal(() => shape(text), "yaml_adversary", /YAML warning: Unresolved tag: !override/);
  });

  it("refuses a second YAML document", () => {
    expectRefusal(() => shape(`${GOLDEN}---\nservices:\n  orchestrator:\n    privileged: true\n`), "yaml_adversary", /exactly one YAML document/);
  });

  it("refuses an empty text", () => {
    expectRefusal(() => shape(""), "yaml_adversary", /exactly one YAML document/);
  });

  it("refuses unparseable YAML", () => {
    expectRefusal(() => shape("services: [\n"), "yaml_adversary", /YAML error/);
  });

  it("refuses text over the size cap before parsing it", () => {
    const text = `${GOLDEN}# ${"x".repeat(EXT_OVERRIDE_MAX_BYTES)}\n`;
    expectRefusal(() => shape(text), "shape_invalid", /at most \d+ bytes/);
  });
});

describe("assertExtensionOverrideShape: service identity", () => {
  it("refuses two services", () => {
    const text = tamper("volumes:\n  ext-word-count-data:\n", "  ext-other:\n    image: x\nvolumes:\n  ext-word-count-data:\n");
    expectRefusal(() => shape(text), "shape_invalid", /exactly one service is allowed, got 2/);
  });

  it.each(["orchestrator", "gateway", "db", "sandbox"])("refuses the first-party service name %s", (name) => {
    const text = GOLDEN.replace("  ext-word-count:\n", `  ${name}:\n`);
    expectRefusal(() => shape(text), "extension_id_invalid", new RegExp(`"${name}" is not ext-word-count`));
  });

  it("refuses a manifest id that does not match the fragment's service", () => {
    expectRefusal(() => shape(GOLDEN, "other-ext"), "extension_id_invalid", /"ext-word-count" is not ext-other-ext/);
  });

  it("refuses when the base compose already defines ext-<id> (the override would merge into it)", () => {
    expectRefusal(() => shape(GOLDEN, ID, [...BASE, "ext-word-count"]), "shape_invalid", /is a base service/);
  });

  it("refuses an invalid extension id before parsing", () => {
    expectRefusal(() => shape(GOLDEN, "Word Count"), "extension_id_invalid");
  });
});

describe("assertExtensionOverrideShape: forbidden keys injected into the service", () => {
  // Every WARP-2924 key the serializer does NOT emit, injected by hand.
  const INJECT: Array<[string, string]> = [
    ["ports", "ports:\n      - 0.0.0.0:8080:8080"],
    ["privileged", "privileged: true"],
    ["network_mode", "network_mode: host"],
    ["devices", "devices:\n      - /dev/mem:/dev/mem"],
    ["cap_add", "cap_add:\n      - SYS_ADMIN"],
    ["pid", "pid: host"],
    ["ipc", "ipc: host"],
    ["sysctls", "sysctls:\n      net.ipv4.ip_forward: 1"],
    ["extra_hosts", "extra_hosts:\n      - db:10.0.0.1"],
    ["userns_mode", "userns_mode: host"],
    ["cgroup_parent", "cgroup_parent: /"],
    ["ulimits", "ulimits:\n      nofile: 1048576"],
    ["tmpfs", "tmpfs:\n      - /tmp:exec,mode=1777"],
    ["env_file", "env_file:\n      - /etc/droplet/.env"],
    ["secrets", "secrets:\n      - postgres_password"],
    ["configs", "configs:\n      - nginx"],
    ["labels", "labels:\n      com.docker.compose.project: droplet"],
    ["build", "build:\n      context: /"],
    ["command", "command: [sh, -c, id]"],
    ["entrypoint", "entrypoint: /bin/sh"],
    ["depends_on", "depends_on:\n      - db"],
    ["container_name", "container_name: droplet-orchestrator"],
  ];

  it.each(INJECT)("refuses an injected %s by name", (key, stanza) => {
    const text = tamper("    read_only: true\n", `    read_only: true\n    ${stanza}\n`);
    expectRefusal(() => shape(text), "forbidden_key", new RegExp(`ext-word-count\\.${key} is refused: .+`));
  });

  it("refuses an unknown service key that is not on the named list", () => {
    const text = tamper("    read_only: true\n", "    read_only: true\n    stdin_open: true\n");
    expectRefusal(() => shape(text), "shape_invalid", /unknown key\(s\) \["stdin_open"\]/);
  });

  it.each(["mem_limit", "cpus", "pids_limit", "networks", "read_only", "cap_drop", "security_opt", "volumes", "image"])(
    "refuses a service with %s removed",
    (key) => {
      const lines = GOLDEN.split("\n");
      const i = lines.findIndex((l) => l.startsWith(`    ${key}:`));
      expect(i).toBeGreaterThan(0);
      let j = i + 1;
      while (lines[j]!.startsWith("      ")) j++;
      lines.splice(i, j - i);
      expectRefusal(() => shape(lines.join("\n")), "shape_invalid", new RegExp(`missing \\[.*"${key}"`));
    },
  );
});

describe("assertExtensionOverrideShape: widened values for the keys the serializer emits", () => {
  const WIDEN: Array<[string, string, string, RegExp]> = [
    ["read_only: false", "    read_only: true\n", "    read_only: false\n", /read_only must be true/],
    ["read_only: \"true\" (a string)", "    read_only: true\n", '    read_only: "true"\n', /read_only must be true/],
    ["cap_drop: [] ", "    cap_drop:\n      - ALL\n", "    cap_drop: []\n", /cap_drop must be exactly \[ALL\]/],
    ["cap_drop: [NET_RAW]", "      - ALL\n", "      - NET_RAW\n", /cap_drop must be exactly \[ALL\]/],
    ["networks: [default]", "      - droplet-internal\n", "      - default\n", /networks must be exactly/],
    ["networks: + default", "      - droplet-internal\n", "      - droplet-internal\n      - default\n", /networks must be exactly/],
    [
      "networks as a map with an alias spoofing db",
      "    networks:\n      - droplet-internal\n",
      "    networks:\n      droplet-internal:\n        aliases: [db]\n",
      /networks must be exactly/,
    ],
    ["security_opt seccomp=unconfined", "      - no-new-privileges:true\n", "      - seccomp=unconfined\n", /security_opt must be exactly/],
    [
      "security_opt + apparmor=unconfined",
      "      - no-new-privileges:true\n",
      "      - no-new-privileges:true\n      - apparmor=unconfined\n",
      /security_opt must be exactly/,
    ],
    ["bind volume, short form", "      - ext-word-count-data:/data\n", "      - /:/host\n", /volumes must be exactly/],
    [
      "bind volume, long form (type: bind)",
      "      - ext-word-count-data:/data\n",
      "      - type: bind\n        source: /\n        target: /host\n",
      /volumes must be exactly/,
    ],
    [
      "docker.sock mount",
      "      - ext-word-count-data:/data\n",
      "      - ext-word-count-data:/data\n      - /var/run/docker.sock:/var/run/docker.sock\n",
      /volumes must be exactly/,
    ],
    ["another extension's volume", "      - ext-word-count-data:/data\n", "      - ext-other-data:/data\n", /volumes must be exactly/],
    ["mem_limit over the ceiling", "    mem_limit: 256m\n", `    mem_limit: ${EXT_MAX_MEMORY_MB + 1}m\n`, /mem_limit must be/],
    ["mem_limit 0 (unlimited)", "    mem_limit: 256m\n", "    mem_limit: 0\n", /mem_limit must be/],
    ["mem_limit in gigabytes", "    mem_limit: 256m\n", "    mem_limit: 1g\n", /mem_limit must be/],
    ["cpus 0 (unlimited)", "    cpus: 0.50\n", "    cpus: 0\n", /cpus must be/],
    ["cpus over the ceiling", "    cpus: 0.50\n", `    cpus: ${EXT_MAX_CPUS + 1}\n`, /cpus must be/],
    ["cpus as a string", "    cpus: 0.50\n", '    cpus: "0.50"\n', /cpus must be/],
    ["pids_limit -1 (unlimited)", "    pids_limit: 64\n", "    pids_limit: -1\n", /pids_limit must be/],
    ["pids_limit over the ceiling", "    pids_limit: 64\n", `    pids_limit: ${EXT_MAX_PIDS + 1}\n`, /pids_limit must be/],
    ["image by tag", `    image: ${IMAGE}\n`, `    image: ${REGISTRY_HOST}/ext/${ID}:latest\n`, /image is not/],
    ["image from a foreign registry", `    image: ${IMAGE}\n`, `    image: registry.example/ext/${ID}@sha256:${DIGEST}\n`, /image is not/],
    ["another extension's image", `    image: ${IMAGE}\n`, `    image: ${REGISTRY_HOST}/ext/other@sha256:${DIGEST}\n`, /image is not/],
    ["environment key off the allowlist", "      NODE_ENV: production\n", "      NODE_OPTIONS: --require=/data/x.js\n", /NODE_OPTIONS is not in EXT_ENV_ALLOWLIST/],
    ["environment interpolation", "      NODE_ENV: production\n", "      NODE_ENV: ${POSTGRES_PASSWORD}\n", /NODE_ENV is not a literal/],
    ["environment null (inherits the host env)", "      NODE_ENV: production\n", "      NODE_ENV:\n", /NODE_ENV is not a literal/],
    ["environment as a list", "    environment:\n      LOG_LEVEL: info\n      NODE_ENV: production\n", "    environment:\n      - LOG_LEVEL=info\n", /environment must be a mapping/],
  ];

  it.each(WIDEN)("refuses %s", (_label, from, to, message) => {
    const code: ExtensionFragmentRefusal = /image is not/.test(message.source) ? "image_invalid" : "shape_invalid";
    expectRefusal(() => shape(tamper(from, to)), code, message);
  });

  it.each([
    ["x-extension fields", "services:\n", "x-ext: 1\nservices:\n"],
    ["a project name", "services:\n", "name: droplet\nservices:\n"],
    ["a networks redefinition", "volumes:\n  ext-word-count-data:\n", "volumes:\n  ext-word-count-data:\nnetworks:\n  droplet-internal:\n    internal: false\n"],
    ["an include", "services:\n", "include:\n  - /etc/droplet/compose.yml\nservices:\n"],
  ])("refuses a top level with %s", (_label, from, to) => {
    expectRefusal(() => shape(tamper(from, to)), "shape_invalid", /top-level keys must be exactly services and volumes/);
  });

  it.each([
    ["a driver", "  ext-word-count-data:\n    driver: local\n"],
    ["a bind driver_opts", "  ext-word-count-data:\n    driver_opts:\n      type: none\n      o: bind\n      device: /\n"],
    ["external: true (another volume)", "  ext-word-count-data:\n    external: true\n"],
    ["a second volume", "  ext-word-count-data:\n  ext-other-data:\n"],
  ])("refuses a top-level volume with %s", (_label, to) => {
    expectRefusal(() => shape(tamper("  ext-word-count-data:\n", to)), "shape_invalid", /top-level volumes must declare exactly ext-word-count-data, bare/);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. constants
// ═════════════════════════════════════════════════════════════════════════

describe("extension fragment constants", () => {
  it("every WARP-2924 key is refused by name", () => {
    for (const [key] of AC_FORBIDDEN) expect(Object.keys(FORBIDDEN_SERVICE_KEYS)).toContain(key);
  });

  it("the memory ceiling sits inside the H1 manifest's memory bounds", () => {
    expect(EXT_MIN_MEMORY_MB).toBe(EXTENSION_MEMORY_MB_MIN);
    expect(EXT_MAX_MEMORY_MB).toBeLessThanOrEqual(EXTENSION_MEMORY_MB_MAX);
  });

  it("REGISTRY_HOST is a single loopback placeholder", () => {
    expect(REGISTRY_HOST).toMatch(/^127\.0\.0\.1:\d+$/);
  });
});
