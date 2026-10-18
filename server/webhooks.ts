import { verifyWebhook } from '@clerk/backend/webhooks';
import { api } from '../convex/_generated/api.js';
import { databaseClient } from './accounts.js';
import type { RoomStore } from './rooms.js';

export async function clerkWebhook(request: Request, rooms: RoomStore) {
  const signingSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!signingSecret) return new Response('Webhook is not configured.', { status: 503 });
  let event;
  try {
    event = await verifyWebhook(request, { signingSecret });
  } catch {
    return new Response('Invalid webhook signature.', { status: 400 });
  }
  const { client, secret } = databaseClient();
  if (event.type === 'user.deleted' && event.data.id) {
    await client.mutation(api.users.deleteUser, { secret, userId: event.data.id });
    const roomId = rooms.currentRoom(event.data.id);
    if (roomId) rooms.leave(roomId, event.data.id);
  } else if (event.type === 'session.ended' || event.type === 'session.revoked' || event.type === 'session.removed') {
    await client.mutation(api.users.revokeSession, { secret, userId: event.data.user_id, sessionId: event.data.id });
  }
  return new Response('OK');
}
