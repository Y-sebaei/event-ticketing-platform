import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// The dev server proxies the same two paths nginx proxies in the Docker image,
// so the browser is always on one origin and `vite dev` and production behave
// identically for cookies and WebSocket upgrades.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
