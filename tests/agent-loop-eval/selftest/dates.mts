// The TS half of the date-token selftest: dates.mts must give every result in dates.json
// (null = the token must throw). selftest.sh checks evaluate.py against the same table.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expandDates, expandDeep } from "../dates.mts";

const table: [string, string, string | null][] = JSON.parse(readFileSync(resolve(import.meta.dirname, "dates.json"), "utf8"));
let bad = 0;
for (const [today, text, want] of table) {
  let got: string | null;
  try {
    got = expandDates(text, today);
  } catch {
    got = null;
  }
  if (got !== want) {
    console.error(`XX ${today} ${text}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    bad++;
  }
}
// Every nested string is expanded, dict keys included; other values are left alone.
const deep = JSON.stringify(expandDeep({ "{{today+1}}": ["{{today+2}}", 5, null, { x: "{{weekday:today+3}}" }] }, "2026-10-03"));
const wantDeep = JSON.stringify({ "2026-10-04": ["2026-10-05", 5, null, { x: "Tuesday" }] });
if (deep !== wantDeep) {
  console.error(`XX expandDeep: want ${wantDeep}, got ${deep}`);
  bad++;
}
console.log(`dates.mts: ${table.length + 1 - bad}/${table.length + 1} ok`);
process.exit(bad ? 1 : 0);
