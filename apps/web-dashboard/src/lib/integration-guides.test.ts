/**
 * WARP-2490 — the drift gate between the provider registry, the docs folder
 * and the route that serves it.
 *
 * Three things can silently diverge here, and each gets an assertion rather
 * than trust (the repo's standing convention — `check-schema-drift.sh`,
 * `check-agent-api-sync.mjs`, `build.mjs --check`):
 *
 *  1. a descriptor declares a `setupGuideHref` no page is prerendered for →
 *     the owner clicks the link the wizard shows them and gets a 404;
 *  2. a guide is added to `docs/integrations/` and not to the bundle → it is
 *     invisible to the box, and every cross-link to it degrades to plain text;
 *  3. `generateStaticParams` stops agreeing with the bundle → pages vanish
 *     from the static output with no test noticing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  providerDescriptors,
  registerProviderDescriptor,
  __resetRegisteredProvidersForTest,
  type ProviderDescriptor,
} from "@droplet/shared-types";
import {
  GUIDE_ROUTE_PREFIX,
  INTEGRATION_GUIDES,
  headingSlug,
  integrationGuide,
  integrationGuideHref,
  integrationGuideSlugs,
  integrationGuideTitle,
  internalGuideHref,
} from "./integration-guides";
import { generateStaticParams } from "@/app/help/integrations/[provider]/page";

/** Locate the repo's `docs/integrations` from wherever vitest was launched. */
function docsDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "docs/integrations");
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, "..");
  }
  throw new Error(`could not locate docs/integrations from ${process.cwd()}`);
}

/** Slugs the ROUTE will prerender — read through the page's own
 *  `generateStaticParams`, not through the map it happens to use. */
function prerenderedSlugs(): string[] {
  return generateStaticParams().map((p) => p.provider);
}

afterEach(() => {
  __resetRegisteredProvidersForTest();
});

describe("every guide in the repo is bundled into the box", () => {
  /**
   * Mutation: add a `docs/integrations/*.md` file without adding its import →
   * red. Delete an import → red. This is the only thing standing between "the
   * guide exists in git" and "the owner can read it on the appliance".
   */
  it("bundles exactly the markdown files in docs/integrations", () => {
    const onDisk = readdirSync(docsDir())
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => f.slice(0, -".md".length).toLowerCase())
      .sort();

    expect(Object.keys(INTEGRATION_GUIDES).sort()).toEqual(onDisk);
    expect(onDisk.length).toBeGreaterThanOrEqual(5);
  });

  /**
   * The five customer-facing cloud guides are the reason this route exists at
   * all (ADR-042 §2 / `check-setup-guides.sh`'s `CLOUD_PROVIDERS`). Named
   * explicitly so removing one from the bundle cannot hide behind the
   * directory listing above.
   */
  it("serves each of the five cloud vendor guides with real content", () => {
    for (const vendor of ["stripe", "hubspot", "mailchimp", "shopify", "xero"]) {
      const text = integrationGuide(vendor);
      expect(text, `${vendor} is not bundled`).toBeTruthy();
      expect((text ?? "").length, `${vendor} is empty`).toBeGreaterThan(1000);
      expect(prerenderedSlugs(), `${vendor} is not prerendered`).toContain(vendor);
    }
  });

  /**
   * Mutation: return a hand-written list from `generateStaticParams` instead
   * of `integrationGuideSlugs()` → red as soon as the two disagree.
   */
  it("prerenders exactly the bundled set", () => {
    expect(prerenderedSlugs().sort()).toEqual(integrationGuideSlugs());
  });
});

