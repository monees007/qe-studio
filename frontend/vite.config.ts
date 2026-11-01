/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const backend = process.env.QES_BACKEND ?? 'http://127.0.0.1:8765';

/** In dev, inject the backend API token (read from QES_HOME) into index.html. */
function devToken(): Plugin {
  return {
    name: 'qes-dev-token',
    apply: 'serve',
    transformIndexHtml(html) {
      const home = process.env.QES_HOME ?? path.join(os.homedir(), '.qestudio');
      let token = '';
      try {
        token = fs.readFileSync(path.join(home, 'api-token'), 'utf8').trim();
      } catch {
        console.warn('[qes] api-token not found; start the backend once first');
      }
      return html.replace('__QES_TOKEN__', token);
    },
  };
}

export default defineConfig({
  plugins: [react(), devToken()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          mantine: [
            '@mantine/core',
            '@mantine/hooks',
            '@mantine/notifications',
            '@mantine/modals',
            '@mantine/dropzone',
          ],
          three: ['three', '@react-three/fiber', '@react-three/drei'],
        },
      },
    },
  },
  worker: { format: 'es' },
  // unit tests of pure logic (`npm test`); browser tests live in e2e/ and run with Playwright
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
