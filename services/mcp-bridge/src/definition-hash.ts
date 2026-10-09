/**
 * WARP-3918 — a SHA-256 over the canonical wire definition of one remote tool:
 * name, description, input schema and annotations, keys in sorted order.
 *
 * The bridge is the only component that sees the wire object; the orchestrator
 * receives the descriptor with `annotations` removed (ADR-043 §2). So the hash
 * is computed here and travels as an opaque string. `annotations` is HASHED, so
 * a server that edits `readOnlyHint` makes its tool read as changed; it is
 * never READ as a privilege claim, here or downstream.
 */
import { createHash } from "node:crypto";

/** JSON with object keys sorted at every depth; `undefined` members drop out. */
export function canonicalWireJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalWireJson(v === undefined ? null : v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalWireJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function toolDefinitionHash(t: {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}): string {
  return createHash("sha256")
    .update(
      canonicalWireJson({
        name: t.name,
        description: t.description ?? null,
        inputSchema: t.inputSchema ?? null,
        annotations: t.annotations ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}
