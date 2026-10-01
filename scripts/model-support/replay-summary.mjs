// WARP-3409 — replay one tool-spec run's `summarize` step against one or more models, so a model's
// fit for the Daily report (or any spec's write-up) is measured on real facts, not rebuilt by hand.
//
// It uses the REAL rendering from the orchestrator's compiled dist (renderFacts, SUMMARY_SYSTEM,
// DEFAULT_SUMMARY_PROMPT, factsNeedLocalModel) and the real ai-gateway client, which sends the
// container's own service token (never printed). Read-only: one SELECT of the run's trace, no writes.
// `--thinking low` sends `reasoning_effort: "low"`, and the gateway's per-family table
// (_THINKING_CONTROLS, services/ai-gateway/providers/ollama_local.py) decides what that means for
// each model, exactly as in production: gpt-oss → low effort, GLM on DMR → thinking off.
//
// On a box whose orchestrator image has these exports (WARP-3409 or later):
//   docker exec -i droplet-orchestrator-1 node - --run <ToolRun id> [--models a,b] [--repeats 3] \
//     [--max-tokens 2100] [--thinking low|default] < scripts/model-support/replay-summary.mjs
// Against a tree that is not deployed yet: build it (`npm run build -w @droplet/orchestrator`), run
// this in a throwaway node:20 container on the `droplet_default` network with the tree mounted, pass
// `--dist <tree>/apps/orchestrator/dist`, and hand the container DATABASE_URL, AI_GATEWAY_URL and
// SERVICE_TOKEN_AI_GATEWAY read from droplet-orchestrator-1's env without echoing them.
//
// Defaults mirror the summarizer: max_tokens 2,100 (its first call), temperature 0.3, --thinking low,
// the box's LLM_MODEL. Output: one line per model × repeat.
//
// CAUTION on a live box: a --models entry that is not already loaded gets loaded by the model runner,
// which may unload the model chat is using (one GPU). Run it when nobody is chatting, and finish with
// the active model so it is resident again.

(async () => {
  const { createRequire } = await import("node:module");
  const path = await import("node:path");

  const argv = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const runId = opt("run");
  if (!runId) {
    console.error("usage: --run <ToolRun id> [--models a,b] [--repeats 3] [--max-tokens 2100] [--thinking low|default] [--dist <dir>]");
    process.exit(2);
  }
  const dist = path.resolve(opt("dist", "dist"));
  const models = opt("models", process.env.LLM_MODEL ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const repeats = Number(opt("repeats", "3"));
  const maxTokens = Number(opt("max-tokens", "2100"));
  const thinking = opt("thinking", "low"); // production always sends low (WARP-3409)
  if (models.length === 0) throw new Error("no model: pass --models or set LLM_MODEL");
  if (!["low", "default"].includes(thinking)) throw new Error("--thinking must be low or default");

  // CommonJS dist (tsconfig NodeNext, no "type": "module"): require it from its own directory so
  // its bare imports (@prisma/client, @droplet/tools-core) resolve the way the service's do.
  const req = createRequire(path.join(dist, "index.js"));
  const { renderFacts, factsNeedLocalModel, SUMMARY_SYSTEM } = req("./services/tool-spec-summarizer.service.js");
  const { DEFAULT_SUMMARY_PROMPT, SUMMARIZE_PSEUDO_TOOL } = req("./services/tool-spec-runner.service.js");
  const gateway = req("./services/ai-gateway.client.js");
  const { PrismaClient } = req("@prisma/client");
  if (typeof SUMMARY_SYSTEM !== "string") throw new Error(`${dist} predates WARP-3409 (no SUMMARY_SYSTEM export)`);

  const prisma = new PrismaClient();
  const run = await prisma.toolRun.findUnique({ where: { id: runId }, select: { trace: true, status: true } });
  await prisma.$disconnect();
  if (!run) throw new Error(`no ToolRun ${runId}`);
  const trace = Array.isArray(run.trace) ? run.trace : [];
  const at = trace.findIndex((t) => t.tool === SUMMARIZE_PSEUDO_TOOL);
  const facts = at >= 0 ? trace.slice(0, at) : trace;
  const prompt = (at >= 0 && trace[at].args?.prompt) || DEFAULT_SUMMARY_PROMPT;
  const text = `${prompt}\n\nResults:\n${renderFacts(facts)}`;
  const local = factsNeedLocalModel(facts);
  console.log(
    `run ${runId} (${run.status}): ${facts.length} facts, prompt ${text.length} chars, ` +
      `provider ${local ? "local" : "by model"}, max_tokens ${maxTokens}, thinking ${thinking}`,
  );

  for (const model of models) {
    for (let r = 1; r <= repeats; r++) {
      const started = Date.now();
      try {
        const res = await gateway.chat(
          {
            model,
            messages: [{ role: "system", content: SUMMARY_SYSTEM }, { role: "user", content: text }],
            stream: false,
            temperature: 0.3,
            max_tokens: maxTokens,
            ...(thinking === "low" ? { reasoning_effort: "low" } : {}),
            ...(local ? { provider: "local" } : {}),
          },
          AbortSignal.timeout(600_000),
        );
        const body = await res.json();
        const choice = body.choices?.[0] ?? {};
        const content = String(choice.message?.content ?? "").trim();
        const reasoning = String(choice.message?.reasoning_content ?? "").trim();
        console.log(
          [
            model.split("/").pop().padEnd(28),
            `r${r}`,
            `${((Date.now() - started) / 1000).toFixed(1)}s`,
            `finish=${choice.finish_reason ?? "?"}`,
            `content=${content.length}`,
            `reasoning=${reasoning.length}`,
            `completion_tokens=${body.usage?.completion_tokens ?? "?"}`,
            `| ${JSON.stringify(content.slice(0, 150))}`,
          ].join(" "),
        );
      } catch (err) {
        console.log(`${model.split("/").pop().padEnd(28)} r${r} ERROR ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
  }
  process.exit(0);
})().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
