/**
 * WARP-2011 — descriptor → parameterized statement.
 *
 * The load-bearing property: NO value ever reaches the SQL text. The scan at
 * the bottom of this file compiles every fixture with sentinel values and
 * asserts none of them appear as a substring of the emitted SQL — including
 * LIKE-prefix terms and IN lists, which are the two places a hand-rolled
 * builder usually concatenates.
 *
 * MUTATION (mandatory): make `prefix` interpolate the term instead of binding
 * it — the sentinel scan must go red.
 */
import { describe, it, expect } from "vitest";
import { buildSchemaMap, SchemaResolutionError, type IntrospectedTable } from "../../src/schema-map.js";
import {
  compileQuerySpec,
  QueryParamError,
  type SqlQuerySpec,
} from "../../src/sql-source/spec.js";

const TABLES: IntrospectedTable[] = [
  {
    name: "Patients",
    owner: "Clinic",
    columns: [
      { name: "PatientId", type: "integer" },
      { name: "FirstName", type: "varchar" },
      { name: "LastName", type: "varchar" },
      { name: "Balance", type: "numeric" },
      { name: "DeletedAt", type: "timestamp" },
      { name: "Active", type: "boolean" },
    ],
  },
];

const ansiMap = buildSchemaMap(TABLES, { identifierCase: "preserve" });

/** Sentinels chosen so an accidental appearance in the SQL is unmistakable. */
const SENTINEL_TEXT = "ZZSENTINELTEXTZZ";
const SENTINEL_NUMBER = 987654321;

describe("compileQuerySpec — shape", () => {
  it("selects the named columns from the resolved object with a trailing LIMIT", () => {
    const spec: SqlQuerySpec = {
      object: "Patients",
      columns: ["PatientId", "LastName"],
      where: [],
      limit: 25,
      params: [],
    };
    const built = compileQuerySpec(ansiMap, spec);
    expect(built.sql).toBe(
      'SELECT "PatientId", "LastName" FROM "Clinic"."Patients" LIMIT 25',
    );
    expect(built.params).toEqual([]);
  });

  it("emits SELECT TOP n for top-style engines and no trailing LIMIT", () => {
    const spec: SqlQuerySpec = {
      object: "Patients",
      columns: ["PatientId"],
      where: [],
      limit: 10,
      params: [],
    };
    const built = compileQuerySpec(ansiMap, spec, {}, { limitStyle: "top" });
    expect(built.sql).toBe('SELECT TOP 10 "PatientId" FROM "Clinic"."Patients"');
    expect(built.sql).not.toContain("LIMIT");
  });

  it("renders ORDER BY with a closed-enum direction", () => {
    const spec: SqlQuerySpec = {
      object: "Patients",
      columns: ["PatientId"],
      where: [],
      orderBy: [
        { column: "LastName", direction: "asc" },
        { column: "PatientId", direction: "desc" },
      ],
      limit: 5,
      params: [],
    };
    const built = compileQuerySpec(ansiMap, spec);
    expect(built.sql).toContain('ORDER BY "LastName" ASC, "PatientId" DESC');
  });

  it("honours the map's quote style and preserved case end to end", () => {
    const backtickMap = buildSchemaMap(TABLES, {
      identifierCase: "preserve",
      quoteStyle: "backtick",
    });
    const built = compileQuerySpec(
      backtickMap,
      {
        object: "patients",
        columns: ["firstname"],
        where: [{ column: "patientid", op: "eq", param: "pid" }],
        limit: 1,
        params: [{ name: "pid", type: "number" }],
      },
      { pid: 42 },
    );
    expect(built.sql).toBe(
      "SELECT `FirstName` FROM `Clinic`.`Patients` WHERE `PatientId` = ? LIMIT 1",
    );
  });
});

