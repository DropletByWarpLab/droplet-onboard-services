/**
 * Smart-port autonomous agent — WARP-399.
 *
 * Subscribes to `smart-port/event` on MQTT and, when the switch
 * watcher publishes a new-device signal, kicks off an autonomous
 * `runAgent` cycle to classify the device and stage adoption steps
 * for operator approval.
 *
 * Three reasons this is its own service and not a route on `llm.ts`:
 *
 *   1. It's not user-initiated — there's no `req.user` to anchor
 *      authorisation. The agent run runs with `userId=null` and the
 *      Tier-2 deferral hook fans out to the proposals inbox instead
 *      of the chat's confirm-modal flow.
 *   2. The MQTT subscription is process-singleton: one orchestrator
 *      replica owns it (the shared `subscribeToTopic` handler runs
 *      in-memory, so any K8s replica would receive the broker
 *      broadcast, but only this service decides to dispatch a run).
 *   3. The system prompt is fixed to `smart-port.md`, not user-chosen.
 *
 * Gated by env `SMART_PORT_AUTONOMOUS_ENABLED` (default `0`): when
 * off, the service is constructed but never subscribes — the
 * operator-prompted Phase 3 path keeps working unchanged.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import pino from "pino";

import { config } from "../config.js";
import { subscribeToTopic, publish as publishMqtt } from "./mqtt.service.js";
import {
  runAgent,
  type AgentDeps,
  type ToolDeferral,
} from "./llm-agent.service.js";
import { TOOLS } from "@droplet/tools-core";
import type { McpClientService } from "./mcp-client.service.js";

const logger = pino({ name: "smart-port-agent" });

const TOPIC = "smart-port/event";

/**
 * Tools the autonomous loop is allowed to call. Whitelist (not deny-list)
 * so a confused model can't drift onto `write_file` or `set_wifi_ssid`.
 * Mirrors the table in WARP-399 §2 / `smart-port.md`.
 */
export const SMART_PORT_TOOLS: ReadonlyArray<string> = [
  "get_switch_ports",
  "get_switch_poe",
  "list_discovered_cameras",
  "scan_for_cameras",
  "get_camera_init_status",
  "initialize_camera",
  "add_camera_to_frigate",
  "accept_discovered_camera",
  "set_port_vlan",
];

/** Default 60s — mirrors the watcher's own dedup window in services/switch/watcher.py. */
const DEFAULT_COOLDOWN_MS = Number(
  process.env.SMART_PORT_AGENT_COOLDOWN_MS ?? 60_000,
);
/** Default 1h — proposals self-expire if the operator doesn't get back to them. */
const DEFAULT_PROPOSAL_TTL_MS = Number(
  process.env.SMART_PORT_PROPOSAL_TTL_MS ?? 60 * 60 * 1_000,
);
const DEFAULT_MODEL =
  process.env.SMART_PORT_AGENT_MODEL ?? "gpt-oss:20b";
const MAX_ITER = 6;

export interface SmartPortEvent {
  port?: number;
  mac?: string;
  oui?: string;
  poe_class?: number;
  ip?: string;
  hostname?: string;
  source?: string;
  ts?: number;
}

interface SmartPortAgentDeps {
  prisma: PrismaClient;
  mcp: McpClientService;
  aiGateway: AgentDeps["aiGateway"];
  /** Override for tests; default reads `apps/orchestrator/src/services/llm-system-prompts/smart-port.md`. */
  loadSystemPrompt?: () => Promise<string>;
  cooldownMs?: number;
  proposalTtlMs?: number;
  model?: string;
}

export interface SmartPortAgent {
  /** Subscribe to MQTT. Caller decides when (after MQTT connect). */
  start(): Promise<void>;
  /** Drop the subscription and stop accepting events. */
  stop(): Promise<void>;
  /** Manually dispatch an event (used by tests + the future "run from dashboard" debug button). */
  handleEvent(evt: SmartPortEvent): Promise<void>;
}

