/**
 * WARP-2898 (ADR-056 slice K1): the compose fragment an extension container
 * may run as, and the ONLY code that writes one.
 *
 * ## Why this module exists before its caller
 *
 * K3 will install an extension container by handing host-compose-runner a
 * per-extension override file (`-f base -f override`) under the one audited
 * docker-socket path. Compose honours EVERY key an override carries for a
 * service the base file does not define, so a fragment that could carry
 * `privileged: true`, a bind mount of `/`, `network_mode: host` or the docker
 * socket is host root by another name. This module is the reviewed contract
 * that closes that door first (WARP-2924); it has no product caller yet.
 *
 * ## The contract
 *
 * 1. INPUT is never YAML. It is the `container` block of a VERIFIED extension
 *    manifest, parsed by `extensionContainerSchema` (strict zod at every
 *    level). The block names exactly three things an author may choose:
 *      - `image`: `<REGISTRY_HOST>/ext/<id>@sha256:<64 hex>`, digest-pinned,
 *        on-box registry only, and bound to THIS extension's id;
 *      - `environment`: keys from `EXT_ENV_ALLOWLIST`, literal values from a
 *        closed charset (no `$`, so no compose interpolation);
 *      - `limits`: memoryMb + cpus + pids, ALL mandatory, each bounded by a
 *        stated `EXT_MAX_*` ceiling (0 means "unlimited" to docker, so every
 *        lower bound is above 0).
 *    Every compose key that could widen the container (`FORBIDDEN_SERVICE_KEYS`)
 *    is refused BY NAME with its reason; anything else unknown is refused by
 *    `.strict()`.
 * 2. EVERYTHING ELSE IS HARD-CODED by the serializer, never read from input:
 *    `networks: [droplet-internal]`, `read_only: true`, `cap_drop: [ALL]`,
 *    `security_opt: [no-new-privileges:true]`, and one named volume
 *    `ext-<id>-data:/data` declared at the top level.
 * 3. OUTPUT is emitted line by line in `composeOverrideYaml`'s discipline
 *    (host-compose-runner.ts): REFUSE, NEVER QUOTE. Every emitted scalar has
 *    already matched a closed pattern, so there is nothing to escape, and a
 *    value that would need escaping is a refusal.
 * 4. The written text is RE-PARSED by `assertExtensionOverrideShape` before
 *    it is returned (defence in depth, and the check K3's runner repeats
 *    before `writeFile`): one YAML document, unique keys, no anchors, aliases,
 *    merge keys or explicit tags, the exact top-level and service key sets,
 *    exactly one service named `ext-<id>` that is not a base service, and
 *    every hard-coded value exactly as emitted.
 *
 * ## Open decisions this module deliberately does NOT make
 *
 * - `REGISTRY_HOST` is ONE named placeholder. How the host dockerd reaches an
 *   on-box registry (loopback publish, a digest-gated pull subcommand, or
 *   `docker load`) is undecided (WARP-2898 human gate); changing the answer
 *   changes this one constant.
 * - The `EXT_MAX_*` ceilings are proposals awaiting the per-extension limit
 *   decision (WARP-2924 "Limits"). They are NOT the SANDBOX_* budget.
 * - Whether apply-update.sh adds its own refusal for a non-base service, and
 *   how SERVICE_TOKEN_EXT_<id> reaches a container (the allowlist admits no
 *   secret: `environment` is literal and `env_file`/`secrets` are refused),
 *   are Romain's calls on WARP-2924.
 */
import { isAlias, isScalar, parseAllDocuments, visit } from "yaml";
import { z } from "zod";
import { EXTENSION_MEMORY_MB_MIN, EXTENSION_SLUG_PATTERN } from "../extension-manifest.js";
import type { RecreateTarget } from "./apply.js";

// ─── constants ───────────────────────────────────────────────────────────

/**
 * PLACEHOLDER pending the host-daemon pull decision (WARP-2898): the on-box
 * registry as the HOST dockerd must name it. Loopback because dockerd trusts
 * 127.0.0.0/8 as an insecure registry by default and cannot resolve compose
 * DNS. The single place the answer lands.
 */
export const REGISTRY_HOST = "127.0.0.1:5000";

