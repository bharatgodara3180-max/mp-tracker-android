import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' -> the same build works at http://<pc>:8010/ and behind a proxy at /MP/
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, host: true, proxy: { '/api': 'http://localhost:8010' } },
  build: { outDir: '../server/static', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1400 },
});
