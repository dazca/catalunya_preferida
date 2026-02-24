import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/altres/catmap/',
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  publicDir: 'public',
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    open: false,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 5173,
      clientPort: 5173,
      path: '/altres/catmap/',
    },
    fs: {
      allow: ['..'],
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    css: true,
  },
});