/** The one network an extension container joins (docker-compose.yml, WARP-2895). */
export const EXT_NETWORK = "droplet-internal";

/** Per-extension ceilings (proposals; WARP-2924 decides). */
export const EXT_MAX_MEMORY_MB = 1024;
export const EXT_MIN_MEMORY_MB = EXTENSION_MEMORY_MB_MIN;
export const EXT_MAX_CPUS = 1;
export const EXT_MAX_PIDS = 256;
export const EXT_MIN_PIDS = 1;

/**
 * Environment keys an extension may set. Deliberately tiny: nothing that
 * changes how the runtime loads code (NODE_OPTIONS, LD_PRELOAD, PYTHONPATH,
 * …) and no secret. Adding a key is a security-review change.
 */
export const EXT_ENV_ALLOWLIST = ["LOG_LEVEL", "NODE_ENV", "TZ"] as const;
export type ExtEnvKey = (typeof EXT_ENV_ALLOWLIST)[number];

/**
 * An environment value: starts with a letter (so YAML can never read it as a
 * number, timestamp, `~` or `.inf`), then a closed charset with no `$`
 * (compose interpolation), whitespace, quote, `#`, or YAML flow character.
 */
export const EXT_ENV_VALUE_PATTERN = /^[A-Za-z][A-Za-z0-9._:/@-]*$/;
export const EXT_ENV_VALUE_MAX = 128;
/** Letter-initial words YAML 1.1 or 1.2 resolve to a bool or null. */
const YAML_TYPED_WORDS = new Set(["y", "n", "yes", "no", "true", "false", "on", "off", "null"]);

/** Bound on the override text the shape check will parse at all. */
export const EXT_OVERRIDE_MAX_BYTES = 8 * 1024;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `<REGISTRY_HOST>/ext/<slug>@sha256:<64 lowercase hex>`, nothing else. */
export const EXT_IMAGE_PATTERN = new RegExp(
  `^${escapeRegExp(REGISTRY_HOST)}/ext/[a-z0-9][a-z0-9-]{0,26}@sha256:[0-9a-f]{64}$`,
);

/**
 * Compose service keys an extension fragment never carries, each with the
 * reason it is refused. Checked by name on the manifest's container block
 * AND on the re-parsed override, so a refusal always says what was asked
 * for and why. Keys the serializer emits itself (networks, read_only,
 * cap_drop, security_opt, volumes) are here too: they are not inputs.
 */
export const FORBIDDEN_SERVICE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  ports: "publishes a host port; an extension is reachable only on droplet-internal",
  expose: "the port surface is fixed by the platform, not the extension",
  privileged: "privileged is host root",
  network_mode: "network_mode can put the container on the host network stack",
  networks: "the network is fixed to droplet-internal by the platform",
  devices: "host devices are host access",
  device_cgroup_rules: "device cgroup rules grant host devices",
  cap_add: "added capabilities widen the kernel surface; the platform drops ALL",
  cap_drop: "the platform drops ALL capabilities; it is not an input",
  pid: "sharing a pid namespace exposes other processes",
  ipc: "sharing an ipc namespace exposes other processes",
  uts: "sharing the uts namespace exposes the host",
  sysctls: "sysctls change kernel parameters",
  extra_hosts: "extra_hosts rewrites name resolution",
  dns: "custom DNS reroutes name resolution",
  userns_mode: "userns_mode=host disables user-namespace isolation",
  cgroup_parent: "cgroup_parent escapes the platform's resource accounting",
  cgroup: "cgroup=host shares the host cgroup namespace",
  ulimits: "ulimits are set by the platform",
  tmpfs: "tmpfs mounts are fixed by the platform (and an exec tmpfs is a code drop)",
  env_file: "env_file reads host files into the container",
  secrets: "secrets hand host-side material to the container",
  configs: "configs hand host-side files to the container",
  labels: "labels can spoof compose ownership (the compose project label)",
  build: "an extension is never built by compose; its image is pinned by digest",
  command: "the image's own command runs; the platform does not rewrite it",
  entrypoint: "the image's own entrypoint runs; the platform does not rewrite it",
  depends_on: "an extension cannot order itself among first-party services",
  container_name: "a fixed container name can collide with a first-party container",
  read_only: "the root filesystem is read-only; it is not an input",
  security_opt: "security options are fixed (no-new-privileges); seccomp/apparmor=unconfined is host reach",
  volumes: "the only volume is the platform's ext-<id>-data; bind mounts (and the docker socket) are host access",
  volumes_from: "volumes_from mounts another container's volumes",
  runtime: "an alternative OCI runtime changes the isolation boundary",
  user: "the image's user runs; the platform does not override it",
  group_add: "extra groups can grant device or socket access",
  restart: "the restart policy is the platform's",
  mem_limit: "limits come from container.limits, bounded by EXT_MAX_*",
  cpus: "limits come from container.limits, bounded by EXT_MAX_*",
  pids_limit: "limits come from container.limits, bounded by EXT_MAX_*",
  deploy: "deploy.* is ignored outside Swarm and would look like a limit while enforcing none",
  profiles: "profiles are the platform's",
  healthcheck: "the healthcheck is the platform's",
  logging: "a logging driver can ship output off the box",
  init: "the init process is the platform's",
  stop_signal: "stop semantics are the platform's",
  working_dir: "the image's working directory is used",
  hostname: "a hostname can shadow a first-party service name",
  domainname: "a domain name can shadow a first-party service name",
  links: "links alias other services",
  external_links: "links alias other containers",
  platform: "the platform is the box's",
  pull_policy: "the platform never pulls at recreate (--pull never)",
  shm_size: "shared memory is bounded by the platform",
  storage_opt: "storage options are the platform's",
  isolation: "the isolation technology is the platform's",
  oom_kill_disable: "disabling the OOM killer defeats mem_limit",
  oom_score_adj: "OOM priority is the platform's",
  mac_address: "the MAC address is the platform's",
  extends: "extends pulls keys from another file or service",
});

