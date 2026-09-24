// THIS workspace's draft (WARP-2899): connector-draft.json is valid and the
// files `npm run build` rendered from it are present and agree with it.
//
// Fails on the untouched template on purpose: an empty draft is not a
// connector. Fill connector-draft.json, run `npm run build`, then `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkRendered, validateDraft } from "../scripts/validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VOCAB = JSON.parse(readFileSync(join(ROOT, "vocabulary.json"), "utf8"));
const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : null);

test("connector-draft.json is a valid draft", () => {
  const problems = validateDraft(JSON.parse(read("connector-draft.json") ?? "null"), VOCAB);
  assert.deepEqual(problems, [], `fix connector-draft.json:\n- ${problems.join("\n- ")}`);
});

test("the rendered files are present and agree with connector-draft.json", () => {
  const draft = JSON.parse(read("connector-draft.json") ?? "null");
  if (validateDraft(draft, VOCAB).length) assert.fail("the draft is not valid yet; see the test above");
  const problems = checkRendered(draft, read);
  assert.deepEqual(problems, [], `run \`npm run build\`:\n- ${problems.join("\n- ")}`);
});
