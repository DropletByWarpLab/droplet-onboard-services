/**
 * WARP-1424 — `calculate` LLM tool.
 *
 * Misc dev-utility: safely evaluates an arithmetic/scientific expression
 * with a hand-rolled tokenizer + recursive-descent evaluator. No `eval`,
 * no `new Function`, no dynamic code execution of any kind — unknown
 * identifiers are rejected at parse time. Tier-1 read; pure computation,
 * no I/O.
 *
 * Precedence (low → high): `+ -`  <  `* / %`  <  unary `-`  <  `^`.
 * `^` is right-associative, so `2^3^2` = 512, and because unary minus
 * binds looser than `^`, `-2^2` = -(2^2) = -4. Function and constant
 * names are case-insensitive; trig operates in radians. NaN/Infinity
 * never escape into `data` — any non-finite intermediate or final value
 * is reported as a NOT_FINITE error (division/modulo by zero gets the
 * more specific DIVISION_BY_ZERO).
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const MAX_EXPRESSION_LENGTH = 512;
const MAX_PRECISION = 15;

/** Single-argument functions. `log` is base 10; `ln` is the natural log. */
const UNARY_FUNCTIONS = new Map<string, (x: number) => number>([
  ["sqrt", Math.sqrt],
  ["abs", Math.abs],
  ["round", Math.round],
  ["floor", Math.floor],
  ["ceil", Math.ceil],
  ["sin", Math.sin],
  ["cos", Math.cos],
  ["tan", Math.tan],
  ["asin", Math.asin],
  ["acos", Math.acos],
  ["atan", Math.atan],
  ["log", Math.log10],
  ["ln", Math.log],
  ["exp", Math.exp],
]);

/** Variadic functions taking 2+ arguments. */
const VARIADIC_FUNCTIONS = new Map<string, (...values: number[]) => number>([
  ["min", Math.min],
  ["max", Math.max],
]);

// Maps (not object literals) so hostile identifiers like `constructor` or
// `__proto__` can never resolve through the prototype chain.
const CONSTANTS = new Map<string, number>([
  ["pi", Math.PI],
  ["e", Math.E],
]);

const FUNCTION_NAMES =
  [...UNARY_FUNCTIONS.keys(), ...VARIADIC_FUNCTIONS.keys()].join(", ");

type CalcErrorCode = "SYNTAX_ERROR" | "UNKNOWN_FUNCTION" | "DIVISION_BY_ZERO" | "NOT_FINITE";

class CalcError extends Error {
  constructor(
    readonly code: CalcErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "op"; op: string }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" };

function describeToken(token: Token): string {
  switch (token.kind) {
    case "number":
      return `number ${token.value}`;
    case "ident":
      return `identifier '${token.name}'`;
    case "op":
      return `operator '${token.op}'`;
    case "lparen":
      return "'('";
    case "rparen":
      return "')'";
    case "comma":
      return "','";
  }
}

const NUMBER_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)/;
const IDENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*/;

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expression.length) {
    const ch = expression.charAt(i);
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(expression.charAt(i + 1)))) {
      const match = NUMBER_PATTERN.exec(expression.slice(i));
      if (!match) {
        throw new CalcError("SYNTAX_ERROR", `malformed number at position ${i}`);
      }
      tokens.push({ kind: "number", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const match = IDENT_PATTERN.exec(expression.slice(i));
      if (!match) {
        throw new CalcError("SYNTAX_ERROR", `malformed identifier at position ${i}`);
      }
      tokens.push({ kind: "ident", name: match[0].toLowerCase() });
      i += match[0].length;
      continue;
    }
    if ("+-*/%^".includes(ch)) {
      tokens.push({ kind: "op", op: ch });
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      i += 1;
      continue;
    }
    throw new CalcError("SYNTAX_ERROR", `unexpected character '${ch}' at position ${i}`);
  }
  return tokens;
}

function assertFinite(value: number, context: string): number {
  if (!Number.isFinite(value)) {
    throw new CalcError(
      "NOT_FINITE",
      `${context} produced a non-finite value (NaN or Infinity) — check for domain errors (e.g. sqrt/log of a negative) or overflow`,
    );
  }
  return value;
}

/** Recursive-descent parser that evaluates as it parses. */
class Evaluator {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  evaluate(): number {
    if (this.tokens.length === 0) {
      throw new CalcError("SYNTAX_ERROR", "expression is empty");
    }
    const value = this.parseAdditive();
    const trailing = this.tokens[this.pos];
    if (trailing) {
      throw new CalcError(
        "SYNTAX_ERROR",
        `unexpected ${describeToken(trailing)} after end of expression`,
      );
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseAdditive(): number {
    let left = this.parseMultiplicative();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== "op" || (token.op !== "+" && token.op !== "-")) {
        return left;
      }
      this.pos += 1;
      const right = this.parseMultiplicative();
      left = assertFinite(token.op === "+" ? left + right : left - right, `'${token.op}'`);
    }
  }