describe("compileQuerySpec — predicates bind every value", () => {
  it("binds a scalar comparison as ?", () => {
    const built = compileQuerySpec(
      ansiMap,
      {
        object: "Patients",
        columns: ["PatientId"],
        where: [{ column: "Balance", op: "gte", param: "min" }],
        limit: 10,
        params: [{ name: "min", type: "number" }],
      },
      { min: SENTINEL_NUMBER },
    );
    expect(built.sql).toContain('"Balance" >= ?');
    expect(built.params).toEqual([SENTINEL_NUMBER]);
  });

  it("escapes LIKE metacharacters and appends the wildcard AFTER escaping", () => {
    const built = compileQuerySpec(
      ansiMap,
      {
        object: "Patients",
        columns: ["PatientId"],
        where: [{ column: "LastName", op: "prefix", param: "q" }],
        limit: 10,
        params: [{ name: "q", type: "string" }],
      },
      { q: "100%_sure" },
    );
    expect(built.sql).toContain(`"LastName" LIKE ? ESCAPE '\\'`);
    // The user's "%" and "_" are escaped so they match literally; only the
    // appended trailing % is a wildcard.
    expect(built.params).toEqual(["100\\%\\_sure%"]);
  });

  it("emits exactly N placeholders for IN and binds each element", () => {
    const built = compileQuerySpec(
      ansiMap,
      {
        object: "Patients",
        columns: ["PatientId"],
        where: [{ column: "PatientId", op: "in", param: "ids", maxItems: 8 }],
        limit: 10,
        params: [{ name: "ids", type: "number" }],
      },
      { ids: [1, 2, 3] },
    );
    expect(built.sql).toContain('"PatientId" IN (?, ?, ?)');
    expect(built.params).toEqual([1, 2, 3]);
  });

  it("emits two placeholders for BETWEEN", () => {
    const built = compileQuerySpec(
      ansiMap,
      {
        object: "Patients",
        columns: ["PatientId"],
        where: [{ column: "Balance", op: "between", param: "range" }],
        limit: 10,
        params: [{ name: "range", type: "number" }],
      },
      { range: [10, 20] },
    );
    expect(built.sql).toContain('"Balance" BETWEEN ? AND ?');
    expect(built.params).toEqual([10, 20]);
  });

  it("binds nothing for the nullary ops", () => {
    const built = compileQuerySpec(ansiMap, {
      object: "Patients",
      columns: ["PatientId"],
      where: [
        { column: "DeletedAt", op: "is_null" },
        { column: "Active", op: "is_not_null" },
      ],
      limit: 10,
      params: [],
    });
    expect(built.sql).toContain('"DeletedAt" IS NULL AND "Active" IS NOT NULL');
    expect(built.params).toEqual([]);
  });
});

describe("compileQuerySpec — runtime argument contract", () => {
  const base: SqlQuerySpec = {
    object: "Patients",
    columns: ["PatientId"],
    where: [{ column: "LastName", op: "eq", param: "name" }],
    limit: 10,
    params: [{ name: "name", type: "string" }],
  };

  it("refuses a missing value rather than binding undefined", () => {
    expect(() => compileQuerySpec(ansiMap, base, {})).toThrow(QueryParamError);
  });

  it("refuses a value of the wrong declared type rather than coercing it", () => {
    expect(() => compileQuerySpec(ansiMap, base, { name: 42 })).toThrow(QueryParamError);
  });

  it("refuses an IN list longer than the declared maxItems", () => {
    expect(() =>
      compileQuerySpec(
        ansiMap,
        {
          object: "Patients",
          columns: ["PatientId"],
          where: [{ column: "PatientId", op: "in", param: "ids", maxItems: 2 }],
          limit: 10,
          params: [{ name: "ids", type: "number" }],
        },
        { ids: [1, 2, 3] },
      ),
    ).toThrow(QueryParamError);
  });

  it("refuses a BETWEEN value that is not a two-element array", () => {
    expect(() =>
      compileQuerySpec(
        ansiMap,
        {
          object: "Patients",
          columns: ["PatientId"],
          where: [{ column: "Balance", op: "between", param: "r" }],
          limit: 10,
          params: [{ name: "r", type: "number" }],
        },
        { r: [1, 2, 3] },
      ),
    ).toThrow(QueryParamError);
  });
});

describe("compileQuerySpec — unresolved identifiers are a hard stop", () => {
  it("throws SchemaResolutionError naming an unknown object", () => {
    expect(() =>
      compileQuerySpec(ansiMap, {
        object: "Ledger",
        columns: ["PatientId"],
        where: [],
        limit: 10,
        params: [],
      }),
    ).toThrow(SchemaResolutionError);
  });

  it("throws SchemaResolutionError naming an unknown column", () => {
    expect(() =>
      compileQuerySpec(ansiMap, {
        object: "Patients",
        columns: ["Ssn"],
        where: [],
        limit: 10,
        params: [],
      }),
    ).toThrow(/unknown column "Ssn"/);
  });

  it("throws on an unknown ORDER BY column — never concatenates it", () => {
    expect(() =>
      compileQuerySpec(ansiMap, {
        object: "Patients",
        columns: ["PatientId"],
        where: [],
        orderBy: [{ column: "Ssn; DROP TABLE Patients", direction: "asc" }],
        limit: 10,
        params: [],
      }),
    ).toThrow(SchemaResolutionError);
  });
});

