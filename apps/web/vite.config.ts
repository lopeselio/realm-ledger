import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022' },
  // like the Vercel rewrite: /api goes to the game server (a local one by default)
  server: { proxy: { '/api': { target: process.env.API_TARGET ?? 'http://localhost:8787', changeOrigin: true } } },
});
