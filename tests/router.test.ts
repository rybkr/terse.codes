import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppServer } from '../server/http.js';
import type { Accounts, Identity, PublicProfile } from '../server/accounts.js';
import { unauthorized } from '../server/accounts.js';
import type { Problem } from '../server/problems.js';
import { createRouter, type AppRouter, type RoomSnapshot } from '../server/router.js';
import { RoomStore } from '../server/rooms.js';

const problem: Problem = {
  id: 'sum', title: 'Sum', difficulty: 'Easy', statement: 'Return the input.',
  entryPoint: 'Solution().echo', starterCode: 'class Solution:\n    def echo(self, value: int) -> int:\n        pass\n',
  parameters: [{ name: 'value', type: 'int' }], returnType: 'int', tests: [{ input: [1], expected: 1 }],
};
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

function profile(userId: string): PublicProfile {
  return {
    userId, username: userId, rating: 1000, tournamentWins: 0, roundWins: 0, careerPoints: 0, solvedProblems: 0,
    roundWinStreak: 0, bestRoundWinStreak: 0, tournamentWinStreak: 0, bestTournamentWinStreak: 0,
  };
}

async function serverSetup() {
  const accounts: Accounts = {
    async verify(token) {
      if (!token || !['Dark', 'Chat', 'Other'].includes(token)) unauthorized();
      return { userId: token, sessionId: token, expiresAt: Date.now() + 60_000 };
    },
    async signIn(identity: Identity) { return profile(identity.userId); },
    async profile(identity: Identity) { return profile(identity.userId); },
  };
  const store = new RoomStore(() => problem, async () => ({ passed: 1, total: 1, solved: true, charCount: 20, error: null, timeMs: 1, firstFailure: null, stdout: '', stderr: '' }));
  const router = createRouter(store, accounts);
  const server = createAppServer(router);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const url = `http://127.0.0.1:${address.port}/trpc`;
  const client = (token?: string) => createTRPCClient<AppRouter>({ links: [
    httpBatchLink({ url, headers: () => token ? { authorization: `Bearer ${token}` } : {} }),
  ] });
  return { store, client, url };
}

describe('authenticated tRPC transport', () => {
  it('requires an account and derives room identity from the verified profile', async () => {
    const { client, url } = await serverSetup();
    await expect(client().createRoom.mutate({})).rejects.toThrow('Sign in');
    await expect(client('forged').signIn.mutate()).rejects.toThrow('Sign in');
    const host = await client('Dark').createRoom.mutate({});
    expect(host.name).toBe('Dark');
    expect(host.roomId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const spoof = await fetch(`${url}/createRoom`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Chat' },
      body: JSON.stringify({ name: 'Dark' }),
    });
    expect(spoof.status).toBe(400);
    await expect(client('Other').room.query({ roomId: host.roomId })).rejects.toThrow('Rejoin');
  });

  it('enforces roles and deadlines over HTTP while preserving private submissions', async () => {
    const { client } = await serverSetup();
    const host = await client('Dark').createRoom.mutate({});
    await client('Chat').joinRoom.mutate({ roomId: host.roomId });
    await expect(client('Chat').start.mutate({ roomId: host.roomId })).rejects.toThrow('Only the host');
    await client('Dark').start.mutate({ roomId: host.roomId });
    await client('Dark').submit.mutate({ roomId: host.roomId, code: 'correct solution' });
    const playing = await client('Chat').room.query({ roomId: host.roomId });
    expect(playing.rankings[0]?.code).toBeNull();
    expect(playing.me.submission).toBeNull();
    expect(playing.problem).not.toHaveProperty('tests');
    await client('Dark').kick.mutate({ roomId: host.roomId, userId: 'Chat' });
    await expect(client('Chat').joinRoom.mutate({ roomId: host.roomId })).rejects.toThrow('removed');
    expect((await client('Dark').me.query()).roomId).toBe(host.roomId);
  });

  it('sets private response headers and rejects untrusted origins', async () => {
    const { url } = await serverSetup();
    const health = await fetch(url.replace('/trpc', '/health'));
    expect(health.headers.get('referrer-policy')).toBe('no-referrer');
    expect(health.headers.get('cache-control')).toBe('no-store');
    const response = await fetch(`${url}/me`, { headers: { origin: 'https://evil.example', authorization: 'Bearer Dark' } });
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
    const rejectedClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({
      url, headers: { origin: 'https://evil.example', authorization: 'Bearer Dark' },
    })] });
    await expect(rejectedClient.me.query()).rejects.toMatchObject({
      message: 'Origin is not allowed. Open Terse using its configured address.',
      data: { code: 'FORBIDDEN', httpStatus: 403 },
    });
  });

  it('sends an immediate personalized SSE snapshot then live changes', async () => {
    const { client, url } = await serverSetup();
    const host = await client('Dark').createRoom.mutate({});
    const abort = new AbortController();
    cleanup.push(() => abort.abort());
    const input = encodeURIComponent(JSON.stringify({ roomId: host.roomId, token: 'Dark' }));
    const response = await fetch(`${url}/roomUpdates?input=${input}`, { signal: abort.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing SSE stream');
    const decoder = new TextDecoder();
    let buffer = '';
    const nextSnapshot = async (): Promise<RoomSnapshot> => {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!event.startsWith('event:')) {
            const data = event.split('\n').find((line) => line.startsWith('data: '));
            if (data) return JSON.parse(data.slice(6)) as RoomSnapshot;
          }
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE stream ended');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    expect((await nextSnapshot()).me.userId).toBe('Dark');
    await client('Dark').heartbeat.mutate({ roomId: host.roomId });
    await client('Dark').start.mutate({ roomId: host.roomId });
    expect((await nextSnapshot()).state).toBe('playing');
    abort.abort();
  });
});
