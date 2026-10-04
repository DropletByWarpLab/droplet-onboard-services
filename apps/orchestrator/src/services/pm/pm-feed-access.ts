/**
 * WARP-3533 — the Projects gates, re-checked where the route bypasses them.
 *
 * `/api/pm/*` is behind two things `mountModuleGates` puts in front of it: the
 * `projects` module's workspace switch, and the tier floor (an external guest
 * gets nothing from company-wide business data — WARP-3369). The ICS feed
 * `GET /api/calendar/publish/:user/…` is mounted BEFORE every gate (a phone
 * subscribes with a link and no session), and the Developer page's feed
 * management lives outside `/api/pm` on purpose (so an API token cannot reach
 * it). Neither gets those gates from the router, so each asks here, once, with
 * the person's role as the database says it now.
 *
 * The refusal is the gates' own answer, byte for byte: 404 `module_disabled`.
 * A surface a person may not open reads as absent, not forbidden.
 *
 * Fails closed: if the module state cannot be read, the answer is "disabled".
 */
import type { ModuleId, PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { getEffectiveModuleIds } from "../modules.service.js";
import { isGateableModuleId, maxLevelFor } from "../access-catalog.js";
import type { Role } from "../jwt.service.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("pm-feed-access");

const PROJECTS: ModuleId = "projects";

export interface PmFeedRefusal {
  status: 404;
  body: { error: "module_disabled"; module: "projects" };
}

const REFUSAL: PmFeedRefusal = { status: 404, body: { error: "module_disabled", module: "projects" } };

/**
 * Null when `role` may read Projects through a feed; the refusal otherwise.
 * `role` is the person's current role (a database read at this request), never
 * a value carried in a link or a session.
 */
export async function pmFeedAccessRefusal(prisma: PrismaClient, role: string): Promise<PmFeedRefusal | null> {
  let effective: ReadonlySet<ModuleId>;
  try {
    effective = await getEffectiveModuleIds(prisma, config);
  } catch (err) {
    logger.error({ err }, "pm_feed_module_read_failed");
    return REFUSAL;
  }
  if (!effective.has(PROJECTS)) return REFUSAL;
  // The tier floor, as requireModuleTierFloor asks it: no level at all = refused.
  if (isGateableModuleId(PROJECTS) && maxLevelFor(role as Role, PROJECTS) === null) return REFUSAL;
  return null;
}
