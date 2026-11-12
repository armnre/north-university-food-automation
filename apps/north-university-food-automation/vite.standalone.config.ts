/**
 * Build for self-hosting next to the Fastify API (no Zite runtime).
 * Dev: npm run dev:standalone proxies /api and /uploads to the API on :3000.
 * Build output: dist-web/ — served as static files by the reverse proxy.
 * PWA: manifest, service worker, icons and favicon come from public-standalone/;
 * the head tags and the boot splash are injected into index.html below.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const dir = fileURLToPath(new URL('.', import.meta.url));
const api = process.env.API_ORIGIN ?? 'http://127.0.0.1:3000';

const HEAD = `
    <title>سامانه اتوماسیون تغذیه دانشگاه شمال</title>
    <meta name="description" content="سامانه رسمی رزرو غذا، پرداخت اینترنتی و تحویل سلف دانشگاه شمال" />
    <meta name="theme-color" content="#155e52" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="تغذیه شمال" />
    ${process.env.VITE_ENAMAD_META ? `<meta name="enamad" content="${process.env.VITE_ENAMAD_META.replace(/[^0-9A-Za-z]/g, '')}" />` : ''}
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <style>
      #boot{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;background:#fff;font-family:Vazirmatn,Tahoma,sans-serif;z-index:9999;transition:opacity .35s}
      #boot img{width:116px;height:116px;object-fit:contain;animation:bootPulse 1.6s ease-in-out infinite}
      #boot .t{color:#155e52;font-weight:700;font-size:15px}
      #boot .bar{width:140px;height:4px;border-radius:4px;background:#e3efec;overflow:hidden}
      #boot .bar i{display:block;width:40%;height:100%;border-radius:4px;background:#155e52;animation:bootBar 1.1s ease-in-out infinite}
      @keyframes bootPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
      @keyframes bootBar{0%{transform:translateX(160%)}100%{transform:translateX(-260%)}}
    </style>`;

const BOOT = `<div id="boot" aria-label="در حال بارگذاری"><img src="/logo.png" alt="" /><div class="t">سامانه اتوماسیون تغذیه دانشگاه شمال</div><div class="bar"><i></i></div></div>
    <script>
      (function(){var b=document.getElementById('boot');var r=document.getElementById('root');
        var done=function(){if(!b)return;b.style.opacity='0';setTimeout(function(){b&&b.remove();b=null},380)};
        new MutationObserver(function(_,o){if(r.childElementCount){o.disconnect();setTimeout(done,150)}}).observe(r,{childList:true});
        setTimeout(done,15000);
        if('serviceWorker' in navigator){addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}
      })();
    </script>`;

function pwaHtml(): Plugin {
  return {
    name: 'nufa-pwa-html',
    transformIndexHtml(html) {
      return html
        .replace(/<html[^>]*>/, '<html lang="fa" dir="rtl">')
        .replace(/<title>[\s\S]*?<\/title>/, '')
        .replace(/<link rel="icon"[^>]*>/, '')
        .replace('</head>', `${HEAD}\n  </head>`)
        .replace('<div id="root"></div>', `<div id="root"></div>\n    ${BOOT}`);
    },
  };
}

export default defineConfig({
  plugins: [react(), pwaHtml()],
  publicDir: path.resolve(dir, 'public-standalone'),
  build: { outDir: 'dist-web', target: 'es2020', sourcemap: false },
  server: { port: 8080, proxy: { '/api': api, '/uploads': api } },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { '@': path.resolve(dir, './src'), '@project/components': path.resolve(dir, '../../packages/components') },
  },
});
