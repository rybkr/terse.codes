import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const localEnv = fileURLToPath(new URL('../.env.local', import.meta.url));
if (existsSync(localEnv)) loadEnvFile(localEnv);

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: false,
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.FRONTEND_PORT ?? 3000),
    strictPort: true,
    proxy: { '/trpc': `http://127.0.0.1:${process.env.BACKEND_PORT ?? 8000}` },
  },
});
