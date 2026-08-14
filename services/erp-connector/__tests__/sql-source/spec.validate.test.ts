/**
 * WARP-2011 — registration-time descriptor validation.
 *
 * Everything knowable without a schema map or a runtime value is rejected
 * here, so the operator sees the error while the form is still in front of
 * them rather than on a read months later.
 *
 * MUTATION (mandatory): delete the limit range check — the `limit: 501` case
 * must go red.
 */
import { describe, it, expect } from "vitest";
import {
  assertValidQuerySpec,
  MAX_IN_ARITY,
  QuerySpecError,
  SQL_OPS,
  type SqlQuerySpec,
} from "../../src/sql-source/spec.js";

/** A minimal descriptor that passes; each test perturbs exactly one thing. */
function validSpec(): SqlQuerySpec {
  return {
    object: "patients",
    columns: ["patient_id", "last_name"],
    where: [{ column: "last_name", op: "prefix", param: "q" }],
    orderBy: [{ column: "last_name", direction: "asc" }],
    limit: 50,
    params: [{ name: "q", type: "string" }],
  };
}

describe("assertValidQuerySpec — accepts", () => {
  it("the baseline descriptor", () => {
    expect(() => assertValidQuerySpec(validSpec())).not.toThrow();
  });

  it("a descriptor with no predicates and no params", () => {
    expect(() =>
      assertValidQuerySpec({
        object: "patients",
        columns: ["patient_id"],
        where: [],
        limit: 1,
        params: [],
      }),
    ).not.toThrow();
  });

  it("both boundary limits", () => {
    for (const limit of [1, 500]) {
      expect(() => assertValidQuerySpec({ ...validSpec(), limit })).not.toThrow();
    }
  });
});

describe("assertValidQuerySpec — operators", () => {
  it("rejects an unknown operator", () => {
    const spec = validSpec();
    // Deliberately outside the closed enum — the shape an untrusted row takes.
    spec.where = [{ column: "last_name", op: "regex" as never, param: "q" }];
    expect(() => assertValidQuerySpec(spec)).toThrow(/unknown operator "regex"/);
  });

  it("accepts every member of the closed enum", () => {
    for (const op of SQL_OPS) {
      const nullary = op === "is_null" || op === "is_not_null";
      const spec: SqlQuerySpec = {
        object: "patients",
        columns: ["patient_id"],
        where: [
          nullary
            ? { column: "last_name", op }
            : op === "in"
              ? { column: "last_name", op, param: "q", maxItems: 4 }
              : { column: "last_name", op, param: "q" },
        ],
        limit: 10,
        params: nullary ? [] : [{ name: "q", type: "string" }],
      };
      expect(() => assertValidQuerySpec(spec), `op ${op}`).not.toThrow();
    }
  });

  it("rejects a param declared for an op that binds no value", () => {
    const spec = validSpec();
    spec.where = [{ column: "deleted_at", op: "is_null", param: "q" }];
    expect(() => assertValidQuerySpec(spec)).toThrow(/binds no value/);
  });

  it("rejects a prefix match against a non-string param", () => {
    const spec = validSpec();
    spec.params = [{ name: "q", type: "number" }];
    expect(() => assertValidQuerySpec(spec)).toThrow(/must be string/);
  });
});

describe("assertValidQuerySpec — row cap", () => {
  it("rejects a missing limit", () => {
    const spec = validSpec();
    delete (spec as Partial<SqlQuerySpec>).limit;
    expect(() => assertValidQuerySpec(spec as SqlQuerySpec)).toThrow(/integer limit/);
  });

  it("rejects a non-integer limit", () => {
    expect(() => assertValidQuerySpec({ ...validSpec(), limit: 10.5 })).toThrow(/integer limit/);
  });

  it("rejects limit 0", () => {
    expect(() => assertValidQuerySpec({ ...validSpec(), limit: 0 })).toThrow(QuerySpecError);
  });

  it("rejects limit 501", () => {
    expect(() => assertValidQuerySpec({ ...validSpec(), limit: 501 })).toThrow(/outside 1\.\.500/);
  });
});

