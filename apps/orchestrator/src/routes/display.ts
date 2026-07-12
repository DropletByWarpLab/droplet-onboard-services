/**
 * Display routes — proxy to the OLED Display Service.
 * Exposes display control as orchestrator API endpoints and as LLM tool targets.
 */

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import * as displayClient from "../services/display.client.js";
import { requireRole } from "../middleware/auth.js";

export function createDisplayRouter(_prisma: PrismaClient): Router {
  const router = Router();

  router.get("/display/status", async (_req, res) => {
    const status = await displayClient.getDisplayStatus();
    if (!status) {
      return res.status(503).json({ error: "Display service unavailable" });
    }
    res.json(status);
  });

  router.post("/display/stats", async (_req, res) => {
    const ok = await displayClient.showStats();
    if (!ok) return res.status(503).json({ error: "Display service unavailable" });
    res.json({ ok: true, mode: "stats" });
  });

  router.post("/display/logo", async (_req, res) => {
    const ok = await displayClient.showLogo();
    if (!ok) return res.status(503).json({ error: "Display service unavailable" });
    res.json({ ok: true, mode: "logo" });
  });

  router.post("/display/message", async (req, res) => {
    const { title, lines } = req.body;
    if (!title || !Array.isArray(lines)) {
      return res.status(400).json({ error: "title (string) and lines (string[]) required" });
    }
    const ok = await displayClient.showMessage(title, lines);
    if (!ok) return res.status(503).json({ error: "Display service unavailable" });
    res.json({ ok: true, mode: "message" });
  });

  router.post("/display/brightness", async (req, res) => {
    const { value } = req.body;
    if (typeof value !== "number" || value < 0 || value > 255) {
      return res.status(400).json({ error: "value must be 0-255" });
    }
    const ok = await displayClient.setBrightness(value);
    if (!ok) return res.status(503).json({ error: "Display service unavailable" });
    res.json({ ok: true, brightness: value });
  });

  router.post("/display/cycle/resume", async (_req, res) => {
    const ok = await displayClient.resumeCycle();
    if (!ok) return res.status(503).json({ error: "Display service unavailable" });
    res.json({ ok: true, cycling: true });
  });

  router.post("/display/cycle/stop", async (_req, res) => {
    const ok = await displayClient.stopCycle();
    if (!ok) return res.status(503).json({ error: "Display service unavailable" });
    res.json({ ok: true, cycling: false });
  });

  // /display/wifi/connect — proxy to the display service's /wifi/connect
  // route. Admin/owner only: joining an SSID mutates host network state
  // and, combined with the appliance being the video/storage hub, a coerced
  // SSID join is a credible pivot vector. Non-privileged users (family,
  // guest) cannot invoke this even though they can hit other /display/*.
  // WARP-449: migrated off the inline req.user.role check onto the
  // canonical requireRole guard (same posture, now covered by the
  // rbac.test.ts matrix instead of a route-local check).
  router.post("/display/wifi/connect", requireRole("owner", "admin"), async (req, res) => {
    const { ssid, password } = req.body ?? {};
    if (typeof ssid !== "string" || ssid.length === 0 || ssid.length > 64) {
      return res.status(400).json({ error: "ssid (1-64 chars) required" });
    }
    if (password !== undefined && (typeof password !== "string" || password.length > 128)) {
      return res.status(400).json({ error: "password must be a string up to 128 chars" });
    }
    const result = await displayClient.connectWifi(ssid, password ?? "");
    if (!result) {
      return res.status(503).json({ error: "Display service unavailable" });
    }
    res.json(result);
  });

  return router;
}
