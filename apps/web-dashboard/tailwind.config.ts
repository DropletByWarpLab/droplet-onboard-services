import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      // D-A (handoff 6): `font-mono` resolves to the wired --font-mono
      // (JetBrains Mono, set in app/layout.tsx) with a safe system fallback.
      fontFamily: {
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        // Brand ramp — violet (re-pointed from indigo on 2026-05-18).
        // Anchor accent is droplet-700 #6d28d9; tinted backgrounds use
        // droplet-50/100/200, hover states use droplet-800, ink uses 900.
        droplet: {
          50: "#f5f3ff",
          100: "#ede9fe",
          200: "#ddd6fe",
          300: "#c4b5fd",
          400: "#a78bfa",
          500: "#8b5cf6",
          600: "#7c3aed",
          700: "#6d28d9",
          800: "#5b21b6",
          900: "#4c1d95",
        },
        // Semantic surface colors (CSS custom properties)
        surface: {
          primary: "var(--color-surface-primary)",
          secondary: "var(--color-surface-secondary)",
          tertiary: "var(--color-surface-tertiary)",
          elevated: "var(--color-surface-elevated)",
          raised: "var(--color-surface-raised)",
        },
        label: {
          primary: "var(--color-label-primary)",
          secondary: "var(--color-label-secondary)",
          tertiary: "var(--color-label-tertiary)",
          quaternary: "var(--color-label-quaternary)",
        },
        separator: "var(--color-separator)",
        accent: {
          DEFAULT: "var(--color-accent)",
          hover: "var(--color-accent-hover)",
          subtle: "var(--color-accent-subtle)",
          foreground: "var(--color-on-accent)",
        },
        system: {
          red: "var(--color-system-red)",
          orange: "var(--color-system-orange)",
          yellow: "var(--color-system-yellow)",
          green: "var(--color-system-green)",
          blue: "var(--color-system-blue)",
        },
        // Role colors — used by Business workspace role pills + matrix.
        // Home workspace does not render these (everyone is owner-level).
        role: {
          owner:   "var(--role-owner)",
          admin:   "var(--role-admin)",
          manager: "var(--role-manager)",
          member:  "var(--role-member)",
          viewer:  "var(--role-viewer)",
          guest:   "var(--role-guest)",
        },
      },
      borderRadius: {
        sm: "8px",
        DEFAULT: "12px",
        lg: "16px",
        xl: "20px",
      },
      boxShadow: {
        sm: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)",
        DEFAULT:
          "0 2px 8px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.06)",
        lg: "0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)",
        xl: "0 16px 48px rgba(0,0,0,0.16), 0 4px 16px rgba(0,0,0,0.08)",
      },
      transitionTimingFunction: {
        smooth: "cubic-bezier(0.25, 0.1, 0.25, 1.0)",
      },
      transitionDuration: {
        DEFAULT: "250ms",
      },
    },
  },
  plugins: [],
};
export default config;
