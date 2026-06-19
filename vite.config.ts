import { defineConfig } from 'vite';

// Standard SPA build, served over http (dev server, `npm run preview`, or any static host).
// `base: './'` keeps the bundle path-relative so it deploys under any sub-path.
//
// The rules / EV / netcode UMD files live under public/ and load as classic <script> tags in
// index.html — they install the window.* globals before the bundled UI runs, stay OUT of the
// bundle (so the eager ~2 MB EV tables aren't re-inlined), and remain plain JS so the Node
// test-suite keeps require()-ing the very same source files.
export default defineConfig({
  base: './',
  build: {
    target: 'es2018',
    outDir: 'dist',
    assetsDir: 'assets',
  },
});
