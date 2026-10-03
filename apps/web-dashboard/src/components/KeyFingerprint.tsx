"use client";

/**
 * WARP-3414 — the box's certificate key fingerprint, readable, with honest
 * copy about what it does and does not prove.
 *
 * The Droplet apps (the Mac app on a manual connect) ask an admin to confirm
 * the key of a box that uses its own certificate. That confirmation is only
 * worth something if the admin has a reference a person on the LAN cannot
 * rewrite. THIS display is not one: it reaches the admin over the same
 * connection the app is about to trust, so an attacker who sits in the middle
 * of that connection can show the admin their own key here. The copy says so,
 * and names the channels that are independent of it: the Droplet's own front
 * screen, the setup output, and `droplet-fingerprint` on the box. Never
 * present this block as proof.
 *
 * The string is the one the box computes (orchestrator
 * `lib/served-cert-pin.ts`): uppercase hex, 4-character groups, 16 groups.
 * It is shown in full, four groups to a line — never truncated: a short prefix
 * can be ground out by an impostor.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** Four groups per line, so 16 groups read as four short lines. Pure, for the test. */
export function fingerprintLines(fingerprint: string): string[] {
  const groups = fingerprint.split(" ").filter(Boolean);
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 4) lines.push(groups.slice(i, i + 4).join(" "));
  return lines;
}

export const FINGERPRINT_APP_COPY =
  "Apps check this fingerprint the first time they connect to a Droplet that uses its own certificate.";

export const FINGERPRINT_NOT_PROOF_COPY =
  "This page reaches you over the same connection the app will trust, so on its own it proves nothing. " +
  "Compare it with the fingerprint on the Droplet's front panel, if your Droplet has one (tap the code until it says Droplet fingerprint), " +
  "in the setup output, or run droplet-fingerprint on the Droplet.";

export function KeyFingerprint({ fingerprint }: { fingerprint: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(fingerprint)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className="mx-4 mb-3" data-testid="key-fingerprint">
      <div className="flex items-center justify-between gap-2">
        <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          Key fingerprint (SHA-256)
        </span>
        <button
          type="button"
          onClick={copy}
          className="btn ghost sm flex-shrink-0"
          aria-label="Copy key fingerprint"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="font-mono select-all" style={{ color: "var(--text)" }} data-testid="key-fingerprint-value">
        {fingerprintLines(fingerprint).map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
      <p className="type-caption-1 mt-1" style={{ color: "var(--text-muted)" }} data-testid="key-fingerprint-app-copy">
        {FINGERPRINT_APP_COPY}
      </p>
      <p className="type-caption-1 mt-1" style={{ color: "var(--text-muted)" }} data-testid="key-fingerprint-not-proof">
        {FINGERPRINT_NOT_PROOF_COPY}
      </p>
    </div>
  );
}
