/**
 * Text-safety helpers for person-controlled strings: what Postgres can store
 * and sign byte-for-byte, and what is safe to render.
 *
 *   · `chainSafeText`          — storable in `text` / `jsonb` and round-trips
 *                                exactly (the signed audit chain needs that);
 *   · `hasUnsafeDisplayChars`  — carries a control / bidi / separator character
 *                                (→ 400 for user input);
 *   · `stripUnsafeDisplayChars` — the same text without those characters, for
 *                                text that is not this request's input (a
 *                                stored display name, a client descriptor).
 *
 * Pure: no I/O, no clock, no Prisma.
 */

/** `String.prototype.isWellFormed` (Node 20+; the ES2022 lib does not type it). */
function isWellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

/**
 * True when Postgres can store `s` in `text` and `jsonb` and it round-trips
 * byte-for-byte: no U+0000 (text refuses it with 22021, jsonb with 22P05) and
 * no lone surrogate (not valid UTF-8 at all). Routes run user text through
 * this and answer 400 before the transaction.
 */
export function chainSafeText(s: string): boolean {
  return !s.includes("\u0000") && isWellFormed(s);
}

/**
 * Characters person-controlled display text may not carry: C0/C1 controls,
 * line and paragraph separators, the bidi embeddings / overrides U+202A–U+202E
 * and isolates U+2066–U+2069 (they reorder everything after them on the line,
 * and an unclosed one runs into the fixed copy around the text), and U+FEFF.
 * Deliberately narrow: ZWNJ / ZWJ (Persian and Indic names, emoji) and the
 * LRM / RLM / ALM marks (they leave no open state behind) stay.
 */
const DISPLAY_UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩﻿]/u;
const DISPLAY_UNSAFE_ALL = new RegExp(DISPLAY_UNSAFE.source, "gu");

/** True when `s` holds a character `DISPLAY_UNSAFE` refuses (→ 400 for user input). */
export function hasUnsafeDisplayChars(s: string): boolean {
  return DISPLAY_UNSAFE.test(s);
}

/** `s` without the characters `DISPLAY_UNSAFE` refuses — for text that is not this request's input (a stored display name). */
export function stripUnsafeDisplayChars(s: string): string {
  return s.replace(DISPLAY_UNSAFE_ALL, "");
}
