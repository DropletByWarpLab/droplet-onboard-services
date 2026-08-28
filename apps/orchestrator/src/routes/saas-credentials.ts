/**
 * WARP-2275 — the admin-only SaaS credential configurator.
 *
 * Routes owned by this file:
 *   GET   /api/integrations/credentials            — owner+admin. Every
 *                                                    descriptor-driven cloud
 *                                                    provider with its REDACTED
 *                                                    view (secrets collapse to
 *                                                    `hasValue` booleans).
 *   GET   /api/integrations/:provider/credentials  — owner+admin. One provider.
 *   PATCH /api/integrations/:provider/credentials  — owner+admin. Three-way
 *                                                    secret write: omit a field
 *                                                    to keep it, "" to clear it,
 *                                                    a value to replace it.
 *
 * Two non-negotiables, both copied from `settings-email.ts` rather than
 * reinvented:
 *
 *  1. **The guard is `requireRole("owner","admin")` at route REGISTRATION**
 *     (`middleware/auth.ts:773-793`). An inline `if (req.user.role !== "admin")`
 *     inside a handler returns the same 403 to the caller and is therefore
 *     invisible in review — but it skips `recordAccessDenied`, so a family
 *     member probing the credential API leaves no policy-violation row and the
 *     attempt never happened as far as the audit log is concerned.
 *  2. **Every body goes through a zod `safeParse`**, and a failure returns
 *     `400 {error, details: parsed.error.flatten()}` — no stack, and no
 *     submitted value echoed back (a 400 that quotes the rejected field would
 *     put a mistyped API key in the response body and every log between here
 *     and the browser).
 *
 * The file carries NO vendor knowledge. Fields, secrecy, requiredness and
 * format all come from the WARP-2217 descriptor.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { providerDescriptors } from "@droplet/shared-types";

import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import {
  buildCredentialView,
  requireDescriptor,
  resolveCredentialUpdate,
  statusAfterCredentialUpdate,
  SaasCredentialValidationError,
  UnknownProviderError,
  type SaasConnectionRow,
} from "../services/saas-credential.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("saas-credentials-route");

/**
 * The PATCH body.
 *
 * `fields` is a free-form map because the DESCRIPTOR decides which keys are
 * legal — a zod shape enumerating them here would be the fifth hand-edited site
 * WARP-2217 exists to delete. zod's job is the envelope (is this an object of
 * scalars?); the descriptor's job is the semantics.
 *
 * `.strict()` on the envelope so a typo'd top-level key is a 400 rather than a
 * silently ignored no-op that looks like a successful save.
 *
 * Critically, values are `z.union([z.string(), z.number()])` with NO default and
 * NO `.optional()` coercion: `undefined` (key absent) and `""` must stay
 * distinguishable all the way to `resolveCredentialUpdate`, because that
 * difference is keep-vs-clear.
 */
const patchSchema = z
  .object({
    fields: z.record(z.string(), z.union([z.string().max(4096), z.number()])),
  })
  .strict();

/** Only tracks that actually reach a vendor SaaS get a credential form. A
 *  `catalog` placeholder has no transport and nothing to authenticate to; a
 *  `lan` track's connection facts are real columns owned by the ERP wizard. */
function configurableDescriptors() {
  return providerDescriptors().filter((d) => d.track === "cloud");
}

type IntegrationPrisma = Pick<PrismaClient, "integrationConnection">;

