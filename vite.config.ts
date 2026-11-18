import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    // Compiled Tailwind only for the Casa Rosier bonos designer page
    // (bonos-designer/designer.css); the main app keeps the Tailwind CDN.
    css: {
      postcss: {
        plugins: [tailwindcss({ config: path.resolve(__dirname, 'bonos-designer/tailwind.config.cjs') })]
      }
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          bonosDesigner: path.resolve(__dirname, 'bonos-designer.html')
        },
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              // Bonos designer only (before the react rule: «lucide-react» contains «react»).
              if (id.includes('html2canvas') || id.includes('lucide-react')) {
                return 'vendor-bonos-designer';
              }
              if (id.includes('react') || id.includes('react-dom')) {
                return 'vendor-react';
              }
              if (id.includes('@supabase')) {
                return 'vendor-supabase';
              }
              return 'vendor';
            }
          }
        }
      }
    }
  };
});
