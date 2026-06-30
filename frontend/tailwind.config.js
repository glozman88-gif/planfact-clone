/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      colors: {
        brand: {
          DEFAULT: "#16b1bf", // бирюзовый акцент ПланФакта
          dark: "#0e8a95",
          light: "#e6f7f9",
        },
        sidebar: {
          DEFAULT: "#2b3b4e", // тёмный сине-серый сайдбар
          hover: "#35485e",
          active: "#16b1bf",
        },
      },
    },
  },
  plugins: [],
};