// ─── errors ──────────────────────────────────────────────────────────────

export type ExtensionFragmentRefusal =
  /** A compose key the fragment never carries (named, with its reason). */
  | "forbidden_key"
  /** The container block failed the strict schema (missing/unknown/bounds). */
  | "container_invalid"
  /** The image is not this extension's digest-pinned on-box image. */
  | "image_invalid"
  /** The extension id is not a slug, or the service is not ext-<id>. */
  | "extension_id_invalid"
  /** Duplicate keys, anchors, aliases, merge keys, tags, several documents. */
  | "yaml_adversary"
  /** The re-parsed override is not exactly the shape the serializer emits. */
  | "shape_invalid";

export class ExtensionFragmentError extends Error {
  readonly code: ExtensionFragmentRefusal;
  constructor(code: ExtensionFragmentRefusal, message: string) {
    super(`extension fragment refused (${code}): ${message}`);
    this.name = "ExtensionFragmentError";
    this.code = code;
  }
}

function refuse(code: ExtensionFragmentRefusal, message: string): never {
  throw new ExtensionFragmentError(code, message);
}

// ─── the container block (input) ────────────────────────────────────────

/** 0.01 steps: emitted as a fixed two-decimal YAML float, never an exponent. */
const inHundredths = (v: number): boolean => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;

const envValueSchema = z
  .string()
  .max(EXT_ENV_VALUE_MAX)
  .regex(EXT_ENV_VALUE_PATTERN, "environment values are literal: a letter, then [A-Za-z0-9._:/@-] (no $, space or quote)")
  .refine((v) => !YAML_TYPED_WORDS.has(v.toLowerCase()), "a value YAML reads as a bool or null is refused");

export const extensionContainerSchema = z
  .object({
    image: z
      .string()
      .max(256)
      .regex(EXT_IMAGE_PATTERN, `image must be ${REGISTRY_HOST}/ext/<id>@sha256:<64 lowercase hex> (no tag, no other registry)`),
    environment: z.record(z.enum(EXT_ENV_ALLOWLIST), envValueSchema).optional(),
    limits: z
      .object({
        memoryMb: z.number().int().min(EXT_MIN_MEMORY_MB).max(EXT_MAX_MEMORY_MB),
        cpus: z
          .number()
          .gt(0, "cpus 0 is unlimited to docker")
          .max(EXT_MAX_CPUS)
          .refine(inHundredths, "cpus is set in steps of 0.01"),
        pids: z.number().int().min(EXT_MIN_PIDS, "pids 0 or less is unlimited to docker").max(EXT_MAX_PIDS),
      })
      .strict(),
  })
  .strict();

