import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve('.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    build: {
      target: 'es2020',
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('xlsx')) return 'vendor-xlsx';
              if (id.includes('katex')) return 'vendor-katex';
              if (id.includes('recharts')) return 'vendor-recharts';
              if (id.includes('html2canvas') || id.includes('canvas-confetti')) return 'vendor-canvas';
              if (id.includes('@google/genai')) return 'vendor-genai';
              if (id.includes('@supabase')) return 'vendor-supabase';
              if (id.includes('react') || id.includes('react-dom') || id.includes('scheduler')) return 'vendor-react';
              if (id.includes('motion')) return 'vendor-motion';
            }
          },
        },
      },
    },
  };
});

