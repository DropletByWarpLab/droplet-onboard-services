import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Brand colors
        droplet: {
          50: "#f0fdfa",
          100: "#ccfbf1",
          200: "#99f6e4",
          300: "#5eead4",
          400: "#2dd4bf",
          500: "#14b8a6",
          600: "#0d9488",
          700: "#0f766e",
          800: "#115e59",
          900: "#134e4a",
        },
        // Semantic surface colors (CSS custom properties)
        surface: {
          primary: "var(--color-surface-primary)",
          secondary: "var(--color-surface-secondary)",
          tertiary: "var(--color-surface-tertiary)",
          elevated: "var(--color-surface-elevated)",
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
        },
        system: {
          red: "var(--color-system-red)",
          orange: "var(--color-system-orange)",
          green: "var(--color-system-green)",
          blue: "var(--color-system-blue)",
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
