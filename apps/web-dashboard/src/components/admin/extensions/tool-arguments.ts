/**
 * WARP-3205 — the arguments of an extension tool, as the box reads them.
 *
 * A tool's `inputSchema` is JSON its author wrote. The manifest accepts any
 * JSON Schema vocabulary there (extension-manifest.ts: `passthrough()`), so
 * every string in it can be prose: a `description`, `title`, `examples`,
 * `default`, `$comment` or `enum` value at any depth, a property's NAME, even
 * a `type` value no JSON Schema defines.
 *
 * So the review's arguments list shows only what the box reads from the
 * schema's structure: each top-level property's name (only when it is a plain
 * identifier), the JSON Schema type names its `type` states, and whether
 * `required` lists it. The whole schema, notes included, is shown only inside
 * the disclosure labelled as its author's words.
 */

/** The seven type names JSON Schema defines. Nothing else in `type` is read. */
export const JSON_TYPES = ["string", "number", "integer", "boolean", "array", "object", "null"] as const;
export type JsonType = (typeof JSON_TYPES)[number];

/** A plain identifier (snake_case, camelCase, kebab-case, dotted). Any other name is withheld. */
export const ARGUMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export interface ToolArgument {
  /** The property's name, or null when it is not a plain identifier. */
  name: string | null;
  /** The JSON types its `type` states, in JSON_TYPES order; empty when it states none of them. */
  types: JsonType[];
  required: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function readArguments(schema: Record<string, unknown>): ToolArgument[] {
  if (!isRecord(schema.properties)) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(schema.properties).map(([key, property]) => {
    const stated = isRecord(property) ? property.type : undefined;
    const list: unknown[] = Array.isArray(stated) ? stated : [stated];
    return {
      name: ARGUMENT_NAME_PATTERN.test(key) ? key : null,
      types: JSON_TYPES.filter((t) => list.includes(t)),
      required: required.includes(key),
    };
  });
}
