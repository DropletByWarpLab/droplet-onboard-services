/**
 * WARP-2490 — the customer integration guides, bundled into the dashboard at
 * build time.
 *
 * ## Why this exists
 *
 * WARP-2342 made `setupGuideHref` type-required for an `available` cloud
 * provider, and the hub tile and connect wizard both render it. Nothing served
 * the guides: `/help` is one hand-written page and `docs/integrations/*.md`
 * were repo files, so every candidate href was a link to a 404.
 *
 * An external link (github.com, a docs site) is not an option. The appliance
 * must work with no internet path from the owner's browser to us, and the
 * product promise is that nothing about it depends on our infrastructure being
 * up. So the markdown is INLINED into the bundle — `?raw` imports, resolved by
 * vite under vitest and by the `asset/source` webpack rule under `next build`.
 * The route prerenders static: no runtime filesystem read, no fetch.
 *
 * ## Why every file, not just the five vendor guides
 *
 * The guides link to each other 27 times — `credential-handling.md` alone is
 * referenced 14 times — and serving a subset would mean deciding, per file,
 * which of those links is allowed to break in the browser. They are all
 * integration documentation and they already ship inside the image. The one
 * link class that stays unresolvable is the two `../ADR-041-…` references,
 * which point outside this directory; the renderer draws those as plain text
 * rather than as an anchor to nowhere.
 *
 * The import list is hand-written because a static import is the only kind a
 * bundler can inline. It is not TRUSTED to stay complete —
 * `integration-guides.test.ts` asserts it covers exactly
 * `docs/integrations/*.md`, so a guide added without a line here goes red.
 */

import addAProvider from "../../../../docs/integrations/ADD-A-PROVIDER.md?raw";
import brevo from "../../../../docs/integrations/brevo.md?raw";
import credentialHandling from "../../../../docs/integrations/credential-handling.md?raw";
import eaglesoft from "../../../../docs/integrations/eaglesoft.md?raw";
import exportDrop from "../../../../docs/integrations/export-drop.md?raw";
import hubspot from "../../../../docs/integrations/hubspot.md?raw";
import klaviyo from "../../../../docs/integrations/klaviyo.md?raw";
import mailchimp from "../../../../docs/integrations/mailchimp.md?raw";
import pipedrive from "../../../../docs/integrations/pipedrive.md?raw";
import readme from "../../../../docs/integrations/README.md?raw";
import setup from "../../../../docs/integrations/SETUP.md?raw";
import shopify from "../../../../docs/integrations/shopify.md?raw";
import stripe from "../../../../docs/integrations/stripe.md?raw";
import vendorSetupTemplate from "../../../../docs/integrations/vendor-setup-template.md?raw";
import xero from "../../../../docs/integrations/xero.md?raw";

/** The route these guides are served under. Declared once — the descriptor's
 *  `setupGuideHref`, the route folder and the link rewriter must agree, and a
 *  second spelling of this prefix is how they would stop agreeing. */
export const GUIDE_ROUTE_PREFIX = "/help/integrations";

/**
 * Guide text by SLUG, where a slug is the markdown filename lowercased with
 * `.md` dropped (`SETUP.md` → `setup`).
 *
 * Lowercased because a slug appears in a URL an owner may retype, and because
 * the provider ids it has to line up with are lowercase.
 */
export const INTEGRATION_GUIDES: Readonly<Record<string, string>> = {
  "add-a-provider": addAProvider,
  brevo,
  "credential-handling": credentialHandling,
  eaglesoft,
  "export-drop": exportDrop,
  hubspot,
  klaviyo,
  mailchimp,
  pipedrive,
  readme,
  setup,
  shopify,
  stripe,
  "vendor-setup-template": vendorSetupTemplate,
  xero,
};

/** Every slug the route serves, sorted — the source `generateStaticParams`
 *  reads, so the prerendered set and this map cannot diverge. */
export function integrationGuideSlugs(): string[] {
  return Object.keys(INTEGRATION_GUIDES).sort();
}

/** The guide's markdown, or undefined. Undefined means "no such guide" and is
 *  the only place that question is answered; the route turns it into a 404. */
export function integrationGuide(slug: string): string | undefined {
  return INTEGRATION_GUIDES[slug];
}

/** The href a descriptor should declare for a provider. */
export function integrationGuideHref(slug: string): string {
  return `${GUIDE_ROUTE_PREFIX}/${slug}`;
}

/**
 * The first `# Heading` of a guide, used as the page title.
 *
 * Falls back to the slug rather than to a generic word: a browser tab reading
 * "Guide" for every vendor is worse than one reading the slug.
 */
export function integrationGuideTitle(slug: string): string {
  const heading = /^#\s+(.+)$/m.exec(integrationGuide(slug) ?? "");
  return heading ? heading[1].trim() : slug;
}

/**
 * Rewrite a markdown link to something this dashboard can actually serve.
 *
 * Returns the in-app href for a relative `*.md` link whose target IS bundled,
 * preserving any `#anchor`; returns null for everything else — a link out of
 * this directory (`../ADR-041-…`), an absolute URL, or a guide nobody bundled.
 * The caller renders null as plain text. On an appliance with no internet path,
 * an anchor that 404s is worse than prose.
 */
export function internalGuideHref(href: string | undefined): string | null {
  if (!href) return null;
  // An anchor within the page stays as it is.
  if (href.startsWith("#")) return href;
  // Anything with a scheme, rooted, or climbing out of this directory is not
  // ours to serve.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.includes("../")) {
    return null;
  }
  const [path, ...rest] = href.split("#");
  if (!path.toLowerCase().endsWith(".md")) return null;
  const slug = path.slice(0, -".md".length).toLowerCase();
  if (!(slug in INTEGRATION_GUIDES)) return null;
  const anchor = rest.length > 0 ? `#${rest.join("#")}` : "";
  return `${integrationGuideHref(slug)}${anchor}`;
}

/**
 * GitHub's heading-slug algorithm, so a
 * `SETUP.md#3-track-b--a-cloud-service-you-already-pay-for…` link lands on the
 * right section.
 *
 * Hand-rolled rather than pulling in `rehype-slug`: it is six lines, and a new
 * runtime dependency for six lines is a supply-chain decision, not a
 * convenience one.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    // EACH whitespace character becomes one hyphen, not each RUN of them.
    // GitHub strips the punctuation first and hyphenates what is left, so
    // "Track B — a cloud" leaves two spaces and therefore "b--a". Collapsing
    // the run would produce "b-a" and every such anchor in the guides would
    // land at the top of the page instead of its section.
    .replace(/\s/g, "-");
}
