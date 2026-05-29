/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./public/**/*.html", "./public/**/*.js"],

  safelist: [
    // ── Status/condition based colors (used dynamically in JS) ──
    // Backgrounds
    "bg-green-50",
    "bg-green-100",
    "bg-green-500",
    "bg-red-50",
    "bg-red-100",
    "bg-red-500",
    "bg-blue-50",
    "bg-blue-100",
    "bg-blue-500",
    "bg-yellow-50",
    "bg-yellow-100",
    "bg-white",

    // Text colors
    "text-green-600",
    "text-green-700",
    "text-green-800",
    "text-green-900",
    "text-red-500",
    "text-red-600",
    "text-red-700",
    "text-red-800",
    "text-red-900",
    "text-blue-300",
    "text-blue-500",
    "text-blue-600",
    "text-blue-700",
    "text-blue-800",
    "text-yellow-500",
    "text-yellow-600",
    "text-yellow-700",
    "text-yellow-800",
    "text-gray-300",
    "text-gray-400",
    "text-gray-500",
    "text-gray-600",
    "text-orange-600",
    "text-orange-700",
    "text-amber-700",
    "text-indigo-700",
    "text-purple-700",
    "text-white",

    // Borders
    "border-green-100",
    "border-green-200",
    "border-green-300",
    "border-green-500",
    "border-red-200",
    "border-red-500",
    "border-blue-100",
    "border-blue-200",
    "border-blue-500",
    "border-yellow-100",
    "border-yellow-500",
    "border-gray-200",
    "border-gray-300",
    "border-orange-100",
    "border-indigo-100",
    "border-purple-100",

    // Hover states used dynamically
    "hover:bg-green-600",
    "hover:bg-red-600",
    "hover:bg-gray-50",
    "hover:text-gray-400",

    // Utilities toggled via JS
    "opacity-50",
    "cursor-pointer",
    "cursor-none",
    "font-bold",
    "font-semibold",
    "font-medium",
    "inline-block",
    "inline-flex",
    "rounded-full",

    // current-personnel & old-personnel status colors
    // text-${newStatus === 'ACTIVE' ? 'green' : 'red'}-600
    "text-green-600",
    "text-red-600",
  ],

  theme: {
    extend: {
      maxWidth: {
        layout: "1440px",
      },
      colors: {
        navy: "#F0B323",
        warning: "#f6b409",
        success: "#047014",
        gold: { DEFAULT: "#C4932A", light: "#D4A94A", pale: "#F5EDD5" },
        steel: { DEFAULT: "#2E5090", light: "#3D6BB5" },
        smoke: { DEFAULT: "#F0F3F8", dark: "#DDE3EE" },
        ink: { DEFAULT: "#111827" },
        muted: { DEFAULT: "#6B7280" },
        danger: { DEFAULT: "#9B1C1C", light: "#FEE2E2" },
      },
      fontFamily: {
        display: ["Playfair Display", "Georgia", "serif"],
        body: ["IBM Plex Sans", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
      },
      screens: {
        xs: "640px",
        custom: "766px",
      },
      boxShadow: {
        custom: "0 2px 5px 0 rgba(0,0,0,0.08)",
      },
      keyframes: {
        "grow-up": { "0%": { height: "0" }, "100%": { height: "100%" } },
        "grow-down": {
          "0%": { height: "0", bottom: "0" },
          "100%": { height: "100%" },
        },
        expand: { "0%": { width: "0" }, "100%": { width: "100%" } },
      },
      animation: {
        "grow-up": "grow-up 0.8s ease-out forwards",
        "grow-down": "grow-down 0.8s ease-out forwards",
        expand: "expand 0.8s ease-out forwards",
      },
    },
  },

  plugins: [],
};
