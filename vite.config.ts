import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  base: '/altres/catmap/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  publicDir: 'public',
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    open: false,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 5174,
      clientPort: 5174,
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
