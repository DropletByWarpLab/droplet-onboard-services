import { z } from "zod";
import { validatePassword } from "./password.js";

/**
 * Zod schema enforcing the shared password policy. On failure it raises a
 * single issue with the literal message "WEAK_PASSWORD" and the failing rule
 * ids in `params.failed`, so a route can map the field error to a typed code.
 */
export const passwordZod = z.string().superRefine((pw, ctx) => {
  const { failed } = validatePassword(pw);
  if (failed.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "WEAK_PASSWORD",
      params: { failed },
    });
  }
});
