import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The renderer is served from a custom `app://` scheme in production, so assets must be
// referenced relatively rather than from an absolute root.
export default defineConfig({
  root: 'app/renderer',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'chrome130',
  },
  server: { port: 5273, strictPort: true },
});
