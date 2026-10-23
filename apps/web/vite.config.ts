import path from 'path';
import { fileURLToPath } from 'url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite — فرانت‌اند استاتیک و PWA هم‌دامنه (Same-Origin).
 *
 * اصول امنیتی Service Worker:
 *  - هرگز پاسخ‌های `/api/*` یا `/uploads/*` کش نمی‌شوند تا دادهٔ شخصی/مالی در کش مرورگر نماند
 *    و بازگشت درگاه زرین‌پال (`/api/v1/payments/zarinpal/callback`) مستقیماً به سرور برسد.
 *  - فقط فایل‌های استاتیک برنامه (JS/CSS/HTML/فونت/آیکون) precache می‌شوند.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      manifest: false,
      includeAssets: [
        'favicon.svg',
        'logo.svg',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-512.png',
        'offline.html',
        'manifest.webmanifest',
      ],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api(\/|$)/, /^\/uploads(\/|$)/],
        runtimeCaching: [],
      },
    }),
  ],
  build: {
    target: 'esnext',
    sourcemap: false,
    reportCompressedSize: true,
    outDir: 'dist',
  },
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
