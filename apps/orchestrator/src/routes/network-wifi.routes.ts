/**
 * WiFi routes — read settings, scan, and Tier 1/2 writes for SSID,
 * password, and channel.
 */

import type { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  getWifiSettings,
  getRadioDetail,
  scanWifiNetworks,
  setWifiSsid,
  setWifiPassword,
  setWifiChannel,
  setGuestWifi,
  getGuestWifi,
  removeGuestWifi,
} from "../services/network.service.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";
import {
  ApOnboardError,
  getBandSteering,
  setBandSteering,
  getApWifi,
  setApWifi,
} from "../services/ap-onboard.service.js";
import { getCurrentWifi } from "../services/current-wifi.service.js";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";

export interface WifiDeps {
  prisma: PrismaClient;
}

export function registerWifiRoutes(router: Router, deps: WifiDeps): void {
  const { prisma } = deps;

  router.get("/network/wifi", async (_req, res, next) => {
    try {
      const wifi = await getWifiSettings();
      res.json(wifi);
    } catch (err) {
      next(err);
    }
  });

  /**
   * WARP-1714: the Wi-Fi this household is actually broadcasting, so the Wi-Fi
   * card can open showing the network it's about to edit instead of two empty
   * boxes. Resolves the router's live AP interface first, then an approved AP
   * — on the edge-router shape the router hosts nothing and the SSID lives
   * only on the AP.
   *
   * owner/admin only: the body carries the PSK, same tier as the write that
   * sets it and as the guest-Wi-Fi read directly below.
   */
  router.get("/network/wifi/current", requireRole("owner", "admin"), async (_req, res, next) => {
    try {
      // A router we can't reach must not fail the card — getCurrentWifi still
      // answers from the AP, and reports honestly when nothing can be read.
      const wifi = await getWifiSettings().catch(() => null);
      res.json(await getCurrentWifi(prisma, wifi));
    } catch (err) {
      next(err);
    }
  });

  router.get("/network/wifi/scan", async (_req, res, next) => {
    try {
      const results = await scanWifiNetworks();
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  // Read-only host-radio detail (iwinfo). No write, no Tier — the single-box has
  // one combined hostapd radio that can't be toggled independently, so the
  // service returns an honesty envelope (supported:false/hostRadio:true) and
  // only the iwinfo fields it can actually read.
  router.get("/network/wifi/radio", async (_req, res, next) => {
    try {
      const radio = await getRadioDetail();
      res.json(radio);
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner + admin only — changing the
  // household's SSID drops every connected device, so this stays in
  // the household-admin tier. The MCP principal is additionally
  // admitted so the set_wifi_ssid tool reaches the safety layer; the
  // tool itself gates on an explicit user confirmation first.
  router.post("/network/wifi/ssid", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const { radio = "radio0", iface_section = "default_radio0", ssid } = req.body;
      if (!ssid || typeof ssid !== "string") {
        return res.status(400).json({ error: "Missing 'ssid' in request body" });
      }

      // The household Wi-Fi may be broadcast by a separate approved access point
      // (the edge-router shape), not this router's radio. Writing the SSID here
      // would land on a disabled/absent radio and FALSELY report success — the
      // gap that leaves the set_wifi_ssid MCP tool writing into the void (audit
      // 2026-08-06). Resolve where the Wi-Fi actually lives; when it's on the
      // AP, refuse with a pointer to the AP control rather than lying. The
      // dashboard already routes AP-hosted edits to PUT /network/wifi/ap — this
      // closes the same gap for the MCP tool and any legacy caller. Single-box
      // (hostapd on the router's own radio) resolves to source:"router" and is
      // unaffected.
      const current = await getCurrentWifi(
        prisma,
        await getWifiSettings().catch(() => null),
      );
      if (current.source === "ap") {
        return res.status(409).json({
          error:
            "This Droplet's Wi-Fi is broadcast by a separate access point — " +
            "change the network name from the access-point Wi-Fi settings.",
          code: "WIFI_ON_ACCESS_POINT",
        });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "wireless.ssid", "set_ssid", { radio, iface_section, ssid }, userId
      );

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      // WARP-808: pass userId so the single-box hostapd SSID stage is keyed per
      // authenticated user (the password/confirm write consumes the same key).
      await setWifiSsid(radio, iface_section, ssid, userId);
      res.json({ status: "ok", ssid, tier: result.tier });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner + admin only. WARP-1443: the MCP
  // principal is additionally admitted so the set_wifi_password tool
  // reaches the safety layer — set_wifi_password is Tier-2, so the AI
  // path only ever mints a 202 confirmation token here; the confirm
  // endpoint that executes it stays human-only. Human RBAC unchanged.
  router.post("/network/wifi/password", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const { iface_section = "default_radio0", password } = req.body;
      if (!password || typeof password !== "string") {
        return res.status(400).json({ error: "Missing 'password' in request body" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "wireless.password", "set_wifi_password", { iface_section, password }, userId
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "set_wifi_password",
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      // WARP-808: same userId key so applyWifi consumes the SSID this user
      // staged on the preceding /wifi/ssid call (single-box hostapd path).
      const op = await setWifiPassword(iface_section, password, userId);
      res.json({ status: "ok", tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // Guest Wi-Fi read — owner/admin only (the body carries the guest PSK so the
  // dashboard can render the join QR). A guest network is the household admin's
  // to manage; family/guest roles don't see its password.
  router.get("/network/wifi/guest", requireRole("owner", "admin"), async (_req, res, next) => {
    try {
      res.json(await getGuestWifi());
    } catch (err) {
      next(err);
    }
  });

  // Guest Wi-Fi teardown — owner/admin only. Turning guest Wi-Fi off only drops
  // guest devices (never the household LAN) and is trivially reversible, so it
  // applies immediately rather than through the Tier-2 confirm arm that
  // creating a new broadcasting SSID warrants.
  router.delete("/network/wifi/guest", requireRole("owner", "admin"), async (_req, res, next) => {
    try {
      const op = await removeGuestWifi();
      res.json({ status: "ok", operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // Guest Wi-Fi — owner/admin only. Creating the guest network stands up a new
  // SSID on its own isolated firewall zone, so it is Tier 2 (create_guest_network
  // in network-safety-rules): the orchestrator may answer 202 + token, the
  // dashboard confirm IS the consent. No MCP principal — guest-network setup is
  // a deliberate household-admin action, not an AI-driven one.
  router.post("/network/wifi/guest", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      // Guest Wi-Fi is supported on BOTH shapes now: the single-box hostapd path
      // provisions a second BSS via the device-bridge (setGuestWifi branches on
      // DROPLET_AP_MODE), and the multi-box UCI path creates the guest wifi-iface
      // against the overlay's guest network/zone/pool. No honesty gate here — the
      // box-side provisioning is real on each shape.
      const { radio = "radio3", ssid, password, network = "guest" } = req.body;
      // Mirror services/routing/schemas.py CreateGuestNetworkRequest (SSID 1–32,
      // PSK 8–63) so the box never sees a payload hostapd would reject.
      if (!ssid || typeof ssid !== "string") {
        return res.status(400).json({ error: "Missing 'ssid' in request body" });
      }
      if (ssid.length > 32) {
        return res.status(400).json({ error: "Guest network name (SSID) must be 32 characters or fewer" });
      }
      if (!password || typeof password !== "string") {
        return res.status(400).json({ error: "Missing 'password' in request body" });
      }
      if (password.length < 8 || password.length > 63) {
        return res.status(400).json({ error: "Guest Wi-Fi password must be 8–63 characters" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "wireless.guest", "create_guest_network", { radio, ssid, password, network }, userId
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "create_guest_network",
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      const op = await setGuestWifi(radio, ssid, password, network);
      res.json({ status: "ok", ssid, network, tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner + admin only, plus the MCP
  // principal for the set_wifi_channel tool (confirmation gated
  // in-handler, same as set_wifi_ssid).
  router.post("/network/wifi/channel", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const { radio_section = "radio0", channel } = req.body;
      if (channel === undefined) {
        return res.status(400).json({ error: "Missing 'channel' in request body" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "wireless.channel", "set_channel", { radio_section, channel }, userId
      );

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      const op = await setWifiChannel(radio_section, String(channel));
      res.json({ status: "ok", channel, tier: result.tier, operationId: op.operationId });
    } catch (err) {
      next(err);
    }
  });

  // WARP-1703: band-steering read — no RBAC, matches GET /network/wifi/radio.
  // The honesty envelope ({supported:false, enabled:false} when no approved
  // Droplet AP is online) comes from the service, never inferred here.
  router.get("/network/wifi/band-steering", async (_req, res, next) => {
    try {
      res.json(await getBandSteering(prisma));
    } catch (err) {
      if (err instanceof ApOnboardError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      next(err);
    }
  });

  // WARP-1703: band-steering write — owner/admin only, Tier 2
  // (set_ap_band_steering, classified in network-safety-rules.ts). NOT
  // set_channel-shaped: the AP applier renames the 5 GHz SSID to `<ssid>-5g`
  // when steering is off, so flipping this drops every 5 GHz client onto a
  // network name that no longer exists and each one must be reconnected by
  // hand — and the write fans out to every ONLINE AP at once. Confirmation is
  // required, same as set_wifi_password / create_guest_network.
  // No MCP principal: there is no band-steering tool yet; this is a
  // deliberate household-admin toggle in the dashboard.
  router.put("/network/wifi/band-steering", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "`enabled` must be a boolean" });
      }

      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "wireless.band_steering", "set_ap_band_steering", { enabled }, userId
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "set_ap_band_steering",
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      const op = await setBandSteering(prisma, enabled);
      res.json({ status: "ok", enabled, tier: result.tier, operationId: op.operationId });
    } catch (err) {
      if (err instanceof ApOnboardError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      next(err);
    }
  });

  // WARP-1712: the ACCESS POINT's own network name + passphrase, so the
  // Network tab drives the AP as well as the router.
  //
  // owner/admin ONLY on the READ — unlike the band-steering read, the body
  // carries the live Wi-Fi passphrase so the dashboard can reveal it instead
  // of sending someone to ssh. Same posture as GET /network/wifi/guest, which
  // carries the guest PSK for the join QR.
  //
  // Nothing is cached: the service dials the AP every time, so this response
  // and the Coverage Extenders card can never drift apart.
  router.get("/network/wifi/ap", requireRole("owner", "admin"), async (_req, res, next) => {
    try {
      res.json(await getApWifi(prisma));
    } catch (err) {
      if (err instanceof ApOnboardError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      next(err);
    }
  });

  // WARP-1712: write. owner/admin only, and the tier follows the ROUTER's
  // established split rather than inventing a new posture:
  //   * name only     → `set_ap_wifi_ssid`     — Tier 1, applies immediately
  //                      (matches `set_ssid`, the setup-wizard contract);
  //   * password (±name) → `set_ap_wifi_password` — Tier 2, confirm first
  //                      (matches `set_wifi_password` — every device on the
  //                      AP has to re-authenticate with a new secret).
  // A save carrying both is evaluated at the stronger of the two, so the
  // confirm always covers the whole change.
  //
  // No MCP principal: there is no AP-Wi-Fi tool, and renaming the household
  // network is a deliberate admin action, not an AI-driven one.
  router.put("/network/wifi/ap", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { ssid, key } = req.body ?? {};
      if (ssid !== undefined && typeof ssid !== "string") {
        return res.status(400).json({ error: "`ssid` must be a string" });
      }
      if (key !== undefined && typeof key !== "string") {
        return res.status(400).json({ error: "`key` must be a string" });
      }
      if (ssid === undefined && key === undefined) {
        return res
          .status(400)
          .json({ error: "Provide a network name and/or password — nothing to change." });
      }
      // Mirror services/routing/main.py `_validate_ap_wireless` so the box
      // never sees a payload its hostapd would reject. SSID is capped in
      // BYTES — the 802.11 element is 32 octets.
      if (ssid !== undefined) {
        const bytes = Buffer.byteLength(ssid, "utf8");
        if (bytes < 1 || bytes > 32) {
          return res
            .status(400)
            .json({ error: "Network name (SSID) must be 1–32 bytes." });
        }
      }
      if (key !== undefined && (key.length < 8 || key.length > 63)) {
        return res
          .status(400)
          .json({ error: "Wi-Fi password must be 8–63 characters." });
      }

      const operation = key !== undefined ? "set_ap_wifi_password" : "set_ap_wifi_ssid";
      const userId = req.user?.id;
      // The params ride the pending-confirmation record, because the Tier-2
      // confirm executes in a SEPARATE request and the dispatcher in
      // network-status.routes.ts replays them — exactly how set_wifi_password
      // and create_guest_network already carry their secrets.
      const result = await evaluateNetworkCommand(
        prisma,
        "wireless.ap",
        operation,
        { ssid, key },
        userId,
      );

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation,
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }

      // WARP-1761: `userId` rides along as the intent's `writtenBy` — audit
      // only, nothing branches on it. The response below is unchanged.
      const op = await setApWifi(prisma, { ssid, key }, userId);
      res.json({
        status: "ok",
        tier: result.tier,
        ssid: op.ssid,
        fiveGhzSsid: op.fiveGhzSsid,
        operationId: op.operationId,
      });
    } catch (err) {
      if (err instanceof ApOnboardError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      next(err);
    }
  });
}
