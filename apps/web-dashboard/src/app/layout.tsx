import type { Metadata } from "next";
import { Inter, Instrument_Serif } from "next/font/google";
import { ThemeProvider } from "@/lib/theme";
import { AuthProvider } from "@/lib/auth";
import { AuthGate } from "@/components/AuthGate";
import { ToastProvider } from "@/components/Toast";
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
  themeColor: "#6366f1",
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
    <html lang="en" className={`${inter.variable} ${instrumentSerif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-[family-name:var(--font-inter)] antialiased">
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>
              <AuthGate>{children}</AuthGate>
            </ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
