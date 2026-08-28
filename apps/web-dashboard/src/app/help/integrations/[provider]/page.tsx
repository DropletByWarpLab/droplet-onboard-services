/**
 * /help/integrations/<provider> — WARP-2490.
 *
 * The destination for the `setupGuideHref` WARP-2342 plumbed onto every
 * `available` cloud provider. A SERVER component on purpose: only a server
 * component can carry `generateStaticParams`, and that is what makes these
 * pages prerender into the static output next to `/integrations` rather than
 * being rendered on demand.
 *
 * `dynamicParams = false` is the 404: a slug outside `generateStaticParams`
 * gets the app's standard `not-found.tsx`, not a blank page and not a page
 * that renders an empty guide. The explicit `notFound()` below covers the same
 * case if that flag is ever relaxed — absence is never a silent anything.
 *
 * There is no filesystem read here. The markdown arrives as a bundled string
 * (see `lib/integration-guides.ts`), so the page works on a box whose browser
 * has no route to the internet — which is the whole reason the guide is not
 * simply an external link.
 */

import { notFound } from "next/navigation";
import { IntegrationGuideView } from "@/components/help/IntegrationGuideView";
import {
  integrationGuide,
  integrationGuideSlugs,
  integrationGuideTitle,
} from "@/lib/integration-guides";

/** Prerender one page per bundled guide. */
export function generateStaticParams(): { provider: string }[] {
  return integrationGuideSlugs().map((provider) => ({ provider }));
}

/** Anything not in the list above is a 404, not a dynamic render. */
export const dynamicParams = false;

export default async function IntegrationGuidePage(props: {
  params: Promise<{ provider: string }>;
}) {
  const { provider } = await props.params;
  const markdown = integrationGuide(provider);
  if (markdown === undefined) notFound();

  return (
    <IntegrationGuideView
      slug={provider}
      title={integrationGuideTitle(provider)}
      markdown={markdown}
    />
  );
}
