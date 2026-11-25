import { defineConfig } from 'vite';

/** Build browser assets; the Node service owns listening, API and ACP lifecycle. */
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true },
});
