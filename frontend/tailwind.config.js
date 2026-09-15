/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Legacy colors kept for backward compat
        'ui-primary': '#0F172A',
        'ui-secondary': '#475569',
        'ui-surface': '#FFFFFF',
        'ui-surface-2': '#F8FAFC',
        'ui-emerald': '#10B981',
        'ui-teal': '#14B8A6',
        'brand-primary': '#1e40af',
        'brand-surface': '#ffffff',
        'brand-bg': '#f8fafc',
        // Dark Mode Zinc palette (explicit)
        'shell': '#09090b',       // zinc-950 - app bg, sidebar, topnav
        'surface': '#18181b',     // zinc-900 - cards, tables
        'overlay': '#27272a',     // zinc-800 - hover, borders, active
        'border-dark': '#27272a', // zinc-800
        'text-primary': '#fafafa',  // zinc-50
        'text-secondary': '#a1a1aa', // zinc-400
        'text-muted-dark': '#71717a', // zinc-500
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      keyframes: {
        'slide-up': {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        }
      },
      animation: {
        'fade-in-up': 'slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
      }
    },
  },
  plugins: [],
}
