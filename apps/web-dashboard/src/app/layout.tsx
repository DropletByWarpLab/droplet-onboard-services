import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/lib/theme";
import { AuthProvider } from "@/lib/auth";
import { WorkspaceProvider } from "@/lib/workspace";
import { AuthGate } from "@/components/AuthGate";
import { ToastProvider } from "@/components/Toast";
import { NotificationToaster } from "@/components/NotificationToaster";
import { THEME_COLOR } from "@/lib/brand";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-display",
});

// Space Grotesk — the flat, geometric "tech" sans used for the Home chat hero
// headline (the bento home's signature display line). Scoped to that one line
// via `var(--font-space-grotesk)` in the home stylesheet.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-space-grotesk",
});

// JetBrains Mono — the design-system mono family (canon: IPs, hostnames,
// schedules, metrics, code, all-caps eyebrows). The dashboard references
// var(--font-mono) + `font-mono` widely, but the variable was never defined at
// the root, so mono text fell back to the browser default. (handoff 6, D-A.)
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Droplet Dashboard",
  description: "Manage your Droplet edge AI appliance",
  manifest: "/manifest.json",
  icons: [
    { url: "/favicon.ico", sizes: "any" },
    { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
    { url: "/apple-touch-icon.png", rel: "apple-touch-icon", sizes: "180x180" },
  ],
  openGraph: {
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
};

// DASH-09: driven from the brand accent token (see lib/brand.ts) so this
// PWA chrome color can't silently drift from the design system's accent.
//
// Must live on the `viewport` export, not `metadata` — Next 14 dropped
// themeColor from `metadata` and only warns at build time, so the tag was
// silently absent from every response and mobile browsers tinted their
// chrome with their own default. `width=device-width, initial-scale=1`
// restates Next's default so declaring this export can't drop it.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: THEME_COLOR,
};

// Inline script to prevent flash of wrong theme (FOUC)
const themeScript = `
(function(){
  var t=localStorage.getItem('droplet-theme');
  var dark=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme:dark)').matches);
  if(dark)document.documentElement.classList.add('dark');
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${instrumentSerif.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-[family-name:var(--font-inter)] antialiased">
        {/* Skip link — first focusable element so keyboard users can bypass
            the sidebar nav and jump straight to page content. Visually hidden
            until focused. (WARP-298) */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 dp-btn-primary"
        >
          Skip to content
        </a>
        <ThemeProvider>
          <AuthProvider>
            <WorkspaceProvider>
              <ToastProvider>
                <NotificationToaster />
                <AuthGate>{children}</AuthGate>
              </ToastProvider>
            </WorkspaceProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
