/** Caller-specific, read-only prerequisites for the device's creation tools. */
import { Router, type Request } from "express";
import { OffLanChannelKey, type PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import type { AvailabilityConfig } from "../modules/module-registry.js";
import { getEffectiveModuleIds } from "../services/modules.service.js";
import { resolveEffectiveAccessForRequest } from "../middleware/feature-gate.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import { getNcToken, resolveNcToken } from "../services/nextcloud-session.service.js";
import { getActivityRecorder } from "../services/activity.singleton.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { recordAccessDenied } from "../middleware/auth.js";
import {
  boundedCreationRead, creationCapability, fromCreationProbe, probeCreationService, probeCreationSpeech,
  type CreationCapability, type CreationProbeConfig, type ProbeResult,
} from "../services/creation-readiness.service.js";

const FILE_IDS = [
  ["pdf", "PDF documents"], ["slides", "PowerPoint and PDF slides"], ["workbook", "Excel workbooks"],
  ["office", "Office inspection and editing"], ["analysis", "Private data analysis"], ["artifact", "Interactive artifacts"],
  ["speech", "Speech files"], ["image", "Image creation and editing"], ["video", "Video creation"],
] as const;
const limit = createRateLimit("creation-readiness", { windowMs: 60_000, limit: 20 });
interface Options {
  config?: CreationProbeConfig;
  probe?: typeof probeCreationService;
  speech?: typeof probeCreationSpeech;
  access?: typeof resolveEffectiveAccessForRequest;
  modules?: typeof getEffectiveModuleIds;
  fileToken?: typeof resolveNcToken;
  serviceFileToken?: typeof getNcToken;
  auditReady?: () => boolean;
  timeoutMs?: number;
}

export function createCreationCapabilitiesRouter(prisma: PrismaClient, availability: AvailabilityConfig, options: Options = {}): Router {
  const router = Router();
  const cfg = options.config ?? config;
  router.get("/capabilities/creation", (req, res, next) => {
    if (!req.user) { res.status(401).json({ error: "auth_required" }); return; }
    next();
  }, limit, async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4500);
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", close);
    const bounded = <T>(work: Promise<T>) => boundedCreationRead(work, controller.signal);
    try {
      let actorReq = req;
      const service = req.user?.role === "service" || req.user?.id?.startsWith("_service:");
      const deny = () => { recordAccessDenied(req, "role-not-permitted"); res.status(403).json({ error: "person_required" }); };
      if (service) {
        if (req.user?.id !== "_service:mcp" || req.user.role !== "service") { deny(); return; }
        const resolved = await bounded(resolveAssertedUser(prisma, req.header("x-nextcloud-user") ?? ""));
        if (!resolved.ok || !["owner", "admin", "family", "guest"].includes(resolved.user.role)) { deny(); return; }
        // Separate per-request access memo for the resolved person, never the
        // service principal's grants or caller-selected Nextcloud token.
        actorReq = { user: resolved.user } as unknown as Request;
      }
      if (!actorReq.user || !["owner", "admin", "family", "guest"].includes(actorReq.user.role)) { deny(); return; }
      const [effective, access] = await bounded(Promise.all([
        (options.modules ?? getEffectiveModuleIds)(prisma, availability),
        (options.access ?? resolveEffectiveAccessForRequest)(actorReq),
      ]));
      if (!access) { res.status(503).json({ error: "creation_status_unavailable" }); return; }
      const capabilities: CreationCapability[] = [];
      const files = effective.has("files");
      const fileGrant = access.features.find((f) => f.moduleId === "files");
      const permitted = ["owner", "admin", "family"].includes(actorReq.user.role) && access.toolDomains.includes("files") && Boolean(fileGrant && fileGrant.level !== "view");
      let tokenAvailable = false;
      if (files && permitted) tokenAvailable = Boolean(await bounded(service ? (options.serviceFileToken ?? getNcToken)(actorReq.user.id) : (options.fileToken ?? resolveNcToken)(req)));
      const canProbeFiles = files && permitted && tokenAvailable;
      if (!canProbeFiles) {
        const missingStorage = !availability.NEXTCLOUD_URL.trim();
        const state = !files ? missingStorage ? "not_configured" : "disabled" : !permitted ? "restricted" : "unavailable";
        const reason = !files ? missingStorage ? "file_store_not_configured" : "files_module_disabled" : !permitted ? "file_creation_not_permitted" : "file_access_disconnected";
        const detail = !files ? missingStorage ? "Ask your administrator to configure the personal File Store." : "Ask your administrator to enable Files in Settings." : !permitted ? "Your account does not have permission to create files." : "Sign in with your password to reconnect your personal drive.";
        capabilities.push(...FILE_IDS.map(([id, label]) => creationCapability(id, label, state, reason, detail)));
      }
      let webPolicy: "enabled" | "disabled" | "unavailable" = "unavailable";
      const webPermitted = access.toolDomains.includes("data");
      if (webPermitted) {
        try { webPolicy = (await bounded(prisma.offLanAllowlistChannel.findUnique({ where: { key: OffLanChannelKey.web_fetch }, select: { enabled: true } })))?.enabled === true ? "enabled" : "disabled"; } catch { /* Closed; no edge probe. */ }
      }
      const auditReady = (options.auditReady ?? (() => Boolean(getActivityRecorder())))();
      const canProbeWeb = webPermitted && webPolicy === "enabled" && auditReady;
      const probe = options.probe ?? probeCreationService;
      const empty = (): Promise<ProbeResult> => Promise.resolve({ state: "offline" });
      const peer = async (work: Promise<ProbeResult>, valid: (data: Record<string, unknown>) => boolean): Promise<ProbeResult> => {
        try {
          const result = await bounded(work);
          if (result.state === "ready" && (!result.data || !valid(result.data))) return { state: "offline" };
          return result;
        } catch { return { state: "offline" }; }
      };
      const version = (data: Record<string, unknown>) => data.version === 1;
      const [documents, analysis, speech, media, web] = await Promise.all([
        canProbeFiles ? peer(probe(cfg.DOC_RENDER_URL, cfg.DOC_RENDER_SERVICE_TOKEN, controller.signal), (d) => version(d) && Array.isArray(d.formats) && d.formats.length <= 4 && d.formats.every((v) => ["pdf", "docx", "xlsx", "pptx"].includes(v)) && typeof d.office === "boolean") : empty(),
        canProbeFiles ? peer(probe(cfg.SANDBOX_URL, cfg.SANDBOX_SERVICE_TOKEN, controller.signal), (d) => version(d) && typeof d.analysisEligible === "boolean" && typeof d.busy === "boolean") : empty(),
        canProbeFiles ? peer((options.speech ?? probeCreationSpeech)(cfg.TTS_URL, controller.signal), (d) => typeof d.installed === "boolean") : empty(),
        canProbeFiles ? peer(probe(cfg.MEDIA_GEN_URL, cfg.MEDIA_GEN_SERVICE_TOKEN, controller.signal), (d) => version(d) && typeof d.image === "boolean" && typeof d.video === "boolean" && typeof d.busy === "boolean") : empty(),
        canProbeWeb ? peer(probe(cfg.WEB_FETCH_URL, cfg.WEB_FETCH_SERVICE_TOKEN, controller.signal), (d) => version(d) && typeof d.fetch === "boolean" && typeof d.search === "boolean") : empty(),
      ]);
      if (canProbeFiles) {
        const formats = documents.data?.version === 1 && Array.isArray(documents.data.formats) ? documents.data.formats : [];
        capabilities.push(
          fromCreationProbe("pdf", "PDF documents", documents, formats.includes("pdf")),
          fromCreationProbe("slides", "PowerPoint and PDF slides", documents, formats.includes("pptx") && formats.includes("pdf")),
          fromCreationProbe("workbook", "Excel workbooks", documents, formats.includes("xlsx")),
          fromCreationProbe("office", "Office inspection and editing", documents, documents.data?.version === 1 && documents.data.office === true),
          fromCreationProbe("analysis", "Private data analysis", analysis, analysis.data?.version === 1 && analysis.data.analysisEligible === true),
          creationCapability("artifact", "Interactive artifacts", "ready", "artifact_writer_ready", "Saved HTML artifacts run only in browsers that support the connection isolation check."),
          fromCreationProbe("speech", "Speech files", speech, speech.data?.installed === true),
        );
        const analysisRow = capabilities.find((row) => row.id === "analysis")!;
        if (analysisRow.state === "ready") {
          analysisRow.state = "unverified"; analysisRow.reason = "analysis_runtime_unverified";
          analysisRow.detail = "Kernel prerequisites are present. This probe does not verify an analysis run. Each analysis verifies its isolated child before running your code.";
          if (analysis.data?.busy === true) { analysisRow.state = "busy"; analysisRow.reason = "analysis_busy"; analysisRow.detail = "Another private analysis is running. Retry after it finishes."; }
        }
        const speechRow = capabilities.find((row) => row.id === "speech")!;
        if (speechRow.state === "unavailable") { speechRow.reason = "voice_missing"; speechRow.detail = "The local speech service has no installed voice. Ask your administrator to complete voice setup."; }
        for (const id of ["image", "video"] as const) {
          const row = fromCreationProbe(id, id === "image" ? "Image creation and editing" : "Video creation", media, media.data?.version === 1 && media.data[id] === true);
          if (row.state === "unavailable") { row.reason = "model_missing"; row.detail = "Ask your administrator to install the complete local model snapshot and enable the media service."; }
          if (row.state === "ready") {
            row.state = media.data?.busy === true ? "busy" : "unverified";
            row.reason = media.data?.busy === true ? "media_busy" : "model_installed_inference_unverified";
            row.detail = media.data?.busy === true ? "A local media job is running. Retry after it finishes." : "Local model files are installed. This status check does not run or verify GPU inference.";
          }
          capabilities.push(row);
        }
      }
      for (const id of ["web_fetch", "web_search"] as const) {
        const label = id === "web_fetch" ? "Public web pages" : "Public web search";
        if (!canProbeWeb) {
          const state = !webPermitted ? "restricted" : webPolicy === "disabled" ? "disabled" : "unavailable";
          const reason = !webPermitted ? "web_not_permitted" : webPolicy === "disabled" ? "web_policy_disabled" : !auditReady ? "audit_unavailable" : "policy_unavailable";
          capabilities.push(creationCapability(id, label, state, reason, !webPermitted ? "Your account does not have permission to use public web tools." : webPolicy === "disabled" ? "Your administrator must enable screened public web access in the off-LAN policy." : "The privacy policy or signed activity recorder is unavailable. Public web access stays blocked."));
        } else {
          const row = fromCreationProbe(id, label, web, web.data?.version === 1 && web.data[id === "web_fetch" ? "fetch" : "search"] === true);
          if (row.state === "ready") row.detail = "Screened public requests are permitted and recorded. Only the explicit query or public URL leaves the device.";
          if (id === "web_search" && row.state === "ready") { row.state = "unverified"; row.reason = "search_provider_unverified"; row.detail = "The search key is provisioned locally. This status check does not contact or verify the external provider."; }
          if (id === "web_search" && row.state === "unavailable") { row.reason = "search_key_missing"; row.detail = "Ask your administrator to provision the search provider key in the web service."; }
          capabilities.push(row);
        }
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ version: 1, checkedAt: new Date().toISOString(), capabilities });
    } catch { if (!res.destroyed) res.status(503).json({ error: "creation_status_unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); res.off("close", close); }
  });
  return router;
}
