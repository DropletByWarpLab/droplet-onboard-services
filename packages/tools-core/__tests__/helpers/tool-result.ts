/**
 * Narrowing helpers for `ToolResult` in tests (WARP-2606, generalised).
 *
 * `ToolResult` is a discriminated union: `data` lives ONLY on the `ok: true`
 * arm and `error` ONLY on the `ok: false` arm. Reading either through the union
 * is a TS2339 — which `vitest` never reports, because esbuild strips types
 * without checking them, and which `typecheck:tests` does.
 *
 * These NARROW rather than cast, and that distinction is the whole point. A
 * cast (`out as { data: X }`) makes the compiler agree while leaving the
 * runtime free to hand back the OTHER arm: a handler that regressed into
 * returning an error would then fail with "cannot read properties of
 * undefined" — or, where the read feeds a `toMatchObject`, quietly compare
 * `undefined` against nothing and PASS. Narrowing turns that same regression
 * into a named failure carrying the tool's own error code, at the first line
 * that touches the result.
 *
 * WARP-2606 introduced this pair inside `crm-handlers.test.ts`. It lives here
 * because ADR-045 gave it a second and third caller, and a third hand-copied
 * pair is how the first one drifts from the other two.
 */
import type { ToolResult } from "../../src/types.js";

export type OkResult = Extract<ToolResult, { ok: true }>;
export type ErrResult = Extract<ToolResult, { ok: false }>;

/** Assert the success arm and return it narrowed. Throws with the tool's own
 *  error code when the handler returned a failure instead. */
export function expectOk(result: ToolResult): OkResult {
  if (!result.ok) {
    throw new Error(
      `expected a successful ToolResult, got ${result.status}: ` +
        `${result.error.code} — ${result.error.message}`,
    );
  }
  return result;
}

/** Assert the failure arm and return it narrowed. Throws when the handler
 *  succeeded, so a test that means to pin a refusal cannot pass on a success. */
export function expectErr(result: ToolResult): ErrResult {
  if (result.ok) {
    throw new Error(
      `expected a failing ToolResult, got ok with data: ${JSON.stringify(result.data)}`,
    );
  }
  return result;
}