describe("a descriptor's setupGuideHref points at a page that exists", () => {
  /**
   * THE drift gate the ticket asks for. Vacuous against today's shipped
   * registry — no descriptor sets the field until WARP-2466 — so the fixture
   * below is what actually proves it works. Both halves stay: the loop is what
   * catches WARP-2466's descriptors the moment they land.
   */
  it("holds for every shipped descriptor", () => {
    for (const d of providerDescriptors()) {
      const href = d.catalog?.setupGuideHref;
      if (href === undefined) continue;
      expect(href.startsWith(`${GUIDE_ROUTE_PREFIX}/`), `${d.id}: ${href}`).toBe(true);
      const slug = href.slice(GUIDE_ROUTE_PREFIX.length + 1).split("#")[0];
      expect(prerenderedSlugs(), `${d.id} links to an unserved guide: ${href}`).toContain(slug);
    }
  });

  /**
   * The gate, made observable. A descriptor pointing at a provider with no
   * guide file is exactly the failure the ticket names, and this is the shape
   * WARP-2466 would hit if it registered a vendor before writing its guide.
   *
   * Mutation: make the check pass anything starting with the prefix (drop the
   * `prerenderedSlugs()` membership test) → red here.
   */
  it("catches a descriptor whose guide was never written", () => {
    const noGuide: ProviderDescriptor = {
      id: "fixture-unwritten",
      displayName: "Fixture Unwritten",
      category: "Payments",
      track: "cloud",
      credentialFields: [],
      egressHosts: [],
      datasets: [],
      catalog: {
        id: "fixture-unwritten",
        name: "Fixture Unwritten",
        category: "Payments",
        description: "Offered, with a guide nobody wrote.",
        availability: "available",
        setupGuideHref: `${GUIDE_ROUTE_PREFIX}/fixture-unwritten`,
        order: 99,
      },
    };
    registerProviderDescriptor(noGuide);

    const href = providerDescriptors().find((d) => d.id === "fixture-unwritten")?.catalog
      ?.setupGuideHref;
    const slug = (href ?? "").slice(GUIDE_ROUTE_PREFIX.length + 1);
    expect(prerenderedSlugs()).not.toContain(slug);
  });

  /** A descriptor that DOES have a guide passes the same check — otherwise the
   *  test above would also pass with the gate wired to always fail. */
  it("accepts a descriptor whose guide is bundled", () => {
    const ok: ProviderDescriptor = {
      id: "fixture-written",
      displayName: "Fixture Written",
      category: "Payments",
      track: "cloud",
      credentialFields: [],
      egressHosts: [],
      datasets: [],
      catalog: {
        id: "fixture-written",
        name: "Fixture Written",
        category: "Payments",
        description: "Offered, with a real guide.",
        availability: "available",
        setupGuideHref: integrationGuideHref("stripe"),
        order: 99,
      },
    };
    registerProviderDescriptor(ok);

    const href = providerDescriptors().find((d) => d.id === "fixture-written")?.catalog
      ?.setupGuideHref;
    expect(href).toBe("/help/integrations/stripe");
    expect(prerenderedSlugs()).toContain("stripe");
  });
});

describe("links between guides resolve to routes, or to nothing at all", () => {
  /**
   * The four link shapes the shipped corpus actually contains — 14
   * `credential-handling.md`, 6 `SETUP.md#anchor`, 6 `README.md`, 2
   * `../ADR-041-…`. Counted with grep over `docs/integrations/*.md`.
   *
   * Mutation: return the raw href unchanged → red, because the browser would
   * then resolve `credential-handling.md` against the route.
   */
  it("rewrites a sibling guide link to its route", () => {
    expect(internalGuideHref("credential-handling.md")).toBe(
      "/help/integrations/credential-handling",
    );
    expect(internalGuideHref("README.md")).toBe("/help/integrations/readme");
  });

  /** Mutation: drop the anchor → red, and every `SETUP.md#…` link in the five
   *  vendor guides lands at the top of a 20k-word page instead of its section. */
  it("keeps the anchor", () => {
    expect(internalGuideHref("SETUP.md#3-track-b--a-cloud-service")).toBe(
      "/help/integrations/setup#3-track-b--a-cloud-service",
    );
    expect(internalGuideHref("#plan-prerequisite")).toBe("#plan-prerequisite");
  });

  /**
   * Anything this build cannot serve returns null, and the renderer draws null
   * as plain text. On an appliance with no internet path, an anchor that 404s
   * is worse than prose.
   *
   * Mutation: return a best-effort href for an unknown target → red.
   */
  it("refuses a target it cannot serve", () => {
    expect(internalGuideHref("../ADR-041-cloud-connector-class.md")).toBeNull();
    expect(internalGuideHref("nobody-wrote-this.md")).toBeNull();
    expect(internalGuideHref("https://example.invalid/guide.md")).toBeNull();
    expect(internalGuideHref("/help")).toBeNull();
    expect(internalGuideHref(undefined)).toBeNull();
  });

  /**
   * The whole corpus, not a sample: every relative markdown link in every
   * bundled guide either resolves to a prerendered page or is one of the two
   * known out-of-directory references.
   *
   * Mutation: remove a guide from the bundle → red, because the links pointing
   * at it stop resolving.
   */
  it("resolves every intra-directory link in every bundled guide", () => {
    const unresolved: string[] = [];
    for (const [slug, text] of Object.entries(INTEGRATION_GUIDES)) {
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1];
        if (href.startsWith("#") || href.includes("../")) continue;
        if (!href.split("#")[0].toLowerCase().endsWith(".md")) continue;
        if (internalGuideHref(href) === null) unresolved.push(`${slug} → ${href}`);
      }
    }
    expect(unresolved).toEqual([]);
  });
});