export function createSmartPortAgent(deps: SmartPortAgentDeps): SmartPortAgent {
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const proposalTtlMs = deps.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS;
  const model = deps.model ?? DEFAULT_MODEL;
  const loadSystemPrompt = deps.loadSystemPrompt ?? defaultLoadSystemPrompt;

  // (port|mac) -> ts of last dispatch. Same key shape as the watcher's
  // own dedup window so a misconfigured cadence doesn't double-fire.
  const lastDispatch = new Map<string, number>();
  let unsubscribe: (() => void) | null = null;
  let systemPromptCache: string | null = null;

  async function getSystemPrompt(): Promise<string> {
    if (systemPromptCache === null) {
      systemPromptCache = await loadSystemPrompt();
    }
    return systemPromptCache;
  }

  function dedupKey(evt: SmartPortEvent): string {
    return `${evt.port ?? "?"}|${(evt.mac ?? evt.ip ?? "").toUpperCase()}`;
  }

  function renderEvent(evt: SmartPortEvent): string {
    const lines: string[] = [];
    lines.push(`A smart-port event just fired:`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(evt, null, 2));
    lines.push("```");
    lines.push("");
    lines.push(
      "Decide whether this is a camera worth adopting, and if so, walk it through the right vendor first-run flow and into Frigate.",
    );
    lines.push(
      "You are running without an operator in the chat. Any Tier-2 tool you call will be deferred to the proposals inbox automatically — do NOT ask in chat, just call it.",
    );
    return lines.join("\n");
  }

  async function handleEvent(evt: SmartPortEvent): Promise<void> {
    const key = dedupKey(evt);
    const now = Date.now();
    const last = lastDispatch.get(key) ?? 0;
    if (now - last < cooldownMs) {
      logger.debug({ key, ageMs: now - last }, "smart-port-agent: cooldown drop");
      return;
    }
    lastDispatch.set(key, now);

    const entityId = `port:${evt.port ?? "unknown"}`;

    // Audit row first — proposal rows reference it. Prisma's Json input
    // type is stricter than `Record<string, unknown>`; the
    // JSON.parse(JSON.stringify(...)) round-trip drops `undefined` values
    // and aligns the shape with InputJsonValue. Same pattern used by
    // services/safety-tier.service.ts.
    const startedData = JSON.parse(
      JSON.stringify({ event: evt, stage: "started" }),
    );
    const auditRow = await deps.prisma.commandAuditLog.create({
      data: {
        userId: null,
        entityId,
        domain: "smart_port",
        service: "orchestrator",
        tier: 1,
        confirmed: false,
        blocked: false,
        reason: `autonomous run, source=${evt.source ?? "unknown"}`,
        data: startedData,
      },
    });

    const systemPrompt = await getSystemPrompt();
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: renderEvent(evt) },
    ];

    const expiresAt = new Date(now + proposalTtlMs);

    const deferTier2ToolCall = async (input: {
      toolName: string;
      toolArgs: Record<string, unknown>;
    }): Promise<ToolDeferral | null> => {
      const tool = TOOLS.get(input.toolName);
      if (!tool) {
        // Unknown tool — let the dispatcher fail naturally so the trace
        // captures the model's mistake rather than a silent defer.
        return null;
      }
      if (!tool.requiresConfirmation) {
        return null;
      }
      const proposal = await deps.prisma.autonomousProposal.create({
        data: {
          domain: "smart_port",
          entityId,
          toolName: input.toolName,
          toolArgs: JSON.parse(JSON.stringify(input.toolArgs)),
          tier: 2,
          status: "pending",
          expiresAt,
          agentRunId: auditRow.id,
        },
      });
      try {
        publishMqtt("droplet/autonomous-proposals/created", {
          id: proposal.id,
          domain: proposal.domain,
          entityId: proposal.entityId,
          toolName: proposal.toolName,
          tier: proposal.tier,
          expiresAt: proposal.expiresAt.toISOString(),
        });
      } catch (err) {
        logger.debug({ err }, "smart-port-agent: proposal MQTT publish failed");
      }
      return {
        proposal_id: proposal.id,
        reason: `Tier-2 (${input.toolName}) deferred — operator approval required at /ops/autonomous-proposals.`,
      };
    };

    let result;
    try {
      result = await runAgent(
        {
          mcp: deps.mcp,
          aiGateway: deps.aiGateway,
          deferTier2ToolCall,
        },
        {
          model,
          messages,
          max_iter: MAX_ITER,
          allowed_tools: [...SMART_PORT_TOOLS],
          mode: "autonomous",
          agentRunId: auditRow.id,
        },
      );
    } catch (err) {
      logger.warn({ err, entityId }, "smart-port-agent: runAgent threw");
      await deps.prisma.commandAuditLog.update({
        where: { id: auditRow.id },
        data: {
          blocked: true,
          reason: `autonomous run failed: ${(err as Error).message}`,
          data: JSON.parse(JSON.stringify({ event: evt, stage: "error" })),
        },
      });
      return;
    }

    await deps.prisma.commandAuditLog.update({
      where: { id: auditRow.id },
      data: {
        data: JSON.parse(
          JSON.stringify({
            event: evt,
            stage: "complete",
            stop_reason: result.stop_reason,
            iterations: result.iterations,
            trace: result.trace,
          }),
        ),
      },
    });
    logger.info(
      {
        entityId,
        stop_reason: result.stop_reason,
        iterations: result.iterations,
        trace_steps: result.trace.length,
      },
      "smart-port-agent: run complete",
    );
  }

  return {
    async start() {
      if (unsubscribe) return;
      unsubscribe = subscribeToTopic(TOPIC, (_topic, payload) => {
        // Fire-and-forget — the MQTT dispatcher is sync, but our handler
        // is async. Surface failures into the logger, never throw.
        handleEvent(payload as SmartPortEvent).catch((err) =>
          logger.warn({ err }, "smart-port-agent: handleEvent threw"),
        );
      });
      logger.info(
        { topic: TOPIC, cooldownMs, proposalTtlMs, model },
        "smart-port-agent: subscribed",
      );
    },
    async stop() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
        logger.info("smart-port-agent: unsubscribed");
      }
    },
    handleEvent,
  };
}

