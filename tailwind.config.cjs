module.exports = {content:['./index.html','./App.tsx','./index.tsx','./{admin,components,pages,context,utils}/**/*.{ts,tsx}'], ...{
      theme: {
        extend: {
          colors: {
            brand: {
              DEFAULT: 'var(--brand)',
              hover: 'var(--brand-hover)',
              pressed: 'var(--brand-pressed)',
              light: 'var(--brand-light)',
              soft: 'var(--brand-soft)'
            },
            marron: 'var(--brown)',
            taupe: 'var(--taupe)',
            arena: 'var(--sand)',
            caramelo: 'var(--caramel)',
            neutral: {
              base: 'var(--bg)',
              alt: 'var(--surface-soft)',
              surface: 'var(--surface)',
              sec: 'var(--surface-muted)',
              border: 'var(--line)',
              textMain: 'var(--text-primary)',
              textSec: 'var(--text-secondary)',
              textHelper: 'var(--text-muted)',
              customGray: 'var(--text-muted)'
            }
          },
          fontFamily: {
            sans: ['Manrope', 'Inter', 'system-ui', 'sans-serif'],
            display: ['Manrope', 'Inter', 'system-ui', 'sans-serif']
          }
        }
      }
    }};
