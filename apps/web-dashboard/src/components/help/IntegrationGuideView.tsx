"use client";

/**
 * WARP-2490 — renders one bundled integration guide.
 *
 * Uses the dashboard's EXISTING markdown stack — `react-markdown` +
 * `remark-gfm`, styled by the `.chat-markdown` rules in `globals.css`
 * (`ChatMessage.tsx:384-401` is the other caller). No new dependency: the
 * guides are GFM, which is exactly what that stack already renders, and a
 * second markdown pipeline in one app would be two sets of rendering bugs.
 *
 * Two behaviours the guides actually need, neither of which the default
 * renderer provides:
 *
 *  - **Links are rewritten**, because the guides cross-reference each other by
 *    filename (`credential-handling.md`) and a browser would resolve that
 *    against the route, not the docs folder. A target this build does not
 *    serve renders as PLAIN TEXT — on an appliance with no internet path, an
 *    anchor that 404s is worse than prose.
 *  - **Headings carry ids**, so `SETUP.md#3-track-b-…` lands on its section
 *    rather than at the top of the page.
 */

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpen } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { headingSlug, internalGuideHref } from "@/lib/integration-guides";
import type { ReactNode } from "react";

const REMARK_PLUGINS = [remarkGfm];

/** The visible text of a heading, for its id. `children` is already the parsed
 *  inline content, so this walks it rather than re-parsing the source. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function heading(Tag: "h1" | "h2" | "h3" | "h4") {
  function Heading({ children }: { children?: ReactNode }) {
    return <Tag id={headingSlug(textOf(children))}>{children}</Tag>;
  }
  Heading.displayName = `GuideHeading(${Tag})`;
  return Heading;
}

export function IntegrationGuideView({
  slug,
  title,
  markdown,
}: {
  slug: string;
  title: string;
  markdown: string;
}) {
  const components = useMemo(
    () => ({
      h1: heading("h1"),
      h2: heading("h2"),
      h3: heading("h3"),
      h4: heading("h4"),
      // A wide GFM table scrolls inside its own container rather than blowing
      // out the page width — the same treatment `ChatMessage` gives it.
      table: ({ children }: { children?: ReactNode }) => (
        <div className="overflow-x-auto">
          <table>{children}</table>
        </div>
      ),
      // A plain anchor, not `next/link`: these pages are prerendered static
      // documents, so there is no data fetch for a client transition to save,
      // and the prefetch would pull sibling guides nobody asked for.
      a: ({ href, children }: { href?: string; children?: ReactNode }) => {
        const internal = internalGuideHref(href);
        return internal ? <a href={internal}>{children}</a> : <span>{children}</span>;
      },
    }),
    [],
  );

  return (
    <ShellPage
      icon={<BookOpen size={15} />}
      label="Help"
      title={title}
      sub="Setup guide — stored on this box. Nothing here is fetched from us."
    >
      <article className="card chat-markdown" data-testid="integration-guide" data-slug={slug}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
          {markdown}
        </ReactMarkdown>
      </article>
    </ShellPage>
  );
}
