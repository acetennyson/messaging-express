import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the browser talks to Vite (5173) and Vite forwards /auth and /chat (including the websocket) to the Node server.
const target = `http://localhost:${process.env.PORT || 3000}`;
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/auth': target, '/chat': { target, ws: true } } },
});
