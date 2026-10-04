/** WARP-3504 — shared sample facts for the box-telemetry tests. */
import type { HeartbeatFacts } from "../builders.js";

export const NOW = new Date("2026-10-03T12:00:00.000Z");

export function sampleFacts(overrides: Partial<HeartbeatFacts> = {}): HeartbeatFacts {
  return {
    now: NOW,
    release: { tag: "ota-stage-12-gabc1234", gitSha: "a".repeat(40), channel: "stage" },
    os: { kernel: "6.8.0-45-generic", distro: "Ubuntu 24.04.1 LTS" },
    bootedAt: new Date("2026-10-01T08:00:00.000Z"),
    uptimeSec: 189_600,
    services: [
      { name: "orchestrator", state: "running", health: "healthy", restarts: 0 },
      { name: "ai-gateway", state: "running", health: "none", restarts: 2 },
    ],
    usage: {
      cpuPct: 12.4,
      memPct: 48.6,
      diskPct: 61,
      netRxBytes: 1_000_000,
      netTxBytes: 2_000_000,
      gpus: [{ utilPct: 33.2, vramUsedMb: 4096.4, vramTotalMb: 16384, tempC: 61.7 }],
    },
    activity: {
      windowSec: 300,
      chatTurns: 4,
      agentRuns: 1,
      activeUsers: 2,
      ota: { checks: 1, downloads: 0, applies: 0, rollbacks: 0, failures: 0 },
      errorsByClass: { ECONNREFUSED: 3 },
    },
    ...overrides,
  };
}
