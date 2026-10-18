import { allowedOrigins, databaseClient } from './accounts.js';

export function validateConfiguration() {
  const origins = allowedOrigins();
  databaseClient();
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is required.');
  if (process.env.NODE_ENV !== 'production') return;
  if (!secretKey.startsWith('sk_live_')) throw new Error('Production requires a Clerk production secret key.');
  const publicKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!publicKey?.startsWith('pk_live_')) throw new Error('Production requires a Clerk production publishable key at build and runtime.');
  if (origins.some((origin) => !origin.startsWith('https://'))) throw new Error('Production APP_ORIGIN must use HTTPS.');
  const databaseUrl = new URL(process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL ?? '');
  if (databaseUrl.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)) {
    throw new Error('Production requires a hosted Convex deployment over HTTPS.');
  }
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) throw new Error('CLERK_WEBHOOK_SIGNING_SECRET is required in production.');
}
