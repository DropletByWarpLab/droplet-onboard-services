// Run-time date tokens for case text (turns, world, faults), expanded with the run's
// "today": the day the prompt's date line shows and get_current_datetime returns. A case
// never carries a build-day date, so the generated jsonl is the same every day.
// evaluate.py expands `expected` the same way (expand_str); selftest/dates.json pins both.
//
//   {{today+N}} {{today-N}} {{today}}   that day plus or minus N days
//   {{next:tue}}                        the next Tuesday strictly after today (mon..sun)
//   {{nth:2:tue:+1}}                    the 2nd Tuesday of the month 1 month on (n 1-5, day, month offset)
//   {{bizdays:+5}}                      5 business days on, Mon-Fri, no holidays (N may be negative)
//   {{weekday:BODY}}                    the weekday name of any of the above, e.g. {{weekday:today+3}}
// Each date is YYYY-MM-DD. An unknown token throws.

const DAY = 864e5;
const DOWS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
// Monday = 0 ... Sunday = 6, in UTC (every date here is a calendar day, so UTC is only a way to hold it).
const dow = (d: Date): number => (d.getUTCDay() + 6) % 7;
const plus = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY);

function dowIndex(abbr: string, token: string): number {
  const i = DOWS.indexOf(abbr);
  if (i < 0) throw new Error(`unknown weekday '${abbr}' in {{${token}}} (want ${DOWS.join(", ")})`);
  return i;
}

function dayOf(body: string, today: string): Date {
  const base = new Date(`${today}T00:00:00Z`);
  let m: RegExpExecArray | null;
  if ((m = /^today([+-]\d+)?$/.exec(body))) return plus(base, Number(m[1] ?? 0));
  if ((m = /^next:([a-z]{3})$/.exec(body))) {
    const want = dowIndex(m[1], body);
    let d = plus(base, 1);
    while (dow(d) !== want) d = plus(d, 1);
    return d;
  }
  if ((m = /^nth:([1-5]):([a-z]{3}):([+-]?\d+)$/.exec(body))) {
    const n = Number(m[1]);
    const want = dowIndex(m[2], body);
    const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + Number(m[3]), 1));
    const d = plus(first, ((want - dow(first) + 7) % 7) + (n - 1) * 7);
    if (d.getUTCMonth() !== first.getUTCMonth()) throw new Error(`no ${n}th ${m[2]} in that month: {{${body}}}`);
    return d;
  }
  if ((m = /^bizdays:([+-]?\d+)$/.exec(body))) {
    let n = Number(m[1]);
    const step = n < 0 ? -1 : 1;
    let d = base;
    while (n !== 0) {
      d = plus(d, step);
      if (dow(d) < 5) n -= step;
    }
    return d;
  }
  throw new Error(`unknown date token {{${body}}}`);
}

export function expandDates(text: string, today: string): string {
  if (!text.includes("{{")) return text;
  const out = text.replace(/\{\{([^{}]*)\}\}/g, (_, body: string) =>
    body.startsWith("weekday:") ? NAMES[dow(dayOf(body.slice(8), today))] : dayOf(body, today).toISOString().slice(0, 10));
  if (out.includes("{{")) throw new Error(`unknown placeholder in case text: ${out}`);
  return out;
}

// Every string nested anywhere, dict keys included.
export function expandDeep(v: unknown, today: string): unknown {
  if (typeof v === "string") return expandDates(v, today);
  if (Array.isArray(v)) return v.map((x) => expandDeep(x, today));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [expandDates(k, today), expandDeep(x, today)]));
  return v;
}