  private parseMultiplicative(): number {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== "op" || (token.op !== "*" && token.op !== "/" && token.op !== "%")) {
        return left;
      }
      this.pos += 1;
      const right = this.parseUnary();
      if ((token.op === "/" || token.op === "%") && right === 0) {
        throw new CalcError(
          "DIVISION_BY_ZERO",
          token.op === "/" ? "division by zero" : "modulo by zero",
        );
      }
      const value = token.op === "*" ? left * right : token.op === "/" ? left / right : left % right;
      left = assertFinite(value, `'${token.op}'`);
    }
  }

  private parseUnary(): number {
    const token = this.peek();
    if (token?.kind === "op" && token.op === "-") {
      this.pos += 1;
      return -this.parseUnary();
    }
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parseAtom();
    const token = this.peek();
    if (token?.kind !== "op" || token.op !== "^") {
      return base;
    }
    this.pos += 1;
    // Right-associative; the exponent may itself carry a unary minus (2^-3).
    const exponent = this.parseUnary();
    return assertFinite(base ** exponent, "'^'");
  }

  private parseAtom(): number {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (!token) {
      throw new CalcError("SYNTAX_ERROR", "unexpected end of expression");
    }
    if (token.kind === "number") {
      return token.value;
    }
    if (token.kind === "lparen") {
      const value = this.parseAdditive();
      this.expectCloseParen();
      return value;
    }
    if (token.kind === "ident") {
      if (this.peek()?.kind === "lparen") {
        return this.parseCall(token.name);
      }
      const constant = CONSTANTS.get(token.name);
      if (constant !== undefined) {
        return constant;
      }
      throw new CalcError(
        "SYNTAX_ERROR",
        `unknown identifier '${token.name}' — only the constants pi and e are available`,
      );
    }
    throw new CalcError("SYNTAX_ERROR", `unexpected ${describeToken(token)}`);
  }

  private parseCall(name: string): number {
    this.pos += 1; // consume '('
    const first = this.parseAdditive();
    const rest: number[] = [];
    while (this.peek()?.kind === "comma") {
      this.pos += 1;
      rest.push(this.parseAdditive());
    }
    this.expectCloseParen();

    const unary = UNARY_FUNCTIONS.get(name);
    if (unary) {
      if (rest.length > 0) {
        throw new CalcError(
          "SYNTAX_ERROR",
          `${name}() takes exactly 1 argument, got ${rest.length + 1}`,
        );
      }
      return assertFinite(unary(first), `${name}()`);
    }
    const variadic = VARIADIC_FUNCTIONS.get(name);
    if (variadic) {
      if (rest.length < 1) {
        throw new CalcError("SYNTAX_ERROR", `${name}() takes at least 2 arguments, got 1`);
      }
      return assertFinite(variadic(first, ...rest), `${name}()`);
    }
    throw new CalcError(
      "UNKNOWN_FUNCTION",
      `unknown function '${name}' — available: ${FUNCTION_NAMES}`,
    );
  }

  private expectCloseParen(): void {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (token?.kind !== "rparen") {
      throw new CalcError(
        "SYNTAX_ERROR",
        `expected ')' but found ${token ? describeToken(token) : "end of expression"}`,
      );
    }
  }
}

const inputSchema = {
  type: "object",
  properties: {
    expression: {
      type: "string",
      minLength: 1,
      maxLength: MAX_EXPRESSION_LENGTH,
      description:
        "The arithmetic expression to evaluate, e.g. '2*(3+4)^2' or 'round(sin(pi/6)*100)'.",
    },
    precision: {
      type: "integer",
      minimum: 0,
      maximum: MAX_PRECISION,
      description: `Optional decimal places (0-${MAX_PRECISION}) to round the result to.`,
    },
  },
  required: ["expression"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const expression = args.expression;
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "expression is required and must be a non-empty string" },
    };
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "EXPRESSION_TOO_LONG",
        message: `expression is ${expression.length} characters — the maximum is ${MAX_EXPRESSION_LENGTH}`,
      },
    };
  }
  const precision = args.precision;
  if (
    precision !== undefined &&
    (typeof precision !== "number" ||
      !Number.isInteger(precision) ||
      precision < 0 ||
      precision > MAX_PRECISION)
  ) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: `precision must be an integer between 0 and ${MAX_PRECISION}` },
    };
  }

  let result: number;
  try {
    result = new Evaluator(tokenize(expression)).evaluate();
  } catch (err) {
    if (err instanceof CalcError) {
      return { ok: false, status: "error", error: { code: err.code, message: err.message } };
    }
    throw err;
  }
  // Belt and braces: every operator/function already asserts finiteness,
  // but NaN/Infinity must never escape into `data`.
  if (!Number.isFinite(result)) {
    return {
      ok: false,
      status: "error",
      error: { code: "NOT_FINITE", message: "expression did not produce a finite number" },
    };
  }

  if (precision !== undefined) {
    result = Number(result.toFixed(precision));
  }
  const formatted = precision !== undefined ? result.toFixed(precision) : String(result);

  return {
    ok: true,
    data: { type: "calculate", expression, result, formatted },
  };
}

const tool: Tool = {
  name: "calculate",
  description:
    "Evaluate an arithmetic/scientific expression safely (hand-rolled parser, no code execution). Supports + - * / % ^ (power, right-associative), parentheses, unary minus, the functions sqrt, abs, round, floor, ceil, sin, cos, tan, asin, acos, atan, log (base 10), ln, exp, min, max (min/max take 2+ args), and the constants pi and e. Trig is in radians. Optional `precision` (0-15) rounds the result to that many decimal places. Tier-1 read; pure computation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
