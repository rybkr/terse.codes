import { createClerkClient, verifyToken } from '@clerk/backend';
import { TRPCError } from '@trpc/server';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../convex/_generated/api.js';

export type PublicProfile = FunctionReturnType<typeof api.users.requireSession>;
export interface Identity {
  userId: string;
  sessionId: string;
  expiresAt: number;
}

export interface Accounts {
  verify(token: string | undefined): Promise<Identity>;
  signIn(identity: Identity): Promise<PublicProfile>;
  profile(identity: Identity): Promise<PublicProfile>;
}

export function unauthorized(message = 'Sign in to continue.'): never {
  throw new TRPCError({ code: 'UNAUTHORIZED', message });
}

export function databaseClient() {
  const url = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
  const secret = process.env.TERSE_SERVER_SECRET;
  if (!url || !secret || secret.length < 32) throw new Error('Configure the Convex URL and TERSE_SERVER_SECRET.');
  return { client: new ConvexHttpClient(url), secret };
}

export function allowedOrigins() {
  const configured = process.env.APP_ORIGIN;
  if (process.env.NODE_ENV === 'production' && !configured) throw new Error('APP_ORIGIN is required in production.');
  return configured ? configured.split(',').map((origin) => new URL(origin.trim()).origin)
    : ['http://localhost:3000', 'http://127.0.0.1:3000'];
}

export function createAccounts(onReplaced: (userId: string, oldSessionId: string) => void): Accounts {
  const clerk = () => {
    if (!process.env.CLERK_SECRET_KEY) throw new Error('CLERK_SECRET_KEY is required.');
    return createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  };
  return {
    async verify(token) {
      if (!token) unauthorized();
      try {
        const payload = await verifyToken(token, {
          secretKey: process.env.CLERK_SECRET_KEY,
          authorizedParties: allowedOrigins(),
        });
        if (!payload.sub || typeof payload.sid !== 'string' || typeof payload.exp !== 'number') unauthorized();
        return { userId: payload.sub, sessionId: payload.sid, expiresAt: payload.exp * 1000 };
      } catch {
        unauthorized('Your session expired. Sign in again.');
      }
    },
    async signIn(identity) {
      const backend = clerk();
      const [session, user] = await Promise.all([
        backend.sessions.getSession(identity.sessionId), backend.users.getUser(identity.userId),
      ]);
      if (session.userId !== identity.userId || session.status !== 'active') unauthorized();
      if (!user.username || !/^[A-Za-z0-9_]{4,12}$/.test(user.username)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Choose a username with 4–12 letters, numbers, or underscores to continue.' });
      }
      const { client, secret } = databaseClient();
      const result = await client.mutation(api.users.ensureSession, {
        secret, userId: identity.userId, username: user.username,
        sessionId: identity.sessionId, sessionCreatedAt: session.createdAt,
      });
      if (!result.active) unauthorized('You signed in somewhere else. Sign in again to use this device.');
      if (result.replacedSessionId) {
        onReplaced(identity.userId, result.replacedSessionId);
        try {
          await backend.sessions.revokeSession(result.replacedSessionId);
        } catch {
          // Convex already denies the replaced session even if Clerk is temporarily unavailable.
          console.error('Could not revoke a replaced Clerk session. Application access was revoked.');
        }
      }
      return result.profile;
    },
    async profile(identity) {
      if (Date.now() >= identity.expiresAt) unauthorized('Your session expired. Sign in again.');
      try {
        const { client, secret } = databaseClient();
        return await client.query(api.users.requireSession, { secret, userId: identity.userId, sessionId: identity.sessionId });
      } catch {
        unauthorized('Your session is no longer active. Sign in again.');
      }
    },
  };
}
