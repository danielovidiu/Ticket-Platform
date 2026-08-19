/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    // Vite reads index.html from the project root and transforms it as a real document;
    // there is no public/ directory any more. This still said ./public/index.html after
    // the migration, so any Tailwind class written into the shell -- a splash, a loading
    // state, a class on <html> -- was silently dropped from the build.
    "./index.html"
  ],
  theme: {
    extend: {
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      // Tailwind's font utilities resolve through the same variables as the hand-written
      // .font-display / .font-mono-x classes in index.css, so `font-sans`, `font-mono`
      // and preflight's default on <html> all follow the CMS theme.
      //
      // Deliberately no `display` key: that would generate a .font-display utility that
      // collides with the class of the same name in index.css, and which of the two wins
      // would then depend on layer ordering rather than on anything a reader can see.
      fontFamily: {
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        // ---- The app's semantic palette -----------------------------------
        // These are the only colour names application code should use. Each one
        // is a role ("the dim text colour"), not a value ("zinc-500"), so the
        // CMS theme can change what it means without touching a component.
        //
        // page / ink / brand / scrim carry <alpha-value>, so the opacity
        // modifiers survive the migration exactly: border-white/15 became
        // border-ink/15 and is still 15%. That needs bare "R G B" channels,
        // which is what the --*-rgb mirrors in index.css exist for.
        //
        // The ink ramp goes light-to-dim on a dark theme and dark-to-dim on a
        // light one, because index.css mixes the middle steps toward --bg.
        page: 'rgb(var(--bg-rgb) / <alpha-value>)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        ink: 'rgb(var(--text-rgb) / <alpha-value>)',
        'ink-2': 'var(--text-2)',
        'ink-3': 'var(--text-3)',
        'ink-4': 'var(--text-4)',
        'ink-5': 'var(--text-5)',
        line: 'var(--border)',
        brand: {
          DEFAULT: 'rgb(var(--accent-rgb) / <alpha-value>)',
          fg: 'var(--accent-fg)',
        },
        ok: 'var(--success)',
        // Deliberately NOT theme-driven: a scrim sits on a photograph, and it
        // has to stay dark whichever way the rest of the site goes.
        scrim: 'rgb(var(--scrim-rgb) / <alpha-value>)',

        // ---- shadcn/ui ------------------------------------------------------
        // Utility names are unchanged so no ui/ component needs editing; only
        // the variables they read moved behind a ui- prefix, because --accent,
        // --muted and --border collided with the app tokens above and the ui
        // side lost every collision. See the note in index.css.
        background: 'hsl(var(--ui-background))',
        foreground: 'hsl(var(--ui-foreground))',
        card: {
          DEFAULT: 'hsl(var(--ui-card))',
          foreground: 'hsl(var(--ui-card-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--ui-popover))',
          foreground: 'hsl(var(--ui-popover-foreground))'
        },
        primary: {
          DEFAULT: 'hsl(var(--ui-primary))',
          foreground: 'hsl(var(--ui-primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--ui-secondary))',
          foreground: 'hsl(var(--ui-secondary-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--ui-muted))',
          foreground: 'hsl(var(--ui-muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--ui-accent))',
          foreground: 'hsl(var(--ui-accent-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--ui-destructive))',
          foreground: 'hsl(var(--ui-destructive-foreground))'
        },
        border: 'hsl(var(--ui-border))',
        input: 'hsl(var(--ui-input))',
        ring: 'hsl(var(--ui-ring))',
      },
      keyframes: {
        'accordion-down': {
          from: {
            height: '0'
          },
          to: {
            height: 'var(--radix-accordion-content-height)'
          }
        },
        'accordion-up': {
          from: {
            height: 'var(--radix-accordion-content-height)'
          },
          to: {
            height: '0'
          }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out'
      }
    }
  },
  plugins: [require("tailwindcss-animate")],
};