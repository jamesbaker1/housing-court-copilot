import type { Config } from "tailwindcss";

// Calm, trustworthy theme. Cool slate/teal base, warm amber reserved for
// "verify this" affordances, red reserved for the court-date / countdown
// backstop. Mobile-first.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Calm primary — trustworthy, not flashy.
        trust: {
          50: "#f0f9fa",
          100: "#d9eef0",
          200: "#b3dde1",
          300: "#82c4cb",
          400: "#4ba3ad",
          500: "#2f8891",
          600: "#256d77",
          700: "#205860",
          800: "#1d4850",
          900: "#1b3c44",
          950: "#0c2429",
        },
        // "Verify this / not legal advice" — warm, attention without alarm.
        verify: {
          50: "#fdf8ed",
          100: "#f9ecca",
          200: "#f2d690",
          300: "#eaba55",
          400: "#e4a02f",
          500: "#d68318",
          600: "#bd6311",
          700: "#9d4612",
          800: "#803816",
          900: "#6a2f15",
        },
        // Court-date / deadline backstop — reserved for the code-backed clock.
        deadline: {
          50: "#fef2f2",
          100: "#fee2e2",
          200: "#fecaca",
          400: "#f87171",
          500: "#ef4444",
          600: "#dc2626",
          700: "#b91c1c",
          900: "#7f1d1d",
        },
        // Warm, human accent — used sparingly for hopeful / "you're cared for"
        // touches (icon badges, the hero glow). Never a status color.
        care: {
          50: "#fff6ed",
          100: "#ffe9d4",
          200: "#fed0a8",
          300: "#fdb070",
          400: "#fb8b3c",
          500: "#f96d16",
          600: "#ea520c",
          700: "#c23d0d",
        },
      },
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      // Soft, layered depth — calm cards that lift gently on interaction.
      boxShadow: {
        card: "0 1px 2px 0 rgb(12 36 41 / 0.04), 0 1px 3px 0 rgb(12 36 41 / 0.05)",
        "card-hover":
          "0 6px 16px -4px rgb(12 36 41 / 0.10), 0 3px 8px -3px rgb(12 36 41 / 0.07)",
        cta: "0 10px 28px -8px rgb(37 109 119 / 0.5)",
      },
      borderRadius: {
        "2xl": "1.125rem",
        "3xl": "1.5rem",
      },
      keyframes: {
        "fade-rise": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-rise": "fade-rise 0.4s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
