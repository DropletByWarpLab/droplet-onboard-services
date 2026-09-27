/**
 * Resolve what a person called a dashboard page ("voice settings", "wifi",
 * "/settings/voice") against the pages their dashboard says they can open.
 *
 * Pure and deterministic: the same list and the same words always give the
 * same answer, so a wrong resolution is reproducible from the turn's trace.
 *
 * Scoring is a weighted word overlap, with each word weighted by how rare it
 * is across the list (inverse document frequency). Rarity is what makes
 * "voice settings" land on Voice rather than Settings: "voice" names one page,
 * "settings" names several, so "voice" carries the decision.
 */
import type { DashboardPage } from "@droplet/shared-types";

/** Words that say "take me somewhere" rather than where. */
const FILLER = new Set([
  "a", "an", "the", "my", "our", "your", "me", "us", "i", "it", "this", "that",
  "there", "to", "of", "for", "in", "on", "at", "and", "or", "with", "into",
  "up", "please", "can", "could", "do", "is", "are", "where", "how", "get",
  "go", "take", "bring", "open", "show", "navigate", "find", "link", "page",
  "screen", "section", "tab", "view",
]);

/**
 * Words that qualify a place rather than name one: "voice settings" is the
 * Voice page, not the Settings page. Dropped when anything else names the
 * place; kept when they are all there is ("open settings").
 */
const QUALIFIERS = new Set(["setting", "option", "preference", "config", "configuration"]);

const FIELD_WEIGHT = { label: 3, keyword: 2, href: 2, context: 1 } as const;

/** A partial match ("calibrat" in "calibration") counts for less than a whole one. */
const PREFIX_FACTOR = 0.6;
const PREFIX_MIN_LENGTH = 4;

/**
 * For an automatic navigation the best page must clearly beat the runner-up;
 * anything closer is reported as ambiguous so the model asks instead of
 * moving the person somewhere they did not mean.
 */
const CLEAR_WIN_RATIO = 1.5;

function normalizeWord(raw: string): string {
  const w = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Crude plural fold, applied identically to both sides.
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

function words(text: string): string[] {
  return text
    .split(/[\s/,.;:!?()"'`[\]]+/)
    .map(normalizeWord)
    .filter((w) => w.length > 0);
}

function queryWords(text: string): string[] {
  const all = words(text);
  const meaningful = all.filter((w) => !FILLER.has(w));
  const naming = meaningful.filter((w) => !QUALIFIERS.has(w));
  // "open the page" names nothing; fall back to the raw words rather than
  // matching everything with an empty query.
  const chosen = naming.length > 0 ? naming : meaningful.length > 0 ? meaningful : all;
  return [...new Set(chosen)];
}

interface Indexed {
  page: DashboardPage;
  fields: Array<{ weight: number; words: Set<string> }>;
}

function index(page: DashboardPage): Indexed {
  const hrefWords = page.href.split(/[/-]+/).map(normalizeWord).filter(Boolean);
  return {
    page,
    fields: [
      { weight: FIELD_WEIGHT.label, words: new Set(words(page.label)) },
      { weight: FIELD_WEIGHT.keyword, words: new Set((page.keywords ?? []).flatMap(words)) },
      { weight: FIELD_WEIGHT.href, words: new Set(hrefWords) },
      {
        weight: FIELD_WEIGHT.context,
        words: new Set(words(`${page.section ?? ""} ${page.description ?? ""}`)),
      },
    ],
  };
}

function wordWeight(word: string, entry: Indexed): number {
  let best = 0;
  for (const field of entry.fields) {
    if (field.words.has(word)) {
      best = Math.max(best, field.weight);
      continue;
    }
    if (word.length < PREFIX_MIN_LENGTH) continue;
    for (const candidate of field.words) {
      if (
        candidate.length >= PREFIX_MIN_LENGTH &&
        (candidate.startsWith(word) || word.startsWith(candidate))
      ) {
        best = Math.max(best, field.weight * PREFIX_FACTOR);
        break;
      }
    }
  }
  return best;
}

interface Scored {
  page: DashboardPage;
  score: number;
  order: number;
}

function score(pages: readonly DashboardPage[], query: string): Scored[] {
  const qWords = queryWords(query);
  if (qWords.length === 0) return [];
  const indexed = pages.map(index);
  const weights = qWords.map((w) => indexed.map((entry) => wordWeight(w, entry)));
  const scored = indexed.map((entry, i) => {
    let total = 0;
    qWords.forEach((_, q) => {
      const w = weights[q][i];
      if (w === 0) return;
      const df = weights[q].filter((x) => x > 0).length;
      total += w * Math.log(1 + pages.length / df);
    });
    return { page: entry.page, score: total, order: i };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.page.href.length - b.page.href.length ||
        a.order - b.order,
    );
}

/** The pages that match, best first. Empty when nothing does. */
export function findDashboardPages(
  pages: readonly DashboardPage[],
  query: string,
  limit: number,
): DashboardPage[] {
  return score(pages, query)
    .slice(0, limit)
    .map((s) => s.page);
}

export type PageResolution =
  | { kind: "match"; page: DashboardPage }
  | { kind: "ambiguous"; candidates: DashboardPage[] }
  | { kind: "none" };

function pathOf(reference: string): string | null {
  if (!reference.startsWith("/")) return null;
  const path = reference.split(/[?#]/, 1)[0];
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Resolve one reference to one page, for an automatic navigation.
 *
 * An exact path or an exact label wins outright. Anything else goes through
 * the word match, and only a clear winner is a match — a near tie is
 * `ambiguous`, because moving the person to the wrong page is worse than
 * asking. A path that is not on the list (a guessed `/settings/voice`) is
 * matched by its words, so it lands on the page it was reaching for.
 */
export function resolveDashboardPage(
  pages: readonly DashboardPage[],
  reference: string,
): PageResolution {
  const ref = reference.trim();
  if (ref.length === 0) return { kind: "none" };

  const path = pathOf(ref);
  if (path !== null) {
    const exact = pages.find((p) => p.href === path);
    if (exact) return { kind: "match", page: exact };
  }

  const label = ref.toLowerCase();
  const byLabel = pages.filter((p) => p.label.toLowerCase() === label);
  if (byLabel.length === 1) return { kind: "match", page: byLabel[0] };
  if (byLabel.length > 1) return { kind: "ambiguous", candidates: byLabel };

  const ranked = score(pages, ref);
  if (ranked.length === 0) return { kind: "none" };
  const [best, second] = ranked;
  if (!second || best.score >= second.score * CLEAR_WIN_RATIO) {
    return { kind: "match", page: best.page };
  }
  return {
    kind: "ambiguous",
    candidates: ranked
      .filter((s) => s.score * CLEAR_WIN_RATIO > best.score)
      .slice(0, 5)
      .map((s) => s.page),
  };
}
