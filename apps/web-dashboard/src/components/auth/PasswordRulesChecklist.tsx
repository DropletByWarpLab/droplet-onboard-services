"use client";

import { Check, Circle } from "lucide-react";
import { PASSWORD_RULES } from "@droplet/auth-policy";

/**
 * Live password-requirements checklist. Each rule ticks green the moment
 * `validatePassword` would pass it. Pass `confirm` to add a "passwords
 * match" row. Rules come from @droplet/auth-policy — the same definitions
 * the orchestrator enforces, so the checklist can never drift from the API.
 */
export function PasswordRulesChecklist({
  password,
  confirm,
}: {
  password: string;
  confirm?: string;
}) {
  const rows = PASSWORD_RULES.map((r) => ({ label: r.label, ok: r.test(password) }));
  if (confirm !== undefined) {
    rows.push({
      label: "Passwords match",
      ok: password.length > 0 && password === confirm,
    });
  }
  return (
    <ul className="mt-2 space-y-1" aria-label="Password requirements">
      {rows.map((row) => (
        <li
          key={row.label}
          className={`flex items-center gap-2 type-caption-1 ${
            row.ok ? "text-system-green" : "text-label-quaternary"
          }`}
        >
          {row.ok ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <Circle size={13} aria-hidden="true" />
          )}
          <span>{row.label}</span>
          <span className="sr-only">{row.ok ? "satisfied" : "not satisfied"}</span>
        </li>
      ))}
    </ul>
  );
}
