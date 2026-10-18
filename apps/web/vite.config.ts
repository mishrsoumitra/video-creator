import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiPort = process.env.VC_PORT ?? '4317';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The API only answers to its own Host header (DNS-rebinding guard), so rewrite Host; the
      // browser's Origin stays http://localhost:5173, which the server allows when VC_DEV=1.
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      onwarn(warning, warn) {
        // simplex-noise (via @remotion/noise) ships /*#__PURE__*/ comments Rollup cannot place; harmless.
        if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules')) return;
        warn(warning);
      },
    },
  },
});
