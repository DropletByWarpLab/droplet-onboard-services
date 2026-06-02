export type PasswordRuleId = "length" | "classes";

export interface PasswordRule {
  id: PasswordRuleId;
  label: string;
  test: (pw: string) => boolean;
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const PASSWORD_REQUIRED_CLASSES = 3;

/** Count distinct character classes present: lower, upper, digit, symbol. */
function classCount(pw: string): number {
  let n = 0;
  if (/[a-z]/.test(pw)) n += 1;
  if (/[A-Z]/.test(pw)) n += 1;
  if (/[0-9]/.test(pw)) n += 1;
  if (/[^a-zA-Z0-9]/.test(pw)) n += 1;
  return n;
}

export const PASSWORD_RULES: PasswordRule[] = [
  {
    id: "length",
    label: `Between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters`,
    test: (pw) => pw.length >= PASSWORD_MIN && pw.length <= PASSWORD_MAX,
  },
  {
    id: "classes",
    label: `At least ${PASSWORD_REQUIRED_CLASSES} of: lowercase, uppercase, number, symbol`,
    test: (pw) => classCount(pw) >= PASSWORD_REQUIRED_CLASSES,
  },
];

export function validatePassword(pw: string): {
  ok: boolean;
  failed: PasswordRuleId[];
} {
  const failed = PASSWORD_RULES.filter((r) => !r.test(pw)).map((r) => r.id);
  return { ok: failed.length === 0, failed };
}