export type ExtensionContainer = z.infer<typeof extensionContainerSchema>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function firstForbiddenKey(obj: Record<string, unknown>): string | undefined {
  return Object.keys(obj).find((k) => Object.prototype.hasOwnProperty.call(FORBIDDEN_SERVICE_KEYS, k));
}

/**
 * The manifest's `container` block -> a typed container, or a named refusal.
 * Forbidden compose keys are refused by name before the schema runs, so the
 * error says `privileged` and why, not just "unrecognized key".
 */
export function parseExtensionContainer(raw: unknown): ExtensionContainer {
  if (!isPlainObject(raw)) refuse("container_invalid", "container must be an object");
  const forbidden = firstForbiddenKey(raw as Record<string, unknown>);
  if (forbidden !== undefined) {
    refuse("forbidden_key", `container.${forbidden} is refused: ${FORBIDDEN_SERVICE_KEYS[forbidden]}`);
  }
  const parsed = extensionContainerSchema.safeParse(raw);
  if (!parsed.success) {
    refuse(
      "container_invalid",
      parsed.error.issues
        .map((i) => `container${i.path.length ? "." : ""}${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }
  return (parsed as { success: true; data: ExtensionContainer }).data;
}

// ─── naming ──────────────────────────────────────────────────────────────

function assertExtensionId(extensionId: string): void {
  if (typeof extensionId !== "string" || !EXTENSION_SLUG_PATTERN.test(extensionId)) {
    refuse("extension_id_invalid", `extension id ${JSON.stringify(extensionId)} is not an extension slug`);
  }
}

/** The compose service an extension runs as. */
export const extensionServiceName = (extensionId: string): string => `ext-${extensionId}`;
/** The one named volume an extension owns. */
export const extensionVolumeName = (extensionId: string): string => `ext-${extensionId}-data`;
const imagePrefixFor = (extensionId: string): string => `${REGISTRY_HOST}/ext/${extensionId}@sha256:`;

// ─── the serializer (output) ─────────────────────────────────────────────

export interface RenderExtensionOverrideInput {
  /** The extension slug (deriveExtensionSlug of the manifest id). */
  extensionId: string;
  target: RecreateTarget;
  /** The verified manifest's `container` block, unparsed. */
  container: unknown;
  /** Every service name in the base docker-compose.yml. */
  baseServices: readonly string[];
}

/**
 * Render the compose override for one extension container. Parses the
 * container block itself (no caller can skip the schema), emits line by line
 * from validated fields only, then re-parses its own output with
 * `assertExtensionOverrideShape` before returning it.
 */
export function renderExtensionOverride(input: RenderExtensionOverrideInput): string {
  assertExtensionId(input.extensionId);
  if (input.target !== "release" && input.target !== "previous") {
    refuse("shape_invalid", `target must be release or previous, got ${JSON.stringify(input.target)}`);
  }
  const c = parseExtensionContainer(input.container);
  if (!c.image.startsWith(imagePrefixFor(input.extensionId))) {
    refuse("image_invalid", `image is not ${imagePrefixFor(input.extensionId)}<digest> (another extension's image?)`);
  }

  const service = extensionServiceName(input.extensionId);
  const volume = extensionVolumeName(input.extensionId);
  const lines = [
    `# WARP-2898 — GENERATED compose override (${input.target}) for extension`,
    `# ${input.extensionId}. Written only by update-agent/extension-fragment.ts from a`,
    `# verified manifest; every key below is fixed by the platform or bounded by`,
    `# its schema. DO NOT EDIT.`,
    "services:",
    `  ${service}:`,
    `    image: ${c.image}`,
  ];
  const env = Object.entries(c.environment ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (env.length > 0) {
    lines.push("    environment:");
    for (const [key, value] of env) lines.push(`      ${key}: ${value}`);
  }
  lines.push(
    `    mem_limit: ${c.limits.memoryMb}m`,
    `    cpus: ${c.limits.cpus.toFixed(2)}`,
    `    pids_limit: ${c.limits.pids}`,
    "    networks:",
    `      - ${EXT_NETWORK}`,
    "    read_only: true",
    "    cap_drop:",
    "      - ALL",
    "    security_opt:",
    "      - no-new-privileges:true",
    "    volumes:",
    `      - ${volume}:/data`,
    "volumes:",
    `  ${volume}:`,
  );
  const text = `${lines.join("\n")}\n`;
  assertExtensionOverrideShape(text, {
    extensionId: input.extensionId,
    baseServices: input.baseServices,
  });
  return text;
}

// ─── the shape check (re-parse) ──────────────────────────────────────────

const SERVICE_REQUIRED_KEYS = [
  "cap_drop",
  "cpus",
  "image",
  "mem_limit",
  "networks",
  "pids_limit",
  "read_only",
  "security_opt",
  "volumes",
] as const;
const SERVICE_OPTIONAL_KEYS = ["environment"] as const;

const isExactStringList = (v: unknown, expected: readonly string[]): boolean =>
  Array.isArray(v) && v.length === expected.length && v.every((x, i) => x === expected[i]);

export interface ExtensionOverrideShapeOptions {
  extensionId: string;
  baseServices: readonly string[];
}

/**
 * Re-parse an extension override and refuse anything that is not exactly
 * what `renderExtensionOverride` emits. Throws ExtensionFragmentError.
 */
export function assertExtensionOverrideShape(text: string, opts: ExtensionOverrideShapeOptions): void {
  assertExtensionId(opts.extensionId);
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > EXT_OVERRIDE_MAX_BYTES) {
    refuse("shape_invalid", `override must be a string of at most ${EXT_OVERRIDE_MAX_BYTES} bytes`);
  }

  // ── YAML adversaries ──
  const docs = parseAllDocuments(text, { uniqueKeys: true, merge: false });
  if (!Array.isArray(docs) || docs.length !== 1) {
    refuse("yaml_adversary", "the override must be exactly one YAML document");
  }
  const doc = (docs as Exclude<typeof docs, { empty: true }>)[0]!;
  if (doc.errors.length > 0) {
    const dup = doc.errors.some((e) => e.code === "DUPLICATE_KEY");
    refuse(
      "yaml_adversary",
      dup ? "duplicate mapping key" : `YAML error: ${doc.errors[0]!.message.split("\n")[0]}`,
    );
  }
  if (doc.warnings.length > 0) {
    refuse("yaml_adversary", `YAML warning: ${doc.warnings[0]!.message.split("\n")[0]}`);
  }
  visit(doc, {
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === "<<") refuse("yaml_adversary", "merge keys (<<) are refused");
    },
    Node(_key, node) {
      // One check for both: YAML defines an anchor before any alias to it,
      // so the anchor is always met first.
      if (isAlias(node) || (node as { anchor?: string }).anchor) {
        refuse("yaml_adversary", "anchors and aliases are refused");
      }
      if ((node as { tag?: string }).tag) {
        refuse("yaml_adversary", `explicit tags are refused (${(node as { tag?: string }).tag})`);
      }
    },
  });
  const root: unknown = doc.toJS();

  // ── top level: exactly services + volumes ──
  if (!isPlainObject(root)) refuse("shape_invalid", "the override must be a mapping");
  const top = root as Record<string, unknown>;
  const topKeys = Object.keys(top).sort();
  if (!isExactStringList(topKeys, ["services", "volumes"])) {
    refuse("shape_invalid", `top-level keys must be exactly services and volumes, got ${JSON.stringify(topKeys)}`);
  }

  // ── exactly one service, ext-<id>, not a base service ──
  if (!isPlainObject(top.services)) refuse("shape_invalid", "services must be a mapping");
  const services = top.services as Record<string, unknown>;
  const names = Object.keys(services);
  if (names.length !== 1) {
    refuse("shape_invalid", `exactly one service is allowed, got ${names.length} (${JSON.stringify(names)})`);
  }
  const name = names[0]!;
  const expected = extensionServiceName(opts.extensionId);
  if (name !== expected) {
    refuse("extension_id_invalid", `service ${JSON.stringify(name)} is not ${expected}`);
  }
  if (opts.baseServices.includes(name)) {
    refuse("shape_invalid", `${name} is a base service; an extension override may only add a service`);
  }

  // ── the service body ──
  const svc = services[name];
  if (!isPlainObject(svc)) refuse("shape_invalid", `${name} must be a mapping`);
  const body = svc as Record<string, unknown>;
  const allowed = new Set<string>([...SERVICE_REQUIRED_KEYS, ...SERVICE_OPTIONAL_KEYS]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key) && Object.prototype.hasOwnProperty.call(FORBIDDEN_SERVICE_KEYS, key)) {
      refuse("forbidden_key", `${name}.${key} is refused: ${FORBIDDEN_SERVICE_KEYS[key]}`);
    }
  }
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length > 0) refuse("shape_invalid", `${name} carries unknown key(s) ${JSON.stringify(unknown)}`);
  const missing = SERVICE_REQUIRED_KEYS.filter((k) => !(k in body));
  if (missing.length > 0) refuse("shape_invalid", `${name} is missing ${JSON.stringify(missing)}`);

  const image = body.image;
  if (typeof image !== "string" || !EXT_IMAGE_PATTERN.test(image) || !image.startsWith(imagePrefixFor(opts.extensionId))) {
    refuse("image_invalid", `${name}.image is not ${imagePrefixFor(opts.extensionId)}<64 hex>`);
  }

  const mem = typeof body.mem_limit === "string" ? /^([1-9][0-9]{0,5})m$/.exec(body.mem_limit) : null;
  const memMb = mem ? Number(mem[1]) : NaN;
  if (!(memMb >= EXT_MIN_MEMORY_MB && memMb <= EXT_MAX_MEMORY_MB)) {
    refuse("shape_invalid", `${name}.mem_limit must be ${EXT_MIN_MEMORY_MB}m..${EXT_MAX_MEMORY_MB}m`);
  }
  const cpus = body.cpus;
  if (typeof cpus !== "number" || !(cpus > 0 && cpus <= EXT_MAX_CPUS)) {
    refuse("shape_invalid", `${name}.cpus must be a number in (0, ${EXT_MAX_CPUS}]`);
  }
  const pids = body.pids_limit;
  if (typeof pids !== "number" || !Number.isInteger(pids) || pids < EXT_MIN_PIDS || pids > EXT_MAX_PIDS) {
    refuse("shape_invalid", `${name}.pids_limit must be an integer in [${EXT_MIN_PIDS}, ${EXT_MAX_PIDS}]`);
  }

  if (!isExactStringList(body.networks, [EXT_NETWORK])) {
    refuse("shape_invalid", `${name}.networks must be exactly [${EXT_NETWORK}]`);
  }
  if (body.read_only !== true) refuse("shape_invalid", `${name}.read_only must be true`);
  if (!isExactStringList(body.cap_drop, ["ALL"])) refuse("shape_invalid", `${name}.cap_drop must be exactly [ALL]`);
  if (!isExactStringList(body.security_opt, ["no-new-privileges:true"])) {
    refuse("shape_invalid", `${name}.security_opt must be exactly [no-new-privileges:true]`);
  }
  const volume = extensionVolumeName(opts.extensionId);
  if (!isExactStringList(body.volumes, [`${volume}:/data`])) {
    refuse("shape_invalid", `${name}.volumes must be exactly [${volume}:/data] (no bind mount, no socket)`);
  }

  if ("environment" in body) {
    const env = body.environment;
    if (!isPlainObject(env)) refuse("shape_invalid", `${name}.environment must be a mapping`);
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (!(EXT_ENV_ALLOWLIST as readonly string[]).includes(key)) {
        refuse("shape_invalid", `${name}.environment.${key} is not in EXT_ENV_ALLOWLIST`);
      }
      if (typeof value !== "string" || !envValueSchema.safeParse(value).success) {
        refuse("shape_invalid", `${name}.environment.${key} is not a literal allowlisted value`);
      }
    }
  }

  // ── the one top-level volume, declared bare ──
  if (!isPlainObject(top.volumes)) refuse("shape_invalid", "volumes must be a mapping");
  const vols = top.volumes as Record<string, unknown>;
  const volKeys = Object.keys(vols);
  if (!isExactStringList(volKeys, [volume]) || vols[volume] !== null) {
    refuse("shape_invalid", `top-level volumes must declare exactly ${volume}, bare (no driver, no options)`);
  }
}
