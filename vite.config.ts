import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages: hra beží v podadresári /<repo>/ (nastaví workflow cez VITE_BASE)
  base: process.env.VITE_BASE || '/',
  server: { port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