describe("assertValidQuerySpec — IN arity", () => {
  it(`rejects a declared arity above ${MAX_IN_ARITY}`, () => {
    const spec = validSpec();
    spec.where = [{ column: "patient_id", op: "in", param: "q", maxItems: 33 }];
    expect(() => assertValidQuerySpec(spec)).toThrow(/maxItems 33, outside 1\.\.32/);
  });

  it("rejects an IN with no declared arity at all", () => {
    const spec = validSpec();
    spec.where = [{ column: "patient_id", op: "in", param: "q" }];
    expect(() => assertValidQuerySpec(spec)).toThrow(/must declare an integer maxItems/);
  });

  it("accepts the boundary arity", () => {
    const spec = validSpec();
    spec.where = [{ column: "patient_id", op: "in", param: "q", maxItems: MAX_IN_ARITY }];
    expect(() => assertValidQuerySpec(spec)).not.toThrow();
  });

  it("rejects maxItems on an op that is not IN", () => {
    const spec = validSpec();
    spec.where = [{ column: "last_name", op: "eq", param: "q", maxItems: 4 }];
    expect(() => assertValidQuerySpec(spec)).toThrow(/only "in" bounds arity/);
  });
});

describe("assertValidQuerySpec — parameters", () => {
  it("rejects a where clause referencing an undeclared param", () => {
    const spec = validSpec();
    spec.where = [{ column: "last_name", op: "prefix", param: "nope" }];
    expect(() => assertValidQuerySpec(spec)).toThrow(/undeclared param "nope"/);
  });

  it("rejects a declared-but-unused param", () => {
    const spec = validSpec();
    spec.params = [
      { name: "q", type: "string" },
      { name: "unused", type: "string" },
    ];
    expect(() => assertValidQuerySpec(spec)).toThrow(/declares param "unused" but never uses it/);
  });

  it("rejects a duplicate param declaration", () => {
    const spec = validSpec();
    spec.params = [
      { name: "q", type: "string" },
      { name: "q", type: "string" },
    ];
    expect(() => assertValidQuerySpec(spec)).toThrow(/declares param "q" twice/);
  });

  it("rejects an unknown param type", () => {
    const spec = validSpec();
    spec.params = [{ name: "q", type: "blob" as never }];
    expect(() => assertValidQuerySpec(spec)).toThrow(/unknown type "blob"/);
  });

  it("rejects a param name that is not a plain lower-case identifier", () => {
    const spec = validSpec();
    spec.params = [{ name: "q; DROP TABLE patients", type: "string" }];
    expect(() => assertValidQuerySpec(spec)).toThrow(/invalid param name/);
  });
});

describe("assertValidQuerySpec — columns", () => {
  it("rejects a descriptor selecting no columns", () => {
    expect(() => assertValidQuerySpec({ ...validSpec(), columns: [] })).toThrow(
      /selects no columns/,
    );
  });

  it("rejects duplicate columns", () => {
    expect(() =>
      assertValidQuerySpec({ ...validSpec(), columns: ["patient_id", "PATIENT_ID"] }),
    ).toThrow(/twice/);
  });

  it("rejects more than 64 columns", () => {
    const columns = Array.from({ length: 65 }, (_, i) => `c${i}`);
    expect(() => assertValidQuerySpec({ ...validSpec(), columns })).toThrow(/max 64/);
  });

  it("accepts exactly 64 columns", () => {
    const columns = Array.from({ length: 64 }, (_, i) => `c${i}`);
    expect(() => assertValidQuerySpec({ ...validSpec(), columns })).not.toThrow();
  });
});

describe("assertValidQuerySpec — ordering", () => {
  it("rejects a direction outside the closed enum", () => {
    const spec = validSpec();
    spec.orderBy = [{ column: "last_name", direction: "sideways" as never }];
    expect(() => assertValidQuerySpec(spec)).toThrow(/expected "asc" or "desc"/);
  });

  it("rejects an orderBy entry with no column", () => {
    const spec = validSpec();
    spec.orderBy = [{ column: "  ", direction: "asc" }];
    expect(() => assertValidQuerySpec(spec)).toThrow(/orderBy with no column/);
  });
});

describe("assertValidQuerySpec — object", () => {
  it("rejects an empty object name", () => {
    expect(() => assertValidQuerySpec({ ...validSpec(), object: "" })).toThrow(
      /must name an object/,
    );
  });
});
