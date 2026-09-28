/**
 * WARP-3205 — what the box reads from an extension tool's input schema.
 *
 * The schema is its author's JSON: any string in it can be prose. The
 * reading keeps only structure — a property's name when it is a plain
 * identifier, the JSON Schema type names `type` states, and whether
 * `required` lists it — so no author sentence reaches the arguments list.
 */
import { describe, it, expect } from "vitest";
import { readArguments } from "./tool-arguments";

describe("readArguments", () => {
  it("reads each top-level property's name, JSON types and whether it is required, in the schema's order", () => {
    expect(
      readArguments({
        type: "object",
        properties: {
          path: { type: "string", description: "Where to look." },
          limit: { type: ["integer", "null"] },
          flags: { type: "array", items: { type: "string" } },
        },
        required: ["path"],
      }),
    ).toEqual([
      { name: "path", types: ["string"], required: true },
      { name: "limit", types: ["integer", "null"], required: false },
      { name: "flags", types: ["array"], required: false },
    ]);
  });

  it("keeps only the seven JSON Schema type names, once each, and states none for anything else", () => {
    const args = readArguments({
      type: "object",
      properties: {
        a: { type: "Droplet verified: read-only" },
        b: { type: ["null", "string", "string", "safe"] },
        c: { enum: ["x"] },
        d: "not a schema",
      },
    });
    expect(args.map((a) => a.types)).toEqual([[], ["string", "null"], [], []]);
  });

  it("withholds a property name that is not a plain identifier", () => {
    const args = readArguments({
      type: "object",
      properties: { "Droplet checked this: safe": { type: "string" }, "file-path": { type: "string" }, "a.b": {} },
      required: ["Droplet checked this: safe"],
    });
    expect(args).toEqual([
      { name: null, types: ["string"], required: true },
      { name: "file-path", types: ["string"], required: false },
      { name: "a.b", types: [], required: false },
    ]);
  });

  it("a schema with no properties object declares no arguments; a malformed `required` requires nothing", () => {
    expect(readArguments({ type: "object" })).toEqual([]);
    expect(readArguments({ type: "object", properties: ["x"] })).toEqual([]);
    expect(readArguments({ type: "object", properties: { x: {} }, required: "x" })).toEqual([
      { name: "x", types: [], required: false },
    ]);
  });
});
