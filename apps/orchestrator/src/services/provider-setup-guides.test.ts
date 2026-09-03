/**
 * WARP-2650 — the drift gate between `scripts/check-setup-guides.sh`'s
 * `CLOUD_PROVIDERS` and the provider registry.
 *
 * ## The hole this closes
 *
 * `check-setup-guides.sh` proves a great deal about a guide — that it exists,
 * carries its six sections, keeps its fact pins, resolves its links and is
 * bundled into a route the box can serve. What it could not prove is that the
 * provider the guide is FOR is a provider this appliance knows how to connect.
 *
 * That is not hypothetical. #1956 added `docs/integrations/atlassian.md` and put
 * `atlassian` into `CLOUD_PROVIDERS` (`scripts/check-setup-guides.sh:91`); every
 * check above passed; and there was no `atlassian` descriptor, so
 * `requireDescriptor()` 404'd the only route that can write the credential and
 * the connection row #1964's third gate requires could not be created at all.
 * A customer could read a complete, correct, link-checked click-path for an
 * integration the box had no way to accept. #1964's Gap 2 named it: *"a one-line
 * assertion in `provider-registry.test.ts` would close it."*
 *
 * ## Why the check is not a plain set equality
 *
 * The two lists are not the same set, and forcing them to be would be wrong in
 * both directions:
 *
 *  • A `coming-soon` cloud card (`quickbooks-online`, `dentrix-ascend`) declares
 *    NO `setupGuideHref` on purpose — the hub renders it disabled, so there is
 *    no moment of use to link from and requiring a guide would mean writing one
 *    for a connector nobody can reach. Those descriptors are correctly absent
 *    from `CLOUD_PROVIDERS`.
 *  • `shopify` and `xero` guides are on this branch with no descriptor, because
 *    the guides were written from vendor research ahead of the connectors
 *    (WARP-2296 / #1945 and WARP-2383). That is the SAME defect class as the
 *    Atlassian one — a readable guide for an unconnectable integration — but it
 *    is a state somebody chose, and the fix is another PR's, not a test's.
 *
 * So the invariant is directional plus one EXPLICIT, named exception list.
 * {@link GUIDE_AHEAD_OF_DESCRIPTOR} is the list, it carries the ticket that
 * closes each entry, and it is the whole escape hatch: an id in
 * `CLOUD_PROVIDERS` with neither a descriptor nor an entry here is red. An
 * unbacked guide is therefore a declared state rather than an inferred one,
 * which is the same rule the repo applies to persisted status.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  providerDescriptor,
  providerDescriptors,
  providersWithSetupGuide,
  setupGuideHrefFor,
} from "@droplet/shared-types";

/** Walk up from the CWD to the repo root. `process.cwd()` rather than
 *  `import.meta.url`: this workspace compiles to CommonJS and `import.meta` is
 *  a TS1470 there — the trap `add-llm-tool-skill.test.ts` hit and
 *  `adr-043-boundary.test.ts` documents. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    try {
      statSync(join(dir, "docker", "docker-compose.yml"));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error("repo root not found from " + process.cwd());
}

const SCRIPT = join(repoRoot(), "scripts", "check-setup-guides.sh");

/**
 * Providers whose customer guide is on the tree ahead of their descriptor.
 *
 * Each entry is a KNOWN, ticketed hole — a guide a customer can read for an
 * integration this box cannot yet accept — not an approval of the pattern.
 * Removing an entry when its descriptor lands is the point; adding one is a
 * reviewable decision, which is exactly what `atlassian` never got.
 */
const GUIDE_AHEAD_OF_DESCRIPTOR: Readonly<Record<string, string>> = Object.freeze({
  shopify: "WARP-2296 — connector + descriptor in PR #1945",
  xero: "WARP-2383 — connector + descriptor in flight",
});

/** `CLOUD_PROVIDERS="a b c"` out of the shell script, read as TEXT. */
function cloudProvidersFromScript(): string[] {
  const src = readFileSync(SCRIPT, "utf8");
  const match = /^CLOUD_PROVIDERS="([^"]*)"$/m.exec(src);
  expect(match, "CLOUD_PROVIDERS assignment not found in check-setup-guides.sh").not.toBeNull();
  return match![1].split(/\s+/).filter(Boolean);
}

describe("check-setup-guides.sh's CLOUD_PROVIDERS agrees with the provider registry", () => {
  it("every provider that DECLARES a setup guide is a provider the script checks", () => {
    // The direction that catches "a descriptor points at a guide nothing
    // verifies": the href would 404 on the box and no gate would notice.
    // Mutation: drop `atlassian` from CLOUD_PROVIDERS → red.
    const script = cloudProvidersFromScript();
    for (const id of providersWithSetupGuide()) {
      expect(script, `${id} declares a setup guide the script does not check`).toContain(id);
    }
  });

  it("every provider the script checks is one this box can actually connect", () => {
    // The direction that catches the Atlassian defect. Mutation: delete the
    // `atlassian` descriptor from provider-registry.ts → red here, because
    // `atlassian` is in CLOUD_PROVIDERS and is deliberately NOT in the
    // ahead-of-descriptor list.
    for (const id of cloudProvidersFromScript()) {
      if (providerDescriptor(id)) continue;
      expect(
        GUIDE_AHEAD_OF_DESCRIPTOR[id],
        `${id} has a customer setup guide and no descriptor, so nothing can create ` +
          "its connection. Add the descriptor, or record it in " +
          "GUIDE_AHEAD_OF_DESCRIPTOR with the ticket that will.",
      ).toBeTruthy();
    }
  });

  it("keeps the exception list honest — no entry that already has a descriptor", () => {
    // Without this, an entry left behind after its descriptor landed would
    // silently re-open the hatch for the next id somebody typed into it.
    for (const id of Object.keys(GUIDE_AHEAD_OF_DESCRIPTOR)) {
      expect(providerDescriptor(id), `${id} has a descriptor now — drop it from the list`)
        .toBeUndefined();
    }
    expect(GUIDE_AHEAD_OF_DESCRIPTOR).not.toHaveProperty("atlassian");
  });

  it("a declared guide href follows the /help/integrations/<id> convention", () => {
    // The route serves `docs/integrations/<id>.md` from the id in the path, so
    // a href that does not match its own descriptor id renders another
    // vendor's guide — which the script cannot see, because it only checks
    // that the FILE exists.
    for (const d of providerDescriptors()) {
      const href = setupGuideHrefFor(d);
      if (href === undefined) continue;
      expect(href, `${d.id} setup guide href`).toBe(`/help/integrations/${d.id}`);
    }
  });
});
