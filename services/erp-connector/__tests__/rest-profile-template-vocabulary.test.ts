/**
 * WARP-2899 — the `rest-profile` workshop template carries a SNAPSHOT of the
 * canonical vocabulary (extensions/templates/rest-profile/vocabulary.json), so
 * a connector draft can be checked inside the sandbox, which has no network
 * and cannot import this package. A snapshot drifts; this pins it.
 *
 * A dataset or column added here without the snapshot following would let a
 * draft map a column the connector rejects at PR time — or refuse one it
 * accepts. Regenerate the file from DATASETS / CANONICAL_COLUMNS /
 * REQUIRED_CANONICAL when this goes red.
 *
 * MUTATION: add a column to CANONICAL_COLUMNS (or a dataset to DATASETS)
 * without updating vocabulary.json → red.
 */
import { describe, it, expect } from "vitest";
import { CANONICAL_COLUMNS, DATASETS, REQUIRED_CANONICAL } from "../src/export-drop/profiles.js";
import { readRepoFile } from "./helpers/test-paths.js";

describe("the rest-profile template's vocabulary snapshot", () => {
  it("equals the connector's live vocabulary, in order", () => {
    const snapshot = JSON.parse(readRepoFile("extensions", "templates", "rest-profile", "vocabulary.json")) as unknown;
    expect(snapshot).toEqual({
      DATASET_NAMES: [...DATASETS],
      CANONICAL_COLUMNS,
      REQUIRED_CANONICAL,
    });
  });
});
