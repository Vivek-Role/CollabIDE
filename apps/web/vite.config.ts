import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The proxy is the most important line in this file.
 *
 * The session cookie is httpOnly + SameSite=Strict. Vite serves the UI on :5173
 * and the API listens on :4000 — different origins — so without the proxy the
 * browser accepts the Set-Cookie from login and then never sends it again:
 * login appears to succeed and every subsequent request is a 401.
 *
 * Proxying /api makes the browser see a single origin. The cookie flows, and
 * the Origin header stays http://localhost:5173, which is exactly what the
 * server's originCheck middleware allows (WEB_ORIGIN).
 *
 * Do NOT add `changeOrigin: true`. It rewrites the Host header for
 * virtual-hosted upstreams and has no purpose here.
 *
 * '/ws' (module 3.2) is the same idea for the collaboration socket: `ws: true`
 * makes Vite forward the HTTP upgrade instead of answering it, so the session
 * cookie reaches :4000 on the handshake and no token has to travel in the URL.
 *
 * API_PORT (module 7.2) is the ONE thing Phase 7 made configurable, so a second
 * browser can be pointed at a second server instance. Unset it and this file
 * behaves exactly as it did before. The dev server's own port stays in the
 * config and is moved with Vite's --port flag instead — a second variable would
 * be a second way to say the same thing.
 */
const apiPort = process.env.API_PORT ?? '4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Fail loudly instead of silently moving to :5174, where the cookie's
    // origin — and every curl in the docs — would quietly be wrong.
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
});
