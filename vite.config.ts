import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';

export default defineConfig(() => {
  return {
    server: {
      port: 3000,
      host: '127.0.0.1',
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    // Each CSS entry selects its own Tailwind config.
    css: {
      postcss: {
        plugins: [tailwindcss()]
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
              // PDF/icon libs for the Casa Rosier designer (before the react
              // rule: «lucide-react» contains «react»).
              if (
                id.includes('html2canvas') ||
                id.includes('jspdf') ||
                id.includes('canvg') ||
                id.includes('lucide-react')
              ) {
                return 'vendor-bonos-designer';
              }
              // Keep scheduler with react/react-dom to avoid a circular chunk
              // (TypeError: Cannot set properties of undefined (setting 'unstable_now')).
              if (
                id.includes(`${path.sep}react${path.sep}`) ||
                id.includes(`${path.sep}react-dom${path.sep}`) ||
                id.includes(`${path.sep}scheduler${path.sep}`) ||
                id.includes('react-router')
              ) {
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
