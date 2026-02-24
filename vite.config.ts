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
    port: 5173,
    open: false,
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
