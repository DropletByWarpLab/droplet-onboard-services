/**
 * WARP-2577 — every CRM "not found" code must reach the 404 arm.
 *
 * `mapServiceError` returns `false` for a message it does not recognise, and
 * the caller then falls through to the generic 500 handler. That is the exact
 * shape of the defect this ticket was filed for: five columns threw a Prisma
 * P2003 nobody mapped, and the caller was told the box had broken.
 *
 * Adding five `case` labels fixes today. It does not fix the SIXTH not-found
 * code someone adds next quarter — so this test is written against the RULE,
 * not the five codes:
 *
 *   every CRM_ERRORS key ending in _NOT_FOUND appears in the 404 arm.
 *
 * Read at source level rather than by driving Express, deliberately. The
 * question here is which labels are on which arm of a switch — mounting a
 * router, an auth stack and a Prisma double to answer it would test the mock
 * far more than the mapping, and would go green if someone deleted a case and
 * the request happened not to reach it.
 *
 * MUTATIONS THIS CATCHES:
 *   - delete any `case crm.CRM_ERRORS.*_NOT_FOUND` from the 404 arm
 *   - add a new *_NOT_FOUND code to the service and forget the route
 *   - move a not-found code to the 422 or 409 arm
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CRM_ERRORS } from "../services/crm/crm.service.js";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "crm.ts"), "utf8");

/**
 * The `case crm.CRM_ERRORS.X:` labels attached to the arm that responds with
 * `status`. A switch arm runs from its first label to the `return` that ends
 * it, so the slice between this status and the next `res.status(` is the arm.
 */
function labelsForStatus(status: number): string[] {
  const start = source.indexOf(`function mapServiceError`);
  expect(start, "mapServiceError not found in crm.ts").toBeGreaterThan(-1);
  const body = source.slice(start);
  const marker = `res.status(${status})`;
  const end = body.indexOf(marker);
  expect(end, `no res.status(${status}) arm in mapServiceError`).toBeGreaterThan(-1);

  // Walk back to the end of the previous arm so we only take THIS arm's labels.
  const previousArmEnd = body.lastIndexOf("return true;", end);
  const armStart = previousArmEnd === -1 ? 0 : previousArmEnd;
  const arm = body.slice(armStart, end);

  return [...arm.matchAll(/case\s+crm\.CRM_ERRORS\.([A-Z_]+)\s*:/g)].map((m) => m[1]);
}

describe("WARP-2577 — CRM error mapping", () => {
  it("maps every _NOT_FOUND code to 404, not only the ones that existed first", () => {
    const notFoundCodes = Object.keys(CRM_ERRORS).filter((key) => key.endsWith("_NOT_FOUND"));
    // Guards the guard: an empty list would make the loop below vacuous.
    expect(notFoundCodes.length, "CRM_ERRORS declares not-found codes").toBeGreaterThan(5);

    const mapped = labelsForStatus(404);
    for (const code of notFoundCodes) {
      expect(
        mapped,
        `CRM_ERRORS.${code} is not in the 404 arm — it falls through to a redacted 500`,
      ).toContain(code);
    }
  });

  it("names the five columns whose ids used to come back as a 500", () => {
    // The regression pin for this ticket specifically. Each code names its own
    // column so a caller can tell WHICH id they got wrong; a single generic
    // `not_found` would have been cheaper and useless.
    const mapped = labelsForStatus(404);
    for (const code of [
      "PROJECT_NOT_FOUND",
      "NOTE_NOT_FOUND",
      "EMAIL_MESSAGE_NOT_FOUND",
      "CALENDAR_EVENT_NOT_FOUND",
      "WORK_ITEM_NOT_FOUND",
    ]) {
      expect(mapped).toContain(code);
    }
  });

  it("keeps the wrong-row-for-this-request codes on 422", () => {
    // The 404/422 split is meaningful and easy to erode: INVALID_STAGE means
    // the stage EXISTS and belongs to another pipeline. Sweeping it into 404
    // would make a cross-pipeline mistake read as a typo.
    const on422 = labelsForStatus(422);
    expect(on422).toContain("INVALID_STAGE");
    expect(on422).not.toContain("STAGE_NOT_FOUND");
  });
});
