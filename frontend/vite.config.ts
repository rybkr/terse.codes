import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    envDir: process.cwd(),
    plugins: [react(), tailwindcss()],
    server: {
      host: '0.0.0.0',
      port: Number(env.FRONTEND_PORT ?? 3000),
      strictPort: true,
      proxy: { '/trpc': `http://127.0.0.1:${env.BACKEND_PORT ?? 8000}` },
    },
  };
});
