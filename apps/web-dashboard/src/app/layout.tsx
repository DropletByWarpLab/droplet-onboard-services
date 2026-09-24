import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/lib/theme";
import { NavLayoutProvider } from "@/lib/nav-layout";
import { AuthProvider } from "@/lib/auth";
import { WorkspaceProvider } from "@/lib/workspace";
import { ActiveDepartmentProvider } from "@/lib/departments/active-department";
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

// WARP-2956: same no-flash trick for the desktop sidebar width — apply the
// persisted collapse/width to --sidebar-w before hydration so the content
// column doesn't jump from 260px on first paint. Mirrors useSidebarLayout's
// clamp (200–360, rail 64); storage errors fall through to the CSS default.
const sidebarScript = `
(function(){
  try{
    var c=localStorage.getItem('droplet.sidebar.collapsed')==='1';
    var w=Math.min(360,Math.max(200,Math.round(Number(localStorage.getItem('droplet.sidebar.width')))||260));
    document.documentElement.style.setProperty('--sidebar-w',(c?64:w)+'px');
  }catch(e){}
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
        <script dangerouslySetInnerHTML={{ __html: sidebarScript }} />
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
          {/* WARP-2971 — sidebar vs Workspace-tabs shell; a display preference
              beside the theme, read by AuthGate. */}
          <NavLayoutProvider>
            <AuthProvider>
              <WorkspaceProvider>
                {/* WARP-2976 (ADR-059) — which department the shell is
                    arranged around. Inside AuthProvider: the choices depend
                    on who is signed in. A display preference like the nav
                    layout; it narrows the nav and never grants. */}
                <ActiveDepartmentProvider>
                  <ToastProvider>
                    <NotificationToaster />
                    <AuthGate>{children}</AuthGate>
                  </ToastProvider>
                </ActiveDepartmentProvider>
              </WorkspaceProvider>
            </AuthProvider>
          </NavLayoutProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
