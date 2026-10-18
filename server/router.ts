import { EventEmitter } from 'node:events';
import { initTRPC, TRPCError, type inferRouterInputs, type inferRouterOutputs } from '@trpc/server';
import { z } from 'zod';
import { createAccounts, unauthorized, type Accounts } from './accounts.js';
import { difficultySchema, ProblemRepository } from './problems.js';
import { RoomStore } from './rooms.js';
import { Persistence } from './persistence.js';
import { RateLimit } from './rate-limit.js';
import { RunnerShuttingDownError } from './runner-queue.js';

export interface Context { token: string | undefined; ip?: string }
const t = initTRPC.context<Context>().create({ sse: { ping: { enabled: true, intervalMs: 10_000 } } });
const roomInput = z.object({ roomId: z.string().regex(/^[A-Za-z0-9_-]{24}$/) });

export function createRouter(store: RoomStore, accountService?: Accounts, flush = async () => {}) {
  const sessions = new EventEmitter();
  sessions.setMaxListeners(5000);
  const accounts = accountService ?? createAccounts((userId, sessionId) => sessions.emit(sessionId, userId));
  const limits = new RateLimit();
  const authenticated = t.procedure.use(async ({ ctx, next }) => {
    limits.check(`requests:${ctx.ip ?? 'local'}`, 600, 60_000);
    const identity = await accounts.verify(ctx.token);
    const profile = await accounts.profile(identity);
    return next({ ctx: { ...ctx, identity, profile } });
  });
  const action = authenticated.use(async ({ next }) => {
    const result = await next();
    await flush();
    return result;
  });
  return t.router({
    signIn: t.procedure.mutation(async ({ ctx }) => {
      limits.check(`signin:${ctx.ip ?? 'local'}`, 30, 60_000);
      const identity = await accounts.verify(ctx.token);
      const profile = await accounts.signIn(identity);
      return { profile, roomId: store.currentRoom(identity.userId) };
    }),
    me: authenticated.query(async ({ ctx }) => {
      await flush();
      return { profile: await accounts.profile(ctx.identity), roomId: store.currentRoom(ctx.identity.userId) };
    }),
    profile: authenticated.query(async ({ ctx }) => {
      await flush();
      return accounts.profile(ctx.identity);
    }),
    createRoom: action.input(z.object({
      timeLimit: z.number().int().min(30).max(3600).default(300),
      difficulty: difficultySchema.nullable().default(null),
      rounds: z.number().int().min(1).max(10).default(1),
    }).strict()).mutation(({ input, ctx }) => {
      limits.check(`create:${ctx.identity.userId}`, 5, 60_000);
      limits.check(`create-ip:${ctx.ip ?? 'local'}`, 15, 60_000);
      return store.create({ ...input, name: ctx.profile.username }, ctx.identity.userId);
    }),
    joinRoom: action.input(roomInput).mutation(({ input, ctx }) => {
      limits.check(`join:${ctx.identity.userId}`, 20, 60_000);
      return store.join(input.roomId, ctx.profile.username, ctx.identity.userId);
    }),
    room: authenticated.input(roomInput).query(({ input, ctx }) => store.snapshot(input.roomId, ctx.identity.userId)),
    roomUpdates: t.procedure.input(roomInput.extend({ token: z.string().min(1).max(8192) })).subscription(async function* ({ input, signal, ctx }) {
      limits.check(`streams:${ctx.ip ?? 'local'}`, 120, 60_000);
      const identity = await accounts.verify(input.token);
      await accounts.profile(identity);
      let dirty = true;
      let revoked = false;
      let wake: (() => void) | undefined;
      let nextAuthCheck = Date.now() + 10_000;
      const notify = () => { dirty = true; wake?.(); };
      const invalidate = () => { revoked = true; notify(); };
      const stop = store.listen(input.roomId, identity.userId, notify);
      const timer = setInterval(() => wake?.(), 10_000);
      timer.unref();
      sessions.on(identity.sessionId, invalidate);
      signal?.addEventListener('abort', notify);
      try {
        while (!signal?.aborted) {
          if (!dirty) await new Promise<void>((resolve) => { wake = resolve; });
          wake = undefined;
          if (signal?.aborted) return;
          if (revoked) unauthorized('You signed in somewhere else.');
          if (Date.now() >= identity.expiresAt) unauthorized('Your session expired.');
          if (Date.now() >= nextAuthCheck) {
            await accounts.profile(identity);
            nextAuthCheck = Date.now() + 10_000;
          }
          if (!dirty) continue;
          dirty = false;
          yield store.snapshot(input.roomId, identity.userId);
        }
      } finally {
        clearInterval(timer);
        signal?.removeEventListener('abort', notify);
        sessions.off(identity.sessionId, invalidate);
        stop();
      }
    }),
    heartbeat: authenticated.input(roomInput).mutation(({ input, ctx }) => store.heartbeat(input.roomId, ctx.identity.userId)),
    start: action.input(roomInput).mutation(({ input, ctx }) => store.start(input.roomId, ctx.identity.userId)),
    restart: action.input(roomInput).mutation(({ input, ctx }) => store.restart(input.roomId, ctx.identity.userId)),
    skipBreak: action.input(roomInput).mutation(({ input, ctx }) => store.skipBreak(input.roomId, ctx.identity.userId)),
    lock: action.input(roomInput).mutation(({ input, ctx }) => store.lock(input.roomId, ctx.identity.userId)),
    resign: action.input(roomInput).mutation(({ input, ctx }) => store.resign(input.roomId, ctx.identity.userId)),
    leave: action.input(roomInput).mutation(({ input, ctx }) => store.leave(input.roomId, ctx.identity.userId)),
    kick: action.input(roomInput.extend({ userId: z.string().min(1).max(200) }))
      .mutation(({ input, ctx }) => store.kick(input.roomId, ctx.identity.userId, input.userId)),
    submit: action.input(roomInput.extend({ code: z.string().max(50_000).refine((code) => code.trim().length > 0, 'Enter a solution before submitting.') }))
      .mutation(async ({ input, ctx }) => {
        limits.check(`submit:${ctx.identity.userId}`, 15, 60_000);
        try {
          return await store.submit(input.roomId, ctx.identity.userId, input.code);
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          if (error instanceof RunnerShuttingDownError) {
            throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'The server is restarting. Submit again after reconnecting.' });
          }
          throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'The judge is busy. Try again shortly.' });
        }
      }),
    chat: action.input(roomInput.extend({ message: z.string().trim().min(1).max(200) }))
      .mutation(({ input, ctx }) => {
        limits.check(`chat:${ctx.identity.userId}`, 15, 10_000);
        return store.chat(input.roomId, ctx.identity.userId, input.message);
      }),
  });
}

export const problems = new ProblemRepository();
export const persistence = new Persistence();
export const rooms = new RoomStore((difficulty, previousId) => problems.pick(difficulty, previousId), undefined, undefined, {
  onEvent: (event) => persistence.enqueue(event),
});
export const appRouter = createRouter(rooms, undefined, () => persistence.flush());
export type AppRouter = typeof appRouter;
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RoomSnapshot = RouterOutputs['room'];
export type Submission = RouterOutputs['submit'];
