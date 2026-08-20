/**
 * WARP-2115 / ADR-041 — the Microsoft 365 connection control plane.
 *
 *   GET    /api/m365/connection   The signed-in person's own link: state,
 *                                 which account, granted scopes, last refresh.
 *                                 Never any token material.
 *   POST   /api/m365/connect      Begin a device-code sign-in. Returns the code
 *                                 and the Microsoft URL to enter it at. The
 *                                 sign-in completes in the background; the UI
 *                                 polls GET /connection to follow it.
 *   DELETE /api/m365/connection   Unlink and PURGE the stored token.
 *
 * **Every route is scoped to the requester's own connection.** There is no
 * `:userId` parameter anywhere by design: delegated authorization means one
 * person's Microsoft link is theirs, and an admin must not be able to drive
 * (or read the state of) someone else's mailbox connection through this API.
 *
 * `connect` is deliberately not restricted to owner/admin. Under ADR-041 a
 * cloud connector is enabled per person — each staff member links their own
 * account, and the box reads Microsoft *as them*. Gating this to admins would
 * either block ordinary users from the feature or push the design toward
 * tenant-wide application permissions, which ADR-041 rules out.
 */
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { requireRole } from "../middleware/auth.js";
import {
  beginDeviceCodeConnect,
  disconnect,
  getConnectionView,
  type EntraClient,
} from "../services/m365/m365-auth.service.js";
import {
  createEntraClient,
  isM365Configured,
  M365NotConfiguredError,
} from "../services/m365/entra-client.js";
import { classifyAuthFailure, redactAuthError } from "../services/m365/state.js";

type AuthedRequest = {
  user?: { id?: string; username?: string; role?: string };
};

/** Everyone who can hold a mailbox can link one. Guests and service principals
 *  cannot — they have no business connecting a business's Microsoft account. */
const CONNECT_ROLES = ["owner", "admin", "family"] as const;

export function createM365Router(
  prisma: PrismaClient,
  entra: EntraClient = createEntraClient(),
): Router {
  const router = Router();

  router.get(
    "/m365/connection",
    requireRole(...CONNECT_ROLES),
    async (req, res) => {
      const userId = (req as AuthedRequest).user?.id;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      const view = await getConnectionView(prisma, userId);
      return res.json({
        ...view,
        // Lets the dashboard distinguish "you have not connected yet" from
        // "this device cannot offer Microsoft 365 at all", which are different
        // things to tell a person.
        available: isM365Configured(),
      });
    },
  );

  router.post(
    "/m365/connect",
    requireRole(...CONNECT_ROLES),
    async (req, res) => {
      const userId = (req as AuthedRequest).user?.id;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      try {
        const started = await beginDeviceCodeConnect(prisma, entra, userId);
        return res.status(202).json({
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          expiresAt: started.expiresAt,
          message: started.message,
        });
      } catch (err) {
        if (err instanceof M365NotConfiguredError) {
          // 503, not 500: the device is not set up for this yet. Nothing the
          // person did is wrong and retrying will not help.
          return res.status(503).json({
            error: "m365_not_configured",
            message: "Microsoft 365 is not set up on this device yet.",
          });
        }

        const failure = (err ?? {}) as { errorCode?: string; errorMessage?: string };
        const kind = classifyAuthFailure(failure);
        // A tenant that blocks device code flow lands here. It is a real,
        // expected configuration answer — surfaced so the dashboard can offer
        // the sign-in-in-a-browser path instead of just failing.
        return res.status(kind === "ERROR" ? 502 : 409).json({
          error: kind === "ERROR" ? "m365_sign_in_unavailable" : "m365_needs_reconnect",
          message: redactAuthError(failure),
        });
      }
    },
  );

  router.delete(
    "/m365/connection",
    requireRole(...CONNECT_ROLES),
    async (req, res) => {
      const userId = (req as AuthedRequest).user?.id;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      await disconnect(prisma, userId);
      return res.status(204).send();
    },
  );

  return router;
}
