import Link from "next/link";

/**
 * App Router 404 page (WARP-576).
 *
 * Renders for any unmatched route. Styled to match the error boundary and the
 * rest of the dashboard, with a link back to the home dashboard.
 */
export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="dp-card p-8 max-w-md w-full text-center">
        <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
          404
        </p>
        <h1 className="type-title-3 text-label-primary font-semibold mt-2">
          Page not found
        </h1>
        <p className="type-footnote text-label-tertiary mt-2">
          We couldn&apos;t find the page you were looking for. It may have moved
          or no longer exists.
        </p>
        <div className="mt-6 flex items-center justify-center">
          <Link href="/" className="dp-btn-primary">
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
