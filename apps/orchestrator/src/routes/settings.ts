/**
 * WARP-457 — A3 workspace settings CRUD surface.
 *
 * Routes owned by this file:
 *   GET   /api/settings              — full tree grouped by section.
 *                                       owner+admin+family read.
 *   GET   /api/settings/:section     — one section.
 *                                       owner+admin+family read.
 *   PATCH /api/settings/:section     — owner+admin only. Body:
 *                                       `{[key]: value, ...}`. Each
 *                                       changed key emits one
 *                                       ActivityRow (kind: system,
 *                                       severity: info).
 *
 * Dependencies (do NOT re-implement):
 *   - `requireRole(...roles)`           — WARP-171, src/middleware/auth.ts.
 *   - `recordActivity({ kind, ... })`   — WARP-456, src/services/activity.singleton.ts.
 *   - `WorkspaceSetting`, `SettingSection`, `SettingType` — added by
 *     this ticket in prisma/schema.prisma (chunk 1).
 *
 * Per the no-guessing rule (CLAUDE.md): the WorkspaceSetting row carries
 * `section: SettingSection` and `type: SettingType` — both explicit
 * Prisma enums. The route layer validates `valueJson` against `type`
 * before every write; the dispatch table lives in `validateValue`
 * below.
 *
 * `.env` continues to own infra-level secrets (DATABASE_URL,
 * JWT_SECRET, OLLAMA_URL etc) — settings here are additive, not a
 * replacement.
 */
import { Router, Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";

const logger = pino({ name: "settings-route" });

// Canonical SettingSection literals — duplicated as TS literals so the
// router compiles standalone without pulling the Prisma client into the
// path-param validator. Any drift between these and the Prisma enum is
// a schema bug; workspace-settings.schema.test.ts locks the contract.
const SECTION_VALUES = [
  "workspace",
  "memory_privacy",
  "off_lan",
  "hardware",
  "appearance",
] as const;
type SectionLiteral = (typeof SECTION_VALUES)[number];

// Canonical SettingType literals — same rationale as SECTION_VALUES.
const TYPE_VALUES = [
  "string",
  "number",
  "bool",
  "duration_seconds",
  "enum",
  "json",
] as const;
type TypeLiteral = (typeof TYPE_VALUES)[number];

/**
 * Per-key allowed-set for `SettingType.enum` columns. Lives at the
 * route layer (not in the schema) so per-key vocab changes don't
 * require a database migration — adding a new theme is a one-line
 * edit here instead of a new column.
 *
 * Keys that aren't in this map but carry `type: enum` fall back to
 * "any string accepted" — defensive default so a future seeder
 * default can ship without immediately gating its allowed-set here.
 * Operators tune those via PATCH at their own risk; the dashboard's
 * Settings UI is the canonical source for the visible choices.
 */
const ALLOWED_ENUM_VALUES: Record<string, readonly string[]> = {
  "workspace.locale": ["en-US", "en-GB", "fr-FR", "de-DE", "es-ES", "it-IT"],
  "workspace.default_scope": [
    "team",
    "exec_only",
    "finance",
    "engineering",
    "ops",
    "private",
  ],
  "appearance.theme": ["light", "dark", "system"],
  "appearance.density": ["compact", "comfortable", "spacious"],
  "appearance.landing": ["home", "chat", "files", "cameras", "devices"],
};

/**
 * Maximum byte depth for `SettingType.json` values. Defensive cap so
 * a malformed payload can't blow up the dashboard's render path.
 * 32 KB matches the existing brain-memory payload cap.
 */
const JSON_MAX_BYTES = 32 * 1024;

/**
 * Validate `value` against `type`. Returns `null` on success or a
 * machine-readable error string on failure. The route layer surfaces
 * the error in a 400 response; the dashboard renders it inline next
 * to the failing field.
 *
 * Each branch matches one `SettingType` enum member; the switch is
 * exhaustive — adding a new SettingType requires extending this fn
 * (and the surrounding TS literal). Compiler doesn't enforce
 * exhaustiveness today because `type` is a string at the call site;
 * the test suite (`per-type validation`) is the gate.
 */
function validateValue(
  type: TypeLiteral,
  key: string,
  value: unknown,
): string | null {
  switch (type) {
    case "string":
      if (typeof value !== "string") return "expected string";
      // Defensive upper bound: 4 KB. Beyond this the dashboard's input
      // surface stops being usable and the value is almost certainly a
      // paste-mistake. The bound is intentionally low — settings carry
      // names + URLs + short identifiers, not free-form prose.
      if (value.length > 4096) return "string too long (max 4096 chars)";
      return null;

    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return "expected finite number";
      }
      return null;

    case "bool":
      if (typeof value !== "boolean") return "expected boolean";
      return null;

    case "duration_seconds":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return "expected finite number of seconds";
      }
      if (!Number.isInteger(value)) return "expected integer seconds";
      if (value < 0) return "duration cannot be negative";
      return null;

    case "enum": {
      if (typeof value !== "string") return "expected string for enum value";
      const allowed = ALLOWED_ENUM_VALUES[key];
      if (allowed && !allowed.includes(value)) {
        return `value must be one of: ${allowed.join(", ")}`;
      }
      return null;
    }

    case "json": {
      // The body has already been JSON-parsed by express.json() —
      // anything here is JSON-representable. The only thing left to
      // check is the serialized size cap.
      try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
          // JSON.stringify returns undefined for unsupported values
          // (functions, undefined, BigInt). Body parsing would have
          // already rejected these but stay defensive.
          return "value is not JSON-representable";
        }
        if (serialized.length > JSON_MAX_BYTES) {
          return `json payload too large (max ${JSON_MAX_BYTES} bytes)`;
        }
      } catch (err) {
        return `json validation failed: ${(err as Error).message}`;
      }
      return null;
    }

    default: {
      // Unreachable as long as the schema's SettingType enum matches
      // TYPE_VALUES. Return a defensive error rather than throwing.
      return `unknown setting type: ${String(type)}`;
    }
  }
}

