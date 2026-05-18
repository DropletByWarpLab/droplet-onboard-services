import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ThemeProvider } from "@/lib/theme";
import { AuthProvider } from "@/lib/auth";
import { WorkspaceProvider } from "@/lib/workspace";
import { AccentProvider } from "@/lib/accent";
import { AuthGate } from "@/components/AuthGate";
import { ToastProvider } from "@/components/Toast";
import { NotificationToaster } from "@/components/NotificationToaster";
import "./globals.css";

// Single font family across the whole app — Inter. Stefan 2026-05-18:
// "I don't want some features to have a random font there, it throws
// the whole balance off." Instrument Serif (the previous display face
// used by the AI hero on the Home page) was the visible offender;
// removed here, and `.type-display` in globals.css was rebased on
// Inter so existing call sites just re-render as Inter Bold at the
// same sizes. JetBrains Mono is only used for the chat-markdown
// code-block component, which is correct — no need for `font-mono`
// elsewhere; tabular-nums covers number alignment.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
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
  themeColor: "#6d28d9",
};

// Inline script to prevent flash of wrong theme (FOUC)
const themeScript = `
(function(){
  var t=localStorage.getItem('droplet-theme');
  var dark=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme:dark)').matches);
  if(dark)document.documentElement.classList.add('dark');
})();
`;

// Inline script to prevent flash of wrong accent (FOUC). Pulls the
// accent ID from localStorage and writes the CSS variables onto the
// document element BEFORE React mounts — that way the first paint of
// the page already has the user's chosen accent. Mirrors the
// themeScript pattern; AccentProvider takes over once React hydrates.
const accentScript = `
(function(){
  var presets={
    violet:{a:"#6d28d9",h:"#5b21b6",s:"rgba(109,40,217,0.10)",g:"0 30px 80px -40px rgba(109,40,217,0.35)"},
    purple:{a:"#bc13fe",h:"#9a0fcc",s:"rgba(188,19,254,0.10)",g:"0 30px 80px -40px rgba(188,19,254,0.35)"},
    indigo:{a:"#6366f1",h:"#4f46e5",s:"rgba(99,102,241,0.10)",g:"0 30px 80px -40px rgba(99,102,241,0.35)"},
    blue:{a:"#2563eb",h:"#1d4ed8",s:"rgba(37,99,235,0.10)",g:"0 30px 80px -40px rgba(37,99,235,0.35)"},
    cyan:{a:"#0891b2",h:"#0e7490",s:"rgba(8,145,178,0.10)",g:"0 30px 80px -40px rgba(8,145,178,0.35)"},
    emerald:{a:"#10b981",h:"#059669",s:"rgba(16,185,129,0.10)",g:"0 30px 80px -40px rgba(16,185,129,0.35)"},
    amber:{a:"#d97706",h:"#b45309",s:"rgba(217,119,6,0.10)",g:"0 30px 80px -40px rgba(217,119,6,0.35)"},
    rose:{a:"#e11d48",h:"#be123c",s:"rgba(225,29,72,0.10)",g:"0 30px 80px -40px rgba(225,29,72,0.35)"}
  };
  var id=localStorage.getItem('droplet-accent')||'violet';
  var p=presets[id]||presets.violet;
  var d=document.documentElement.style;
  d.setProperty('--color-accent',p.a);
  d.setProperty('--color-accent-hover',p.h);
  d.setProperty('--color-accent-subtle',p.s);
  d.setProperty('--shadow-hero',p.g);
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script dangerouslySetInnerHTML={{ __html: accentScript }} />
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
          <AccentProvider>
            <AuthProvider>
              <WorkspaceProvider>
                <ToastProvider>
                  <NotificationToaster />
                  <AuthGate>{children}</AuthGate>
                </ToastProvider>
              </WorkspaceProvider>
            </AuthProvider>
          </AccentProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