async function defaultLoadSystemPrompt(): Promise<string> {
  // Read the file from the package's dist tree at runtime. The Dockerfile
  // copies `apps/orchestrator/src/services/llm-system-prompts/*.md` into
  // the image at the same path layout; in dev (tsx) it's served from src.
  const candidates = [
    path.resolve(
      process.cwd(),
      "src/services/llm-system-prompts/smart-port.md",
    ),
    path.resolve(
      process.cwd(),
      "dist/services/llm-system-prompts/smart-port.md",
    ),
    path.resolve(
      process.cwd(),
      "apps/orchestrator/src/services/llm-system-prompts/smart-port.md",
    ),
    path.resolve(
      process.cwd(),
      "apps/orchestrator/dist/services/llm-system-prompts/smart-port.md",
    ),
  ];
  for (const p of candidates) {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(
    `smart-port system prompt not found in any of: ${candidates.join(", ")}`,
  );
}

/**
 * Boot helper — call after `connectMqtt()` resolves. Returns the agent
 * (or null if the env gate is off) so `main()` can call `.stop()` on
 * shutdown.
 */
export async function initSmartPortAgent(
  deps: SmartPortAgentDeps,
): Promise<SmartPortAgent | null> {
  if (process.env.SMART_PORT_AUTONOMOUS_ENABLED !== "1") {
    logger.info(
      "smart-port-agent disabled (SMART_PORT_AUTONOMOUS_ENABLED != '1')",
    );
    return null;
  }
  const agent = createSmartPortAgent(deps);
  await agent.start();
  return agent;
}