interface SettingEntry {
  key: string;
  type: string;
  value: unknown;
  updatedAt: Date;
}

interface SettingRow {
  key: string;
  section: string;
  type: string;
  valueJson: unknown;
  updatedAt: Date;
}

/**
 * Convert a list of WorkspaceSetting rows into the section-grouped
 * shape the dashboard expects. Every SettingSection enum member is
 * represented in the result even when its row count is zero — the
 * dashboard renders all five panes and would otherwise crash on
 * `undefined`.
 */
function groupBySection(rows: SettingRow[]): Record<string, SettingEntry[]> {
  const out: Record<string, SettingEntry[]> = {};
  for (const section of SECTION_VALUES) {
    out[section] = [];
  }
  for (const row of rows) {
    if (!out[row.section]) {
      // Defensive: a section we don't recognise (older row from a
      // future schema). Bucket it so the API doesn't lose it but the
      // dashboard's enum-keyed renderer can ignore.
      out[row.section] = [];
    }
    out[row.section].push({
      key: row.key,
      type: row.type,
      value: row.valueJson,
      updatedAt: row.updatedAt,
    });
  }
  return out;
}

function isKnownSection(name: string): name is SectionLiteral {
  return (SECTION_VALUES as readonly string[]).includes(name);
}

export function createSettingsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── /api/settings/off-lan ────────────────────────────────────
  // WARP-467 — sovereignty surface. Lives under the same /api/settings
  // namespace as the A3 workspace settings (one Settings page in the
  // dashboard) but the underlying table is OffLanAllowlistChannel,
  // not WorkspaceSetting.
  //
  // Mounted BEFORE the parameterized /settings/:section routes so the
  // literal `off-lan` path wins. Otherwise express would match
  // `:section = "off-lan"` first and return 404 (off-lan is not a
  // SettingSection enum member).
  //
  // Reads: owner+admin+family. The household needs to see the current
  // posture (e.g. "cloud model escape is disabled") even when only
  // admins can change it.
  //
  // Writes: owner+admin only, PATCH per key with a non-empty `reason`.
  // Each PATCH emits one ActivityRow kind=`system`, severity=`info`
  // capturing actor + reason + previousEnabled + nextEnabled.
  const OFF_LAN_CHANNEL_KEYS = [
    "software_updates",
    "cloud_model_escape",
    "outbound_email",
    "telemetry",
    "web_fetch",
  ] as const;
  type OffLanKey = (typeof OFF_LAN_CHANNEL_KEYS)[number];
  const isOffLanKey = (k: string): k is OffLanKey =>
    (OFF_LAN_CHANNEL_KEYS as readonly string[]).includes(k);

  interface OffLanRow {
    key: string;
    enabled: boolean;
    requiresAdmin: boolean;
    lastChangedBy: string | null;
    lastChangedAt: Date;
    reason: string | null;
  }

  router.get(
    "/settings/off-lan",
    requireRole("owner", "admin", "family"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const rows = (await prisma.offLanAllowlistChannel.findMany({
          orderBy: { key: "asc" },
        })) as unknown as OffLanRow[];
        res.json({
          channels: rows.map((r) => ({
            key: r.key,
            enabled: r.enabled,
            requiresAdmin: r.requiresAdmin,
            lastChangedBy: r.lastChangedBy,
            lastChangedAt: r.lastChangedAt,
            reason: r.reason,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/settings/off-lan/:key",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const key = req.params.key;
        if (!isOffLanKey(key)) {
          return res.status(404).json({ error: "Unknown channel key" });
        }

        const body = req.body ?? {};
        if (typeof body !== "object" || Array.isArray(body)) {
          return res.status(400).json({ error: "Invalid body" });
        }

        const enabled = body.enabled;
        if (typeof enabled !== "boolean") {
          return res
            .status(400)
            .json({ error: "`enabled` (boolean) is required" });
        }

        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (reason.length === 0) {
          return res
            .status(400)
            .json({ error: "`reason` is required when toggling an off-LAN channel" });
        }
        if (reason.length > 1024) {
          return res
            .status(400)
            .json({ error: "`reason` exceeds 1024-character limit" });
        }

        const row = (await prisma.offLanAllowlistChannel.findUnique({
          where: { key: key as any },
        })) as unknown as OffLanRow | null;
        if (!row) {
          return res.status(404).json({ error: "Channel not provisioned" });
        }

        const actor = req.user?.username ?? null;
        const now = new Date();

        if (row.enabled === enabled && (row.reason ?? "") === reason) {
          return res.json({
            key,
            enabled: row.enabled,
            requiresAdmin: row.requiresAdmin,
            lastChangedBy: row.lastChangedBy,
            lastChangedAt: row.lastChangedAt,
            reason: row.reason,
            changed: false,
          });
        }

        const updated = (await prisma.offLanAllowlistChannel.update({
          where: { key: key as any },
          data: {
            enabled,
            reason,
            lastChangedBy: actor,
            lastChangedAt: now,
          },
        })) as unknown as OffLanRow;

        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "shield",
          what: enabled
            ? "Off-LAN channel enabled"
            : "Off-LAN channel disabled",
          sub: key,
          refs: {
            actor,
            channel: key,
            previousEnabled: row.enabled,
            nextEnabled: enabled,
            reason,
          },
        });

        res.json({
          key: updated.key,
          enabled: updated.enabled,
          requiresAdmin: updated.requiresAdmin,
          lastChangedBy: updated.lastChangedBy,
          lastChangedAt: updated.lastChangedAt,
          reason: updated.reason,
          changed: true,
        });
      } catch (err) {
        logger.warn(
          { err, key: req.params.key },
          "PATCH /settings/off-lan failed",
        );
        next(err);
      }
    },
  );

  // ── GET /api/settings ────────────────────────────────────────
  // Returns the full tree grouped by section. owner+admin+family
  // read — settings are config, not secrets; family roles need read
  // access so the dashboard can render correctly. guests are 403'd
  // (no household-config visibility for short-lived guests).
  router.get(
    "/settings",
    requireRole("owner", "admin", "family"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const rows = (await prisma.workspaceSetting.findMany({
          orderBy: [{ section: "asc" }, { key: "asc" }],
        })) as unknown as SettingRow[];
        res.json({ settings: groupBySection(rows) });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /api/settings/:section ───────────────────────────────
  // Returns one section's entries. Same access posture as the full
  // tree. Unknown section name → 404 (the path-param is the resource
  // identifier; an unknown one is "no such resource").
  router.get(
    "/settings/:section",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const section = req.params.section;
        if (!isKnownSection(section)) {
          return res.status(404).json({ error: "Unknown section" });
        }

        const rows = (await prisma.workspaceSetting.findMany({
          where: { section: section as any },
          orderBy: [{ key: "asc" }],
        })) as unknown as SettingRow[];

        const entries: SettingEntry[] = rows.map((row) => ({
          key: row.key,
          type: row.type,
          value: row.valueJson,
          updatedAt: row.updatedAt,
        }));

        res.json({ section, entries });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PATCH /api/settings/:section ─────────────────────────────
  // owner+admin only. Body: `{[key]: value, ...}`. The section
  // path-param scopes the writable key-set; keys from other sections
  // → 400 (client bug). Each changed key:
  //   - is validated against its declared SettingType (per-type
  //     dispatch in `validateValue`),
  //   - updates the row's `valueJson`,
  //   - emits one ActivityRow with kind: system, severity: info.
  //
  // Same no-op short-circuit as PATCH /people/:id/role: an unchanged
  // value skips both the update AND the audit row so the dashboard
  // re-submitting the same form on focus loss doesn't pollute the
  // activity feed.
  router.patch(
    "/settings/:section",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const section = req.params.section;
        if (!isKnownSection(section)) {
          return res.status(404).json({ error: "Unknown section" });
        }

        const body = req.body;
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length === 0
        ) {
          return res.status(400).json({
            error: "Empty patch body — send at least one key",
          });
        }

        const actor = req.user?.username ?? null;
        const incomingKeys = Object.keys(body);

        // Pre-flight: every incoming key must live in the targeted
        // section AND exist in the table. Validation errors here
        // surface BEFORE any write so a partial failure can't leave
        // the table inconsistent.
        const rows = (await prisma.workspaceSetting.findMany({
          where: {
            key: { in: incomingKeys },
          },
        })) as unknown as SettingRow[];
        const byKey = new Map(rows.map((r) => [r.key, r]));

        for (const key of incomingKeys) {
          const row = byKey.get(key);
          if (!row) {
            return res.status(404).json({
              error: "Unknown setting key",
              key,
            });
          }
          if (row.section !== section) {
            return res.status(400).json({
              error: "Key does not belong to the target section",
              key,
              expectedSection: section,
              actualSection: row.section,
            });
          }
          const typeError = validateValue(
            row.type as TypeLiteral,
            key,
            body[key],
          );
          if (typeError) {
            return res.status(400).json({
              error: "Value failed type validation",
              key,
              type: row.type,
              detail: typeError,
            });
          }
        }

        // All validation passed — apply each change in turn. For each
        // key that genuinely changed, emit one ActivityRow.
        const changed: string[] = [];
        for (const key of incomingKeys) {
          const row = byKey.get(key)!;
          const nextValue = body[key];
          const prevValue = row.valueJson;

          // Deep-equality short-circuit. JSON.stringify is good
          // enough for the value-shapes this table carries
          // (primitives + small objects). For SettingType.json
          // payloads with deterministic key order this matches the
          // dashboard's serializer.
          if (JSON.stringify(prevValue) === JSON.stringify(nextValue)) {
            continue;
          }

          await prisma.workspaceSetting.update({
            where: { key },
            data: { valueJson: nextValue as any },
          });

          await recordActivity({
            kind: "system",
            severity: "info",
            sourceIcon: "settings",
            what: "Setting updated",
            sub: key,
            refs: {
              actor,
              key,
              section,
              type: row.type,
              previousValue: prevValue,
              nextValue,
            },
          });

          changed.push(key);
        }

        res.json({
          section,
          changed,
          ignored: incomingKeys.filter((k) => !changed.includes(k)),
        });
      } catch (err) {
        logger.warn(
          { err, section: req.params.section },
          "PATCH /settings failed",
        );
        next(err);
      }
    },
  );

  return router;
}
