import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clerkWebhook } from '../server/webhooks.js';
import { RoomStore } from '../server/rooms.js';

const { mutation } = vi.hoisted(() => ({ mutation: vi.fn(async () => null) }));
vi.mock('../server/accounts.js', () => ({
  databaseClient: () => ({ client: { mutation }, secret: 'test-server-secret' }),
}));

const signingKey = Buffer.from('test-webhook-signing-key-32-bytes');
const signingSecret = `whsec_${signingKey.toString('base64')}`;

function request(body: string, signatureBody = body) {
  const id = 'msg_test_event';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', signingKey).update(`${id}.${timestamp}.${signatureBody}`).digest('base64');
  return new Request('http://localhost/webhooks/clerk', {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
  });
}

afterEach(() => { vi.unstubAllEnvs(); mutation.mockClear(); });

describe('Clerk webhook signatures', () => {
  it('rejects missing configuration and tampered payloads before any database write', async () => {
    const rooms = new RoomStore(() => { throw new Error('No round is started.'); });
    vi.stubEnv('CLERK_WEBHOOK_SIGNING_SECRET', '');
    expect((await clerkWebhook(request('{}'), rooms)).status).toBe(503);
    vi.stubEnv('CLERK_WEBHOOK_SIGNING_SECRET', signingSecret);
    expect((await clerkWebhook(request('{"type":"user.deleted","data":{"id":"victim"}}', '{}'), rooms)).status).toBe(400);
    expect(mutation).not.toHaveBeenCalled();
  });

  it('accepts a signed account deletion and closes the deleted user’s room', async () => {
    vi.stubEnv('CLERK_WEBHOOK_SIGNING_SECRET', signingSecret);
    const rooms = new RoomStore(() => { throw new Error('No round is started.'); });
    const host = rooms.create({ name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 }, 'host');
    const body = JSON.stringify({ object: 'event', type: 'user.deleted', data: { id: 'host', deleted: true, object: 'user' } });
    expect((await clerkWebhook(request(body), rooms)).status).toBe(200);
    expect(mutation).toHaveBeenCalledOnce();
    expect(rooms.currentRoom('host')).toBeNull();
    expect(() => rooms.snapshot(host.roomId, 'host')).toThrow('Room not found.');
  });
});
