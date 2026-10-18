import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const localEnv = fileURLToPath(new URL('./.env.local', import.meta.url));
if (existsSync(localEnv)) loadEnvFile(localEnv);

export default defineConfig({ envDir: false });
