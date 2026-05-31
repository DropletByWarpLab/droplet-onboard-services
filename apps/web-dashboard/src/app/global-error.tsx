"use client";

import { useEffect } from "react";

/**
 * App Router *global* error boundary (WARP-576).
 *
 * This is the only boundary that catches a throw in the root layout itself,
 * so it replaces `layout.tsx` entirely and MUST render its own
 * `<html>`/`<body>` — it cannot rely on the layout's providers, fonts, or
 * theme. It is a last-resort surface: keep it self-contained and dependency-free.
 *
 * NOTE: `global-error.tsx` is only exercised in production builds — Next's dev
 * error overlay masks it. Verify with `next build` / `next start`, not `next dev`.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="antialiased">
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="dp-card p-8 max-w-md w-full text-center">
            <h1 className="type-title-3 text-label-primary font-semibold">
              Something went wrong
            </h1>
            <p className="type-footnote text-label-tertiary mt-2">
              The dashboard ran into a problem it could not recover from. Try
              again, or reload the page.
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
      </body>
    </html>
  );
}