/* -------------------------------------------------------------------------- */
/* The param-literal scan                                                     */
/* -------------------------------------------------------------------------- */

describe("no param VALUE ever reaches the SQL text", () => {
  /** One fixture per value-binding operator. */
  const FIXTURES: { label: string; spec: SqlQuerySpec; params: Record<string, unknown> }[] = [
    {
      label: "eq",
      spec: {
        object: "Patients",
        columns: ["PatientId"],
        where: [{ column: "LastName", op: "eq", param: "v" }],
        limit: 10,
        params: [{ name: "v", type: "string" }],
      },
      params: { v: SENTINEL_TEXT },
    },
    {
      label: "prefix",
      spec: {
        object: "Patients",
        columns: ["PatientId"],
        where: [{ column: "LastName", op: "prefix", param: "v" }],
        limit: 10,
        params: [{ name: "v", type: "string" }],
      },
      params: { v: SENTINEL_TEXT },
    },
    {
      label: "in",
      spec: {
        object: "Patients",
        columns: ["PatientId"],
        where: [{ column: "LastName", op: "in", param: "v", maxItems: 4 }],
        limit: 10,
        params: [{ name: "v", type: "string" }],
      },
      params: { v: [SENTINEL_TEXT, `${SENTINEL_TEXT}2`] },
    },
    {
      label: "between",
      spec: {
        object: "Patients",
        columns: ["PatientId"],
        where: [{ column: "Balance", op: "between", param: "v" }],
        limit: 10,
        params: [{ name: "v", type: "number" }],
      },
      params: { v: [SENTINEL_NUMBER, SENTINEL_NUMBER + 1] },
    },
    {
      label: "neq + gte, two predicates",
      spec: {
        object: "Patients",
        columns: ["PatientId", "FirstName"],
        where: [
          { column: "LastName", op: "neq", param: "a" },
          { column: "Balance", op: "gte", param: "b" },
        ],
        orderBy: [{ column: "LastName", direction: "desc" }],
        limit: 500,
        params: [
          { name: "a", type: "string" },
          { name: "b", type: "number" },
        ],
      },
      params: { a: SENTINEL_TEXT, b: SENTINEL_NUMBER },
    },
  ];

  for (const style of ["limit", "top"] as const) {
    for (const fixture of FIXTURES) {
      it(`${fixture.label} (${style}) — SQL carries no substring derived from a value`, () => {
        const built = compileQuerySpec(ansiMap, fixture.spec, fixture.params, {
          limitStyle: style,
        });
        expect(built.sql).not.toContain(SENTINEL_TEXT);
        expect(built.sql).not.toContain(String(SENTINEL_NUMBER));

        // The scan must not pass merely because nothing was bound: every
        // declared value has to turn up in `params`. `prefix` binds an escaped
        // term with a trailing wildcard, so match on containment.
        const expected = Object.values(fixture.params).flatMap((v) =>
          Array.isArray(v) ? v.map(String) : [String(v)],
        );
        const bound = built.params.map(String);
        expect(bound.length).toBe(expected.length);
        for (const value of expected) {
          expect(bound.some((p) => p.includes(value)), `bound value ${value}`).toBe(true);
        }
      });
    }
  }

  it("interpolates the row cap and nothing else", () => {
    const built = compileQuerySpec(
      ansiMap,
      {
        object: "Patients",
        columns: ["PatientId"],
        where: [{ column: "LastName", op: "eq", param: "v" }],
        limit: 123,
        params: [{ name: "v", type: "string" }],
      },
      { v: SENTINEL_TEXT },
    );
    // The only digits in the SQL are the cap.
    expect(built.sql.match(/\d+/g)).toEqual(["123"]);
  });

  it("placeholder count equals bound-param count for every fixture", () => {
    for (const fixture of FIXTURES) {
      const built = compileQuerySpec(ansiMap, fixture.spec, fixture.params);
      const placeholders = (built.sql.match(/\?/g) ?? []).length;
      expect(placeholders).toBe(built.params.length);
    }
  });
});
