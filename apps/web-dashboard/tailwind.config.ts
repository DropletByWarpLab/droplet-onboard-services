import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Brand ramp — indigo (canon). The `--color-accent` tokens + the design
        // system are indigo #6366f1 (500); the 2026-05-18 violet re-point never
        // matched canon and was reverted here (handoff 6, decision D-F: Droplet
        // product stays indigo). Primary is droplet-500 #6366f1; 400 #818cf8 is
        // the dark-mode accent; 600 #4f46e5 is hover.
        droplet: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
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
