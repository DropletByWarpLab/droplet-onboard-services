/**
 * Managed switch API routes — port status, VLANs, PoE, WAN detection.
 *
 * Proxies requests to the switch service (default :8081) which talks
 * to the hardware via the active driver (Lantronix for prototype,
 * custom ASIC for production).
 */

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import * as switchClient from "../services/switch.client.js";

const logger = pino({ name: "switch-routes" });

export function createSwitchRouter(prisma: PrismaClient): Router {
  const router = Router();

  // --- Port Management ---

  router.get("/switch/ports", async (_req, res, next) => {
    try {
      const ports = await switchClient.fetchPorts();
      res.json({ ports });
    } catch (err) {
      next(err);
    }
  });

  router.get("/switch/ports/:port", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 10) {
        return res.status(400).json({ error: "Invalid port number (1-10)" });
      }
      const data = await switchClient.fetchPort(port);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/ports/:port/enable", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 10) {
        return res.status(400).json({ error: "Invalid port number" });
      }
      await switchClient.enablePort(port);
      res.json({ status: "ok", port, enabled: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/ports/:port/disable", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 10) {
        return res.status(400).json({ error: "Invalid port number" });
      }
      await switchClient.disablePort(port);
      res.json({ status: "ok", port, enabled: false });
    } catch (err) {
      next(err);
    }
  });

  // --- VLAN Management ---

  router.get("/switch/vlans", async (_req, res, next) => {
    try {
      const vlans = await switchClient.fetchVlans();
      res.json({ vlans });
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/vlans", async (req, res, next) => {
    try {
      const { vlan_id, name } = req.body;
      if (!vlan_id || vlan_id < 2 || vlan_id > 4094) {
        return res.status(400).json({ error: "VLAN ID must be 2-4094" });
      }
      await switchClient.createVlan(vlan_id, name || "");
      res.json({ status: "ok", vlan_id });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/switch/vlans/:vlanId", async (req, res, next) => {
    try {
      const vlanId = parseInt(req.params.vlanId);
      if (isNaN(vlanId) || vlanId < 2) {
        return res.status(400).json({ error: "Invalid VLAN ID" });
      }
      await switchClient.deleteVlan(vlanId);
      res.json({ status: "ok", vlan_id: vlanId, deleted: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/switch/vlans/:vlanId/membership", async (req, res, next) => {
    try {
      const vlanId = parseInt(req.params.vlanId);
      const data = await switchClient.fetchVlanMembership(vlanId);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/vlans/:vlanId/membership", async (req, res, next) => {
    try {
      const vlanId = parseInt(req.params.vlanId);
      const { ports } = req.body;
      if (!Array.isArray(ports)) {
        return res.status(400).json({ error: "ports must be an array" });
      }
      await switchClient.setVlanMembership(vlanId, ports);
      res.json({ status: "ok", vlan_id: vlanId });
    } catch (err) {
      next(err);
    }
  });

  // --- PoE Control ---

  router.get("/switch/poe", async (_req, res, next) => {
    try {
      const ports = await switchClient.fetchPoeStatus();
      res.json({ ports });
    } catch (err) {
      next(err);
    }
  });

  router.get("/switch/poe/:port", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 8) {
        return res.status(400).json({ error: "PoE port must be 1-8 (copper only)" });
      }
      const data = await switchClient.fetchPortPoe(port);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/poe/:port/enable", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 8) {
        return res.status(400).json({ error: "PoE port must be 1-8" });
      }
      await switchClient.enablePortPoe(port);
      res.json({ status: "ok", port, poe_enabled: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/switch/poe/:port/disable", async (req, res, next) => {
    try {
      const port = parseInt(req.params.port);
      if (isNaN(port) || port < 1 || port > 8) {
        return res.status(400).json({ error: "PoE port must be 1-8" });
      }
      await switchClient.disablePortPoe(port);
      res.json({ status: "ok", port, poe_enabled: false });
    } catch (err) {
      next(err);
    }
  });

  // --- System ---

  router.get("/switch/system", async (_req, res, next) => {
    try {
      const info = await switchClient.fetchSystemInfo();
      res.json(info);
    } catch (err) {
      next(err);
    }
  });

  // --- WAN Detection ---

  router.post("/switch/wan/detect", async (_req, res, next) => {
    try {
      const result = await switchClient.detectWanPort();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // --- Camera Setup ---

  router.post("/switch/setup/cameras", async (req, res, next) => {
    try {
      const { vlan_id, camera_ports, uplink_ports } = req.body || {};
      const result = await switchClient.setupCameraPorts(
        vlan_id,
        camera_ports,
        uplink_ports
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
