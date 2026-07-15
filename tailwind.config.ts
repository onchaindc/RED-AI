import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#191918",
        canvas: "#f4f4f1",
        signal: "#e64236",
      },
      boxShadow: {
        card: "0 1px 2px rgba(17, 24, 39, 0.04), 0 12px 32px rgba(17, 24, 39, 0.04)",
      },
    },
  },
  plugins: [],
};

export default config;
