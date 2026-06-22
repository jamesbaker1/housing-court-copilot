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
    },
  },
  plugins: [],
};

export default config;
