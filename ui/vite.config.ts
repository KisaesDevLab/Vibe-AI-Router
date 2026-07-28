import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset URLs, so one build works wherever it is mounted.
  //
  // With the default `base: '/'` the bundle asks for `/assets/index-*.js` no
  // matter what path it was served from. That is fine at the root of a
  // hostname and broken everywhere else: mounted under a path prefix, the
  // shell loads and every asset request goes to the ROOT of that host —
  // which, on the Vibe Appliance, is a different app entirely (the console).
  // The operator gets a blank page with a 200 and nothing in any log.
  //
  // `'./'` makes Vite emit `./assets/…`, resolved by the browser against the
  // directory of the current URL. The page must therefore be served with a
  // trailing slash (`/ai-router/`, not `/ai-router`); every proxy in front of
  // this app already redirects the bare form. Safe because this UI has no
  // client-side router — the URL never goes deeper than the mount point, so
  // relative resolution can't drift. Revisit if routes are ever added.
  base: './',
  plugins: [react()],
  server: {
    port: 8221, // suite block 8220–8229
    proxy: {
      '/admin-api': 'http://localhost:8220',
      '/v1': 'http://localhost:8220',
    },
  },
  build: { outDir: 'dist' },
});
