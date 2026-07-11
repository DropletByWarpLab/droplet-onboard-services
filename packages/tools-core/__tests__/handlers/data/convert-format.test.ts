/**
 * WARP-900 — `convert_data_format`. Tier-1 read, pure computation, no
 * ToolContext dependencies.
 */
import { describe, it, expect } from "vitest";
import convertDataFormat from "../../../src/handlers/data/convert-format.js";
import type { ToolContext } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;

describe("convert_data_format — JSON <-> YAML (lossless)", () => {
  it("converts JSON to YAML", async () => {
    const res = await convertDataFormat.handler(
      { input: JSON.stringify({ a: 1, b: ["x", "y"] }), from: "json", to: "yaml" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const output = (res.data as { output: string }).output;
      expect(output).toContain("a: 1");
      expect(output).toContain("- x");
      expect(output).toContain("- y");
    }
  });

  it("converts YAML to JSON", async () => {
    const res = await convertDataFormat.handler(
      { input: "a: 1\nb:\n  - x\n  - y\n", from: "yaml", to: "json" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const parsed = JSON.parse((res.data as { output: string }).output);
      expect(parsed).toEqual({ a: 1, b: ["x", "y"] });
    }
  });

  it("round-trips an arbitrary JSON value through YAML exactly", async () => {
    const original = { name: "Droplet", count: 3, nested: { flag: true, tags: ["a", "b"] }, empty: null };
    const toYaml = await convertDataFormat.handler(
      { input: JSON.stringify(original), from: "json", to: "yaml" },
      ctx,
    );
    expect(toYaml.ok).toBe(true);
    if (!toYaml.ok) return;
    const backToJson = await convertDataFormat.handler(
      { input: (toYaml.data as { output: string }).output, from: "yaml", to: "json" },
      ctx,
    );
    expect(backToJson.ok).toBe(true);
    if (backToJson.ok) {
      expect(JSON.parse((backToJson.data as { output: string }).output)).toEqual(original);
    }
  });
});

describe("convert_data_format — JSON <-> CSV (lossless for flat string records)", () => {
  it("converts a flat JSON array of objects to CSV", async () => {
    const res = await convertDataFormat.handler(
      {
        input: JSON.stringify([
          { name: "Ada", role: "engineer" },
          { name: "Doe, Jane", role: 'has "quotes"' },
        ]),
        from: "json",
        to: "csv",
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { output: string }).output).toBe(
        'name,role\r\nAda,engineer\r\n"Doe, Jane","has ""quotes"""',
      );
    }
  });

  it("converts CSV to a JSON array of objects", async () => {
    const res = await convertDataFormat.handler(
      { input: "name,role\r\nAda,engineer\r\nGrace,admiral", from: "csv", to: "json" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(JSON.parse((res.data as { output: string }).output)).toEqual([
        { name: "Ada", role: "engineer" },
        { name: "Grace", role: "admiral" },
      ]);
    }
  });

  it("round-trips a flat string-valued array through CSV exactly", async () => {
    const original = [
      { name: "Ada", role: "engineer" },
      { name: "Grace", role: "admiral" },
    ];
    const toCsv = await convertDataFormat.handler({ input: JSON.stringify(original), from: "json", to: "csv" }, ctx);
    expect(toCsv.ok).toBe(true);
    if (!toCsv.ok) return;
    const backToJson = await convertDataFormat.handler(
      { input: (toCsv.data as { output: string }).output, from: "csv", to: "json" },
      ctx,
    );
    expect(backToJson.ok).toBe(true);
    if (backToJson.ok) {
      expect(JSON.parse((backToJson.data as { output: string }).output)).toEqual(original);
    }
  });

  it("widens numbers/booleans/null to strings on the way to CSV (documented, not a bug)", async () => {
    const res = await convertDataFormat.handler(
      { input: JSON.stringify([{ n: 5, flag: true, missing: null }]), from: "json", to: "csv" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { output: string }).output).toBe("n,flag,missing\r\n5,true,");
    }
  });

  it("rejects non-array JSON when converting to CSV", async () => {
    const res = await convertDataFormat.handler({ input: JSON.stringify({ a: 1 }), from: "json", to: "csv" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_TABULAR");
  });

  it("rejects an array of non-objects when converting to CSV", async () => {
    const res = await convertDataFormat.handler({ input: JSON.stringify([1, 2, 3]), from: "json", to: "csv" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_TABULAR");
  });

  it("rejects a CSV row whose column count doesn't match the header", async () => {
    const res = await convertDataFormat.handler(
      { input: "a,b\n1,2\n3", from: "csv", to: "json" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("ROW_LENGTH_MISMATCH");
  });
});

describe("convert_data_format — error handling", () => {
  it("rejects missing args", async () => {
    const res = await convertDataFormat.handler({ from: "json", to: "yaml" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });

  it("rejects an unknown format", async () => {
    const res = await convertDataFormat.handler({ input: "{}", from: "json", to: "xml" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_FORMAT");
  });

  it("rejects from === to", async () => {
    const res = await convertDataFormat.handler({ input: "{}", from: "json", to: "json" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });

  it("rejects malformed JSON input", async () => {
    const res = await convertDataFormat.handler({ input: "{not json", from: "json", to: "yaml" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PARSE_FAILED");
  });

  it("rejects malformed YAML input", async () => {
    const res = await convertDataFormat.handler({ input: "a: [unterminated", from: "yaml", to: "json" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PARSE_FAILED");
  });

  it("rejects input over the size cap", async () => {
    const res = await convertDataFormat.handler(
      { input: "a".repeat(20_001), from: "yaml", to: "json" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INPUT_TOO_LONG");
  });
});

describe("convert_data_format — empty array edge case", () => {
  it("converts an empty JSON array to an empty CSV string", async () => {
    const res = await convertDataFormat.handler({ input: "[]", from: "json", to: "csv" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { output: string }).output).toBe("");
  });

  it("converts empty CSV input to an empty JSON array", async () => {
    const res = await convertDataFormat.handler({ input: "", from: "csv", to: "json" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(JSON.parse((res.data as { output: string }).output)).toEqual([]);
  });
});

describe("convert_data_format — tool metadata", () => {
  it("is named convert_data_format and is Tier-1 (no write, no confirm)", () => {
    expect(convertDataFormat.name).toBe("convert_data_format");
    expect(convertDataFormat.requiresWrite).toBe(false);
    expect(convertDataFormat.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema", () => {
    expect((convertDataFormat.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});