export function createSaasCredentialsRouter(prisma: IntegrationPrisma): Router {
  const router = Router();

  async function findRow(provider: string): Promise<SaasConnectionRow | null> {
    const row = await prisma.integrationConnection.findFirst({ where: { provider } });
    return (row as SaasConnectionRow | null) ?? null;
  }

  // ── GET /api/integrations/credentials ───────────────────────
  router.get(
    "/integrations/credentials",
    requireRole("owner", "admin"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const descriptors = configurableDescriptors();
        const views = await Promise.all(
          descriptors.map(async (d) => buildCredentialView(d, await findRow(d.id))),
        );
        res.json({ providers: views });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /api/integrations/:provider/credentials ─────────────
  router.get(
    "/integrations/:provider/credentials",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const descriptor = requireDescriptor(req.params.provider);
        res.json(buildCredentialView(descriptor, await findRow(descriptor.id)));
      } catch (err) {
        if (err instanceof UnknownProviderError) {
          return res.status(404).json({ error: "Unknown provider", code: err.code });
        }
        next(err);
      }
    },
  );

  // ── PATCH /api/integrations/:provider/credentials ───────────
  router.patch(
    "/integrations/:provider/credentials",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const descriptor = requireDescriptor(req.params.provider);

        const parsed = patchSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid credential update",
            details: parsed.error.flatten(),
          });
        }

        const existing = await findRow(descriptor.id);

        // The row must exist before a credential can be AAD-bound to its id.
        // Created here, credential-less, rather than lazily inside the resolve
        // step: the AAD is the row id, so "which row is this sealed for?" has
        // to be answered before anything is sealed.
        const row =
          existing ??
          ((await prisma.integrationConnection.create({
            data: {
              provider: descriptor.id,
              status: "NOT_CONFIGURED",
              // The LAN columns are non-null in the schema and meaningless for
              // a cloud track. Empty strings say "not applicable" explicitly;
              // `secretRef` keeps the historical pending-pointer convention
              // rather than becoming this story's first writer of the
              // unimplemented secret store (ADR-041 §4 / WARP-2028).
              host: "",
              databaseName: "",
              secretRef: `${descriptor.id}:pending`,
            },
          })) as unknown as SaasConnectionRow);

        const resolved = resolveCredentialUpdate(
          descriptor,
          existing,
          parsed.data.fields,
          row.id,
        );

        const data: Record<string, unknown> = {
          status: statusAfterCredentialUpdate(row.status, resolved.hasSecret),
        };
        // `undefined` means "omitted" — the key is absent from the update, so
        // the stored ciphertext is left byte-identical. Writing `undefined`
        // explicitly would be the same to Prisma, but building the object this
        // way keeps the three-way rule readable at the call site.
        if (resolved.apiCredentialsEnc !== undefined) {
          data.apiCredentialsEnc = resolved.apiCredentialsEnc;
        }
        if (resolved.providerConfig !== undefined) {
          data.providerConfig = resolved.providerConfig;
        }

        const saved = (await prisma.integrationConnection.update({
          where: { id: row.id },
          data: data as never,
        })) as unknown as SaasConnectionRow;

        // AFTER the write commits. Recording first would log a change that a
        // failed update never made — the audit log would be describing a box
        // that does not exist.
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "key-round",
          what: resolved.cleared
            ? "Integration credential cleared"
            : "Integration credential updated",
          sub: descriptor.displayName,
          actor: actorFromRequest(req),
          refs: {
            provider: descriptor.id,
            // WHETHER a credential is stored — never the value, a prefix, a
            // length, or a hash. The audit row is not where a secret lives.
            hasSecret: resolved.hasSecret,
            cleared: resolved.cleared,
            status: saved.status,
          },
        });

        res.json(buildCredentialView(descriptor, saved));
      } catch (err) {
        if (err instanceof UnknownProviderError) {
          return res.status(404).json({ error: "Unknown provider", code: err.code });
        }
        if (err instanceof SaasCredentialValidationError) {
          // Same 400 envelope as the zod failure. `fieldErrors` mirrors
          // `flatten()`'s shape so the form has one error contract to render,
          // and carries only field NAMES and messages — never the values.
          return res.status(400).json({
            error: "Invalid credential update",
            details: { formErrors: [], fieldErrors: err.fieldErrors },
          });
        }
        // Deliberately no `err` in the log payload: a validation throw can
        // carry the submitted value in its message, and rule 19 says a captured
        // secret never reaches a log line.
        logger.warn(
          { provider: req.params.provider },
          "PATCH /integrations/:provider/credentials failed",
        );
        next(err);
      }
    },
  );

  return router;
}
