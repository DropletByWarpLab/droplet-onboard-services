/**
 * network-ssh.routes.ts — WARP-1984, WARP-2887.
 *
 * The dashboard's "Allow SSH" control (Network → System). Read the current
 * state; ask the host to allow or disallow an SSH login to the appliance;
 * and (WARP-2887) set the username + password that login uses.
 *
 * Its own file rather than a block inside network-firewall.routes.ts, whose
 * `set_upnp` toggle it otherwise resembles: every other write on this router
 * reconfigures the ROUTER through the routing service, while this one starts
 * and stops a service on the APPLIANCE and touches no firewall at all. Filing
 * it under "firewall" would imply a packet-filter change that does not happen
 * and would invite someone to add one.
 *
 * ── WHY THERE IS NO MCP PRINCIPAL ───────────────────────────────────────────
 * `requireRole("owner", "admin")` — NOT `requireRoleOrMcpService`. This
 * follows the reasoning already written on the UPnP route: opening access is a
 * deliberate human action, not an AI-driven one. `set_ssh_access` and
 * `set_ssh_login` are additionally classified Tier 3 in
 * network-safety-rules.ts, which blocks them for AI callers at a second,
 * independent layer. Two refusals, neither relying on the other — the same
 * posture as the VPN and firmware operations.
 *
 * ── WHERE THE PASSWORD GOES ─────────────────────────────────────────────────
 * Nowhere. The login route hashes it (lib/sha512-crypt.ts) BEFORE calling the
 * safety evaluator, so the pending-confirmation record carries the shadow
 * hash, the audit row carries a redacted field, and the intent file the host
 * reads carries the hash. The plaintext exists only inside this request.
 */

import type { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";
import { readSshAccess, setSshAccess, setSshLogin } from "../services/ssh-access.service.js";
import {
  isValidSshLoginPassword,
  isValidSshLoginUsername,
  SSH_LOGIN_PASSWORD_MAX,
  SSH_LOGIN_PASSWORD_MIN,
  SSH_LOGIN_RESERVED,
} from "@droplet/shared-types";
import { sha512Crypt } from "../lib/sha512-crypt.js";
import { requireRole } from "../middleware/auth.js";

export interface SshRouteDeps {
  prisma: PrismaClient;
}

export function registerSshRoutes(router: Router, deps: SshRouteDeps): void {
  const { prisma } = deps;

  /**
   * Current SSH access, as the HOST last reported it. Owner/admin only: on a
   * shared appliance "is there a shell open on this box right now?" is itself
   * a security-relevant fact, and the answer is of no use to a role that
   * cannot change it.
   */
  router.get("/network/ssh", requireRole("owner", "admin"), async (_req, res, next) => {
    try {
      res.json(await readSshAccess());
    } catch (err) {
      next(err);
    }
  });

  /**
   * Allow or disallow SSH. Tier 3, so the safety evaluator mints a
   * confirmation token and this returns 202 until the operator confirms —
   * the same two-step the dashboard already renders for reboot and VPN.
   */
  router.post("/network/ssh", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { enabled } = req.body ?? {};
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "`enabled` must be a boolean" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma,
        "system.ssh",
        "set_ssh_access",
        { enabled },
        userId,
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "set_ssh_access",
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(403).json({ error: result.reason, tier: result.tier });
      }

      res.json(await setSshAccess(enabled));
    } catch (err) {
      next(err);
    }
  });

  /**
   * WARP-2887 — set the login (username + password) the SSH door uses.
   * Tier 3 like the toggle. The password is hashed here and only the hash
   * travels: into the token, the audit row (redacted), and the intent file.
   */
  router.post("/network/ssh/login", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      // The accept/reject decision is the shared predicate's, so the dashboard,
      // this route and the service cannot drift (WARP-2887 review). The
      // constants are used only to phrase the human message.
      if (typeof username !== "string" || !isValidSshLoginUsername(username)) {
        const reserved = typeof username === "string" && SSH_LOGIN_RESERVED.has(username);
        return res.status(400).json({
          error: reserved
            ? `“${username}” is a system account and can’t be used for the login.`
            : "Username must be 3–32 characters: lowercase letters, digits, `_` or `-`, starting with a letter.",
        });
      }
      if (typeof password !== "string" || !isValidSshLoginPassword(password)) {
        return res.status(400).json({
          error: `Password must be ${SSH_LOGIN_PASSWORD_MIN}–${SSH_LOGIN_PASSWORD_MAX} characters.`,
        });
      }

      const passwordHash = sha512Crypt(password);
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma,
        "system.ssh",
        "set_ssh_login",
        { username, passwordHash },
        userId,
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "set_ssh_login",
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(403).json({ error: result.reason, tier: result.tier });
      }

      res.json(await setSshLogin({ username, passwordHash }));
    } catch (err) {
      next(err);
    }
  });
}
