import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Arial", "Helvetica", "sans-serif"],
      },
      colors: {
        darkBg: "#050807",
        darkSurface: "#0B1210",
        darkCard: "#101815",
        accent: "#2DD4BF",
        accentHover: "#5EEAD4",
        success: "#10B981",
        borderColor: "#1C2A24",
      },
      boxShadow: {
        glow: "0 0 20px -4px rgba(45, 212, 191, 0.45)",
        cardGlow: "0 0 12px -3px rgba(45, 212, 191, 0.25)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
export default config;
