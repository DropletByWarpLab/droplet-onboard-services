"use client";

import { useEffect } from "react";

/**
 * App Router segment error boundary (WARP-576).
 *
 * Catches render throws anywhere in the page tree below the root layout and
 * renders a branded recovery surface instead of white-screening the app.
 * `reset()` re-attempts the failed render. The known concrete trigger this
 * backstops is the home page's system-health lookup (page.tsx), but this is
 * the generic safety net for the whole class of uncaught render throws.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Keep the throw observable in the console / error reporting.
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="dp-card p-8 max-w-md w-full text-center">
        <h1 className="type-title-3 text-label-primary font-semibold">
          Something went wrong
        </h1>
        <p className="type-footnote text-label-tertiary mt-2">
          The dashboard hit an unexpected error. You can try again, or head back
          to the home screen.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="dp-btn-primary"
          >
            Try again
          </button>
          <a href="/" className="type-footnote text-accent hover:underline">
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}
