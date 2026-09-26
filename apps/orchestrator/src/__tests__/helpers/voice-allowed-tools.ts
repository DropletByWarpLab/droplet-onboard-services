/**
 * WARP-3125 — voice-io's default `allowed_tools`, read from its source.
 *
 * `services/voice-io/voice/llm.py` `DEFAULT_VOICE_ALLOWED_TOOLS` is the list
 * voice sends on every tool-enabled turn. Tests that pin what the orchestrator
 * does with that list read it from the Python source, in voice's own order,
 * instead of carrying a copy that can drift from what voice actually sends.
 * Comments inside the tuple are stripped before the names are read.
 */
import { readRepoFile } from "./test-paths.js";

export function voiceDefaultAllowedTools(): string[] {
  const src = readRepoFile("services", "voice-io", "voice", "llm.py");
  const tuple = /^DEFAULT_VOICE_ALLOWED_TOOLS\b[^=]*=\s*\(([\s\S]*?)^\)/m.exec(src);
  if (!tuple) {
    throw new Error("DEFAULT_VOICE_ALLOWED_TOOLS tuple not found in voice-io llm.py");
  }
  const body = tuple[1]!
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  return [...body.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
}