describe("page furniture", () => {
  it("titles a guide from its first heading, never a generic word", () => {
    expect(integrationGuideTitle("stripe").toLowerCase()).toContain("stripe");
    expect(integrationGuideTitle("nope")).toBe("nope");
  });

  /**
   * GitHub's algorithm, because that is what the `#anchor` fragments in the
   * shipped guides were written against — verified against the REAL heading and
   * the REAL link, not a hand-written pair that could agree with a wrong
   * implementation.
   *
   * Mutation: collapse whitespace RUNS (`/\\s+/`) instead of each character →
   * red, because the em dash in "Track B — a cloud service" leaves two spaces
   * and the anchor is `b--a`, not `b-a`.
   */
  it("slugs headings the way the links expect", () => {
    expect(headingSlug("3. Track B — a cloud service")).toBe("3-track-b--a-cloud-service");
    expect(headingSlug("Plan prerequisite")).toBe("plan-prerequisite");
  });

  /**
   * Every cross-guide `#anchor` in the corpus lands on a heading that actually
   * exists in the target guide. This is what makes the six `SETUP.md#…` links
   * in the vendor guides worth having — an anchor that misses drops the reader
   * at the top of a 20k-word page with no sign anything went wrong.
   *
   * Mutation: any change to `headingSlug` that stops matching GitHub → red.
   */
  it("every cross-guide anchor matches a heading in the target guide", () => {
    const missed: string[] = [];
    for (const [from, text] of Object.entries(INTEGRATION_GUIDES)) {
      for (const m of text.matchAll(/\]\(([^)\s]+#[^)\s]+)\)/g)) {
        const resolved = internalGuideHref(m[1]);
        if (!resolved || resolved.startsWith("#")) continue;
        const [route, anchor] = resolved.split("#");
        const target = integrationGuide(route.slice(GUIDE_ROUTE_PREFIX.length + 1)) ?? "";
        const headings = [...target.matchAll(/^#{1,6}\s+(.+)$/gm)].map((h) =>
          headingSlug(h[1]),
        );
        if (!headings.includes(anchor)) missed.push(`${from} → ${m[1]}`);
      }
    }
    // One PRE-EXISTING broken anchor, listed rather than skipped so a SECOND
    // one still goes red. `vendor-setup-template.md:81` cites `SETUP.md` §8;
    // SETUP.md has seven sections. `check-setup-guides.sh` resolves link
    // PATHS, not fragments, so nothing has ever caught it. Not fixed here —
    // it is a docs defect outside this ticket, and silently repairing prose in
    // a routing change is how a real error hides.
    expect(missed).toEqual([
      "vendor-setup-template → SETUP.md#8-cloud--saas-connectors--pasting-a-credential-warp-2275",
    ]);
  });
});
