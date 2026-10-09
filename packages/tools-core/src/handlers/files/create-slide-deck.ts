import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { err, interpretRenderResponse, ncHeaders, validateDocPath } from "./_render.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "New .pdf/.pptx path." },
    both: { type: "boolean", description: "Save both formats." },
    title: { type: "string" },
    theme: { type: "string", description: "droplet/light/dark" },
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          subtitle: { type: "string" },
          columns: { type: "array", items: { type: "object" }, description: "Two {title?,bullets:string[]}." },
          table: { type: "object", description: "{headers:string[],rows:cell[][]}." },
          chart: { type: "object", description: "{kind:bar|line|pie,labels:string[],series:[{name,values:number[]}]}." },
          image: { type: "object", description: "{path|item_id,caption?,alt?}; authorized PNG/JPEG." },
          notes: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      description: "1-60 slides; one layout. Latin/Greek/Cyrillic.",
    },
  },
  required: ["path", "title", "slides"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const started = Date.now();
  const format = typeof args.path === "string" && args.path.trim().toLowerCase().endsWith(".pptx")
    ? "pptx" : "pdf";
  const v = validateDocPath(args.path, format);
  if (!v.ok) return v.error;
  if (typeof args.title !== "string" || !Array.isArray(args.slides) || args.slides.length === 0) {
    return err("INVALID_ARGS", "title and a non-empty slides array are required");
  }
  if (args.both !== undefined && typeof args.both !== "boolean") return err("INVALID_ARGS", "both must be a boolean");
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", "auth_required");
  if (ctx.signal?.aborted) return err("CANCELLED", "The export was cancelled before starting.");
  let primary: ToolResult;
  if (args.both === true) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    ctx.signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Export deadline")); }, 55_000);
    });
    try {
      const pending = ctx.http.nextcloud.post(
        "/render",
        { path: v.path, format, title: args.title, slides: args.slides, ...(args.theme !== undefined ? { theme: args.theme } : {}) },
        { headers: ncHeaders(ctx), signal: controller.signal },
      );
      // The deadline also bounds transports/body readers that ignore abort.
      // If cancellation races a received acknowledgement, retain that save.
      primary = await Promise.race([pending.then((response) => interpretRenderResponse(response, v.path)), deadline]);
    } catch {
      return err("OUTCOME_UNKNOWN", "Storage outcome is unknown. Check the primary filename before retrying; the companion was not started.");
    } finally {
      clearTimeout(timer!);
      ctx.signal?.removeEventListener("abort", abort);
    }
  } else {
    const res = await ctx.http.nextcloud.post(
      "/render",
      { path: v.path, format, title: args.title, slides: args.slides, ...(args.theme !== undefined ? { theme: args.theme } : {}) },
      { headers: ncHeaders(ctx), ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    primary = await interpretRenderResponse(res, v.path);
  }
  if (!primary.ok || args.both !== true) return primary;
  // Each destination is an independent create-new write. Preserve an already
  // acknowledged file if the companion conflicts, times out or is cancelled.
  const saved = primary.data as { path: string; media: unknown };
  const companionFormat = format === "pdf" ? "pptx" : "pdf";
  const companionPath = saved.path.replace(/\.(?:pdf|pptx)$/i, `.${companionFormat}`);
  const artifacts: unknown[] = [primary.data];
  const exportErrors: Array<{ path: string; code: string; message: string }> = [];
  if (!saved.path.toLowerCase().endsWith(`.${format}`)) {
    exportErrors.push({ path: v.path.replace(/\.(?:pdf|pptx)$/i, `.${companionFormat}`), code: "RENDER_FAILED", message: "Saved metadata has an unexpected extension; the companion was not started." });
  } else if (ctx.signal?.aborted) {
    exportErrors.push({ path: companionPath, code: "CANCELLED", message: "The primary file was saved; the companion was not started." });
  } else if (Date.now() - started >= 55_000) {
    exportErrors.push({ path: companionPath, code: "TIMEOUT", message: "The primary file was saved; no time remains to start the companion." });
  } else {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 55_000 - (Date.now() - started));
    ctx.signal?.addEventListener("abort", abort, { once: true });
    let rejectOnAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(new Error("Companion export interrupted"));
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    try {
      const pending = ctx.http.nextcloud.post(
        "/render",
        { path: companionPath, format: companionFormat, title: args.title, slides: args.slides, ...(args.theme !== undefined ? { theme: args.theme } : {}) },
        { headers: ncHeaders(ctx), signal: controller.signal },
      );
      const companion = await Promise.race([pending.then((response) => interpretRenderResponse(response, companionPath)), cancelled]);
      if (companion.ok) artifacts.push(companion.data);
      else exportErrors.push({ path: companionPath, code: companion.error.code, message: companion.error.message });
    } catch {
      exportErrors.push({ path: companionPath, code: "OUTCOME_UNKNOWN", message: "The primary file was saved; the companion storage outcome is unknown. Check that filename before retrying." });
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectOnAbort);
    }
  }
  return { ok: true, data: { ...saved, artifacts, exportErrors, complete: exportErrors.length === 0, media: artifacts.map((item) => (item as { media: unknown }).media) } };
}

const tool: Tool = {
  name: "create_slide_deck",
  description: "New PDF/editable PPTX decks; both=true saves both.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
