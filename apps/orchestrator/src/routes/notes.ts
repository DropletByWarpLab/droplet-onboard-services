/**
 * /api/notes — the user's own notes, stored on the box.
 *
 * Identity: every endpoint reads the username from req.user (populated by the
 * auth middleware); notes.service.ts enforces ownership on every mutation
 * (`existing.userId !== userId → forbidden`), so notes are private to the
 * person who wrote them even within a household.
 *
 * `pinned` is a normal PATCH field — pinning is just an update, there is no
 * separate pin/unpin endpoint to keep in sync.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import {
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  NOTE_MAX_BODY,
} from "../services/notes.service.js";

function getUser(req: Request): string {
  const username = req.user?.username;
  // authMiddleware guarantees req.user on these routes; an absent username is
  // an invariant break, not a legitimate default (ORCH-007 fail-open).
  if (!username) throw new Error("authenticated user required");
  return username;
}

const noteCreateSchema = z.object({
  body: z.string().max(NOTE_MAX_BODY),
  pinned: z.boolean().optional(),
});

const notePatchSchema = z
  .object({
    body: z.string().max(NOTE_MAX_BODY).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => v.body !== undefined || v.pinned !== undefined, {
    message: "at least one of body or pinned is required",
  });

export function createNotesRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/notes", async (req, res, next) => {
    try {
      res.json({ notes: await listNotes(prisma, getUser(req)) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/notes", async (req, res, next) => {
    try {
      const parsed = noteCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      const note = await createNote(prisma, getUser(req), parsed.data);
      res.status(201).json({ note });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/notes/:id", async (req, res, next) => {
    try {
      const parsed = notePatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      const note = await updateNote(prisma, getUser(req), req.params.id, parsed.data);
      res.json({ note });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "note_not_found") return void res.status(404).json({ error: msg });
      if (msg === "forbidden") return void res.status(403).json({ error: msg });
      next(err);
    }
  });

  router.delete("/notes/:id", async (req, res, next) => {
    try {
      await deleteNote(prisma, getUser(req), req.params.id);
      res.status(204).end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "note_not_found") return void res.status(404).json({ error: msg });
      if (msg === "forbidden") return void res.status(403).json({ error: msg });
      next(err);
    }
  });

  return router;
}
