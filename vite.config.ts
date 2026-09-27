import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/* The Rust shell binds the loopback server on 8933. In dev the page is served
   by Vite instead, so /_proxy and /_ws-proxy have to be forwarded or every
   LLM and TTS call dies with a CORS error. Both the Vite origin and the
   production origin match the loopback test in the app's own proxy gate, so
   the app code takes the same branch in both modes. */
const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_PORT = 8933;
const LOOPBACK_HTTP = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}`;
const LOOPBACK_WS = `ws://${LOOPBACK_HOST}:${LOOPBACK_PORT}`;

const DEV_PORT = 5173;

export default defineConfig({
  plugins: [react(), tailwindcss()],

  /* Tauri owns the terminal; don't wipe its output. */
  clearScreen: false,

  server: {
    host: LOOPBACK_HOST,
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      '/_proxy': { target: LOOPBACK_HTTP, changeOrigin: false },
      '/_ws-proxy': { target: LOOPBACK_WS, ws: true, changeOrigin: false },
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    /* Vite defaults to `assets/` for its hashed bundles, which collides with
       the character assets served from `public/assets/`. They merge without
       error, which is exactly what makes it confusing. Keep them apart. */
    assetsDir: '_vite',
    /* WebView2 153 is Chromium 153 — no need to downlevel for old browsers. */
    target: 'chrome130',
    sourcemap: true,
  },
});
