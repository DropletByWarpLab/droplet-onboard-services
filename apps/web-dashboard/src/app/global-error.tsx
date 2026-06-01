"use client";

import React, { useEffect } from "react";

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
 *
 * Because this surface replaces the root layout (the sole importer of
 * `globals.css`), the Tailwind utilities below are NOT guaranteed to be styled
 * here. We therefore carry a minimal set of inline styles so the last-resort
 * screen is legible even if the stylesheet never loads; the Tailwind classes
 * still apply (and win) whenever the CSS is present.
 */
const overlayStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1.5rem",
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  background: "#0b0b0f",
  color: "#f5f5f7",
};

const cardStyle: React.CSSProperties = {
  maxWidth: "28rem",
  width: "100%",
  textAlign: "center",
  padding: "2rem",
  borderRadius: "0.75rem",
  background: "#17171c",
  border: "1px solid rgba(255,255,255,0.08)",
};

const buttonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0.5rem 1rem",
  borderRadius: "0.5rem",
  border: "none",
  background: "#2563eb",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};

const linkStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.8125rem",
  textDecoration: "none",
};
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
      <body className="antialiased" style={overlayStyle}>
        <div
          className="min-h-screen flex items-center justify-center p-6"
          style={{ width: "100%" }}
        >
          <div className="dp-card p-8 max-w-md w-full text-center" style={cardStyle}>
            <h1
              className="type-title-3 text-label-primary font-semibold"
              style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}
            >
              Something went wrong
            </h1>
            <p
              className="type-footnote text-label-tertiary mt-2"
              style={{ marginTop: "0.5rem", color: "#9ca3af", fontSize: "0.8125rem" }}
            >
              The dashboard ran into a problem it could not recover from. Try
              again, or reload the page.
            </p>
            <div
              className="mt-6 flex items-center justify-center gap-3"
              style={{
                marginTop: "1.5rem",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.75rem",
              }}
            >
              <button
                type="button"
                onClick={() => reset()}
                className="dp-btn-primary"
                style={buttonStyle}
              >
                Try again
              </button>
              <a
                href="/"
                className="type-footnote text-accent hover:underline"
                style={linkStyle}
              >
                Go home
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
