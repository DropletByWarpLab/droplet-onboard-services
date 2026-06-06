/**
 * WARP-823 — downloadable, secret-redacted diagnostics log bundle.
 *
 *   POST /api/logs/bundle   — owner/admin only. Streams a .zip of the host's
 *                             service logs over a bounded time window, with
 *                             EVERY byte passed through redactSecrets() before
 *                             it lands in the archive. The download is recorded
 *                             on the signed activity chain.
 *
 * Architecture (see logs-bridge.service.ts): the orchestrator can NOT read the
 * host's journald/docker logs itself, and arbitrary child_process shell-out
 * from this network-facing tier is forbidden. The only host-exec path is the
 * device-bridge, which execs a repo-tracked host collector script. This route
 * fetches that output through the bridge, redacts defensively, zips, streams.
 *
 * RBAC: owner/admin per ADR-004 — a log bundle can reveal cross-user metadata
 * and (pre-redaction) secret material, so family/guest are kept out. The guard
 * mirrors the local `requireOwnerOrAdmin` used by activity.ts / admin routes
 * rather than a generic middleware that doesn't exist in the codebase today.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import archiver from "archiver";
import { z } from "zod";
import pino from "pino";
import { fetchLogBundleFromBridge } from "../services/logs-bridge.service.js";
import { redactSecrets } from "../lib/log-redaction.js";
import { recordActivity } from "../services/activity.singleton.js";
import { RouterError } from "../types/router-error.js";

const logger = pino({ name: "logs-route" });

/**
 * Owner/admin gate for the diagnostics surface. Same shape as the local
 * `requireOwnerOrAdmin` in activity.ts — keeps the RBAC contract uniform.
 */
function requireOwnerOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const role = req.user?.role;
  if (role === "owner" || role === "admin") {
    next();
    return;
  }
  res.status(403).json({ error: "owner or admin role required" });
}

/** Bounded look-back window. Capped so a request can't ask the host to collect
 *  an unbounded volume of journald history. */
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 168; // 7 days
const DEFAULT_WINDOW_HOURS = 24;

const bundleBodySchema = z.object({
  /** Look-back window in hours; defaults to 24, capped at 7 days. */
  windowHours: z.coerce
    .number()
    .int()
    .min(MIN_WINDOW_HOURS)
    .max(MAX_WINDOW_HOURS)
    .optional(),
  /** Optional single-service filter (e.g. "orchestrator"). */
  service: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, "invalid service name")
    .optional(),
});

/** Make a safe, stable file name for a service's log entry inside the zip. */
function safeEntryName(service: string): string {
  const slug = service.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "service";
  return `logs/${slug}.log`;
}

export function createLogsRouter(): Router {
  const router = Router();

  // ── POST /api/logs/bundle ──
  router.post("/logs/bundle", requireOwnerOrAdmin, async (req, res, next) => {
    const parsed = bundleBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten(),
      });
      return;
    }
    const windowHours = parsed.data.windowHours ?? DEFAULT_WINDOW_HOURS;
    const service = parsed.data.service;

    // 1) Pull the (host-side redacted) logs through the device-bridge. Any
    //    failure here is surfaced BEFORE we set download headers so the client
    //    gets a clean JSON error, not a half-written zip.
    let bundle;
    try {
      bundle = await fetchLogBundleFromBridge({ windowHours, service });
    } catch (err) {
      if (err instanceof RouterError) {
        // UNREACHABLE/TIMEOUT carry 503; UNKNOWN carries its own status (or 500
        // via the global handler). Render the structured shape the dashboard
        // branches on.
        res.status(err.status ?? 500).json(err.toJSON());
        return;
      }
      if ((err as { code?: string }).code === "BRIDGE_AUTH_UNCONFIGURED") {
        // The bridge secret isn't provisioned — diagnostics can't be collected.
        // 503 (dependency unavailable) + a code the UI can branch on.
        res.status(503).json({
          code: "BRIDGE_AUTH_UNCONFIGURED",
          error:
            "Diagnostics can't be collected — the device-bridge isn't configured on this box.",
        });
        return;
      }
      next(err);
      return;
    }

    // 2) Build the zip. archiver streams, so memory stays bounded even for a
    //    large 7-day capture. We pipe it straight to the response.
    const filename = `droplet-diagnostics-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    // If the archiver errors mid-stream we can't change the status (headers are
    // sent) — log it and tear the connection down so the client sees a failed
    // download rather than a silently-truncated-but-200 zip.
    archive.on("error", (err) => {
      logger.error({ err }, "log bundle archiver error");
      res.destroy(err);
    });
    archive.pipe(res);

    // 2a) Manifest first — what's in the bundle + the redaction guarantee, so
    //     a recipient knows the window, services, and that secrets were scrubbed.
    const manifest = {
      type: "droplet.diagnostics-bundle.v1",
      collectedAt: bundle.collected_at,
      windowHours: bundle.window_hours,
      truncated: bundle.truncated,
      redaction:
        "Secret values (tokens, passwords, keys, connection-string credentials, " +
        "PEM private keys) have been redacted and replaced with [REDACTED].",
      services: bundle.services.map((s) => ({
        name: s.name,
        source: s.source,
        ...(s.note ? { note: s.note } : {}),
        file: safeEntryName(s.name),
      })),
    };
    archive.append(JSON.stringify(manifest, null, 2) + "\n", {
      name: "manifest.json",
    });

    // 2b) One file per service. redactSecrets() runs AGAIN here (defense in
    //     depth) so the guarantee holds even if the host collector missed
    //     something — this is the gate the planted-secret route test asserts on.
    for (const svc of bundle.services) {
      const header =
        `# service: ${svc.name}\n# source: ${svc.source}\n` +
        (svc.note ? `# note: ${svc.note}\n` : "") +
        `# window: last ${bundle.window_hours}h\n\n`;
      const body = redactSecrets(svc.lines ?? "");
      archive.append(header + body + "\n", { name: safeEntryName(svc.name) });
    }

    // 3) Audit the export on the signed chain (AC4). Best-effort — recordActivity
    //    swallows its own failures; we never block/fail the download on it. We
    //    record the metadata (who, window, service count) — NEVER the log bytes.
    await recordActivity({
      kind: "system",
      severity: "info",
      sourceIcon: "download",
      what: "Diagnostics log bundle downloaded",
      sub: `${bundle.services.length} service(s), last ${bundle.window_hours}h${
        service ? ` · ${service}` : ""
      }`,
      refs: {
        by: req.user?.id ?? null,
        windowHours: bundle.window_hours,
        serviceCount: bundle.services.length,
        truncated: bundle.truncated,
        ...(service ? { service } : {}),
      },
    });

    await archive.finalize();
  });

  return router;
}
