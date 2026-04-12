/**
 * Display routes — proxy to the OLED Display Service.
 * Exposes display control as orchestrator API endpoints and as LLM tool targets.
 */

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import * as displayClient from "../services/display.client.js";

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

  return router;
}
