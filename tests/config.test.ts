import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfiguration } from '../server/config.js';

function production() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('APP_ORIGIN', 'https://terse.example.com');
  vi.stubEnv('CONVEX_URL', 'https://example.convex.cloud');
  vi.stubEnv('TERSE_SERVER_SECRET', 'test-service-secret-with-at-least-32-characters');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_live_placeholder');
  vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', 'pk_live_placeholder');
  vi.stubEnv('CLERK_WEBHOOK_SIGNING_SECRET', 'whsec_placeholder');
}

afterEach(() => vi.unstubAllEnvs());

describe('production configuration boundaries', () => {
  it('requires production identity keys, HTTPS origins, hosted persistence, and signed webhooks', () => {
    production();
    expect(() => validateConfiguration()).not.toThrow();
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_placeholder');
    expect(() => validateConfiguration()).toThrow('production secret');
    production();
    vi.stubEnv('APP_ORIGIN', 'http://terse.example.com');
    expect(() => validateConfiguration()).toThrow('HTTPS');
    production();
    vi.stubEnv('CONVEX_URL', 'http://127.0.0.1:3210');
    expect(() => validateConfiguration()).toThrow('hosted Convex');
    production();
    vi.stubEnv('CLERK_WEBHOOK_SIGNING_SECRET', '');
    expect(() => validateConfiguration()).toThrow('WEBHOOK');
  });

  it('does not permit a missing or weak server credential even in development', () => {
    production();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('TERSE_SERVER_SECRET', 'short');
    expect(() => validateConfiguration()).toThrow('TERSE_SERVER_SECRET');
  });
});
