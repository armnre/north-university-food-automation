/**
 * Build for self-hosting next to the Fastify API (no Zite runtime).
 * Dev: npm run dev:standalone proxies /api and /uploads to the API on :3000.
 * Build output: dist-web/ — served as static files by the reverse proxy.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const dir = fileURLToPath(new URL('.', import.meta.url));
const api = process.env.API_ORIGIN ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist-web', target: 'es2020', sourcemap: false },
  server: { port: 8080, proxy: { '/api': api, '/uploads': api } },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { '@': path.resolve(dir, './src'), '@project/components': path.resolve(dir, '../../packages/components') },
  },
});
