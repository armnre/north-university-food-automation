import path from 'path';
import { fileURLToPath } from 'url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite — فرانت‌اند استاتیک.
 *
 * در توسعه، `/api` به بک‌اند Fastify پروکسی می‌شود تا فرانت و API هم‌دامنه
 * (same-origin) بمانند و کوکی نشست/CSRF درست کار کند (بدون CORS).
 * در تولید، خروجی `dist` توسط nginx/Plesk سرو می‌شود و `/api` به
 * `127.0.0.1:PORT` پروکسی می‌شود.
 */
export default defineConfig({
  plugins: [react()],
  build: { target: 'esnext', sourcemap: false, reportCompressedSize: false, outDir: 'dist' },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT ?? 8080),
    strictPort: false,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: false,
        cookieDomainRewrite: '',
      },
      '/uploads': {
        target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@project/components': path.resolve(__dirname, '../../packages/components'),
    },
  },
});
