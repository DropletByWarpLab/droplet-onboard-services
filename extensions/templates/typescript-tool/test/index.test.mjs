import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../dist/index.js";

test("counts words and characters", () => {
  assert.deepEqual(run({ text: "two words" }), { words: 2, characters: 9 });
});

test("empty text is zero words", () => {
  assert.deepEqual(run({ text: "   " }), { words: 0, characters: 3 });
});
