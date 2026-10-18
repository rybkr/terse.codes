/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api.js';
import schema from '../convex/schema.js';

const modules = import.meta.glob('../convex/**/*.ts');

function database() {
  return convexTest(schema, modules);
}

const secret = 'test-server-secret';

async function createUser(
  t: ReturnType<typeof database>,
  userId: string,
  username: string,
  sessionId = `${userId}-session`,
  sessionCreatedAt = 1,
) {
  return t.mutation(api.users.ensureSession, {
    secret,
    userId,
    username,
    sessionId,
    sessionCreatedAt,
  });
}

describe('durable user data', () => {
  beforeEach(() => vi.stubEnv('TERSE_SERVER_SECRET', secret));
  afterEach(() => vi.unstubAllEnvs());

  it('fails closed without the server secret and keeps usernames unique case insensitively', async () => {
    const t = database();
    await expect(t.mutation(api.users.ensureSession, {
      secret: 'wrong', userId: 'user-1', username: 'Dark_', sessionId: 'session-1', sessionCreatedAt: 1,
    })).rejects.toThrow('Unauthorized');
    await createUser(t, 'user-1', 'Dark_');
    await expect(createUser(t, 'user-2', 'dark_')).rejects.toThrow('already taken');
  });

  it('keeps an older login from reclaiming the active session and tombstones deleted accounts', async () => {
    const t = database();
    await createUser(t, 'user-1', 'Dark_', 'newer', 20);
    const stale = await createUser(t, 'user-1', 'Dark_', 'older', 10);
    expect(stale.active).toBe(false);
    await expect(t.query(api.users.requireSession, {
      secret, userId: 'user-1', sessionId: 'older',
    })).rejects.toThrow('no longer active');
    await t.mutation(api.users.deleteUser, { secret, userId: 'user-1' });
    await expect(createUser(t, 'user-1', 'Dark_', 'late', 30)).rejects.toThrow('unavailable');
    await t.mutation(api.users.deleteUser, { secret, userId: 'deleted-before-first-login' });
    await expect(createUser(t, 'deleted-before-first-login', 'Late_', 'late', 30)).rejects.toThrow('unavailable');
    await createUser(t, 'user-2', 'Dark_');
  });

  it('revokes only the matching active session and rejects calls without the server secret', async () => {
    const t = database();
    await createUser(t, 'user-1', 'Dark_', 'older', 10);
    await createUser(t, 'user-1', 'Dark_', 'newer', 20);
    await expect(t.mutation(api.users.revokeSession, {
      secret: 'wrong', userId: 'user-1', sessionId: 'newer',
    })).rejects.toThrow('Unauthorized');
    await t.mutation(api.users.revokeSession, { secret, userId: 'user-1', sessionId: 'older' });
    await expect(t.query(api.users.requireSession, {
      secret, userId: 'user-1', sessionId: 'newer',
    })).resolves.toMatchObject({ username: 'Dark_' });
    await t.mutation(api.users.revokeSession, { secret, userId: 'user-1', sessionId: 'newer' });
    await expect(t.query(api.users.requireSession, {
      secret, userId: 'user-1', sessionId: 'newer',
    })).rejects.toThrow('no longer active');
  });

  it('counts a solved problem once and keeps solo rounds out of competitive statistics', async () => {
    const t = database();
    await createUser(t, 'user-1', 'Dark_');
    const first = {
      secret, eventId: 'solo-1', userId: 'user-1', roundId: 'round-1', problemId: 'sum',
      competitive: false, solved: true, points: 90, position: 1, winner: false,
    };
    expect(await t.mutation(api.results.recordRound, first)).toEqual({ recorded: true });
    expect(await t.mutation(api.results.recordRound, first)).toEqual({ recorded: false });
    expect(await t.mutation(api.results.recordRound, {
      ...first, eventId: 'solo-2', roundId: 'round-2',
    })).toEqual({ recorded: true });
    const profile = await t.query(api.users.requireSession, {
      secret, userId: 'user-1', sessionId: 'user-1-session',
    });
    expect(profile).toMatchObject({
      solvedProblems: 1, careerPoints: 0, roundWins: 0, roundWinStreak: 0, bestRoundWinStreak: 0,
    });
  });

  it('counts accepted solves immediately and deduplicates them against the completed round', async () => {
    const t = database();
    await createUser(t, 'user-1', 'Dark_');
    const solve = { secret, userId: 'user-1', problemId: 'sum' };
    expect(await t.mutation(api.results.recordSolve, solve)).toEqual({ recorded: true });
    expect(await t.mutation(api.results.recordSolve, solve)).toEqual({ recorded: false });
    expect(await t.mutation(api.results.recordRound, {
      ...solve, eventId: 'solve-round', roundId: 'round-1', competitive: false,
      solved: true, points: 0, position: 1, winner: false,
    })).toEqual({ recorded: true });
    const profile = await t.query(api.users.requireSession, {
      secret, userId: 'user-1', sessionId: 'user-1-session',
    });
    expect(profile.solvedProblems).toBe(1);
  });

  it('applies round streaks and tournament ratings once, with no win for a shared high score', async () => {
    const t = database();
    await createUser(t, 'user-1', 'Dark_');
    await createUser(t, 'user-2', 'Chat_');
    await t.mutation(api.results.recordRound, {
      secret, eventId: 'r1-u1', userId: 'user-1', roundId: 'round-1', problemId: 'sum',
      competitive: true, solved: true, points: 12, position: 1, winner: true,
    });
    await t.mutation(api.results.recordRound, {
      secret, eventId: 'r1-u2', userId: 'user-2', roundId: 'round-1', problemId: 'sum',
      competitive: true, solved: false, points: 0, position: 2, winner: false,
    });
    const ratings = await t.mutation(api.stats.settleTournament, {
      secret, eventId: 't1-final', tournamentId: 'tournament-1', final: true, departingUserIds: [],
      participants: [
        { userId: 'user-1', initialRating: 1000, score: 12 },
        { userId: 'user-2', initialRating: 1000, score: 12 },
      ],
    });
    expect(ratings.settled).toBe(true);
    expect(ratings.ratingChanges).toEqual([]);
    await expect(t.mutation(api.stats.settleTournament, {
      secret, eventId: 't1-final-retry', tournamentId: 'tournament-1', final: true, departingUserIds: [],
      participants: [
        { userId: 'user-1', initialRating: 1000, score: 12 },
        { userId: 'user-2', initialRating: 1000, score: 12 },
      ],
    })).resolves.toMatchObject({ settled: false });
    const winner = await t.query(api.users.requireSession, {
      secret, userId: 'user-1', sessionId: 'user-1-session',
    });
    const other = await t.query(api.users.requireSession, {
      secret, userId: 'user-2', sessionId: 'user-2-session',
    });
    expect(winner).toMatchObject({ roundWins: 1, roundWinStreak: 1, tournamentWins: 0, rating: 1000 });
    expect(other).toMatchObject({ roundWins: 0, roundWinStreak: 0, tournamentWins: 0, rating: 1000 });
  });

  it('settles a departing player against the remaining field once, then settles the final pair', async () => {
    const t = database();
    await createUser(t, 'user-1', 'Dark_');
    await createUser(t, 'user-2', 'Chat_');
    await createUser(t, 'user-3', 'Code_');
    const participants = [
      { userId: 'user-1', initialRating: 1000, score: 10 },
      { userId: 'user-2', initialRating: 1000, score: 0 },
      { userId: 'user-3', initialRating: 1000, score: 5 },
    ];
    const departure = {
      secret, eventId: 't2-departure', tournamentId: 'tournament-2', participants,
      departingUserIds: ['user-1'], final: false,
    };
    expect(await t.mutation(api.stats.settleTournament, departure)).toMatchObject({ settled: true });
    expect(await t.mutation(api.stats.settleTournament, {
      ...departure, eventId: 't2-departure-retry',
    })).toMatchObject({ settled: true });
    expect(await t.mutation(api.stats.settleTournament, {
      secret, eventId: 't2-final', tournamentId: 'tournament-2', participants,
      departingUserIds: [], final: true,
    })).toMatchObject({ settled: true });
    const profiles = await t.query(api.users.getProfiles, {
      secret, userIds: ['user-1', 'user-2', 'user-3'],
    });
    expect(profiles.map((profile) => profile.rating).reduce((sum, rating) => sum + rating, 0)).toBeCloseTo(3000);
    expect(profiles.find((profile) => profile.userId === 'user-1')?.tournamentWins).toBe(1);
  });

  it('does not award tournament stats for solo games or tournaments with no points', async () => {
    const t = database();
    await createUser(t, 'user-1', 'Dark_');
    await createUser(t, 'user-2', 'Chat_');
    expect(await t.mutation(api.stats.settleTournament, {
      secret, eventId: 'solo-final', tournamentId: 'solo', final: true, departingUserIds: [],
      participants: [{ userId: 'user-1', initialRating: 1000, score: 0 }],
    })).toMatchObject({ settled: true, ratingChanges: [] });
    await t.mutation(api.stats.settleTournament, {
      secret, eventId: 'zero-final', tournamentId: 'zero', final: true, departingUserIds: [],
      participants: [
        { userId: 'user-1', initialRating: 1000, score: 0 },
        { userId: 'user-2', initialRating: 1000, score: 0 },
      ],
    });
    const profiles = await t.query(api.users.getProfiles, {
      secret, userIds: ['user-1', 'user-2'],
    });
    expect(profiles).toMatchObject([
      { userId: 'user-1', rating: 1000, tournamentWins: 0, tournamentWinStreak: 0 },
      { userId: 'user-2', rating: 1000, tournamentWins: 0, tournamentWinStreak: 0 },
    ]);
  });

  it('retains deleted users’ numeric results without updating their profile counters', async () => {
    const t = database();
    await createUser(t, 'user-1', 'Dark_');
    await createUser(t, 'user-2', 'Chat_');
    await t.mutation(api.users.deleteUser, { secret, userId: 'user-1' });
    expect(await t.mutation(api.results.recordSolve, {
      secret, userId: 'user-1', problemId: 'sum',
    })).toEqual({ recorded: false });
    await t.mutation(api.results.recordRound, {
      secret, eventId: 'deleted-round', userId: 'user-1', roundId: 'round-1', problemId: 'sum',
      competitive: true, solved: true, points: 12, position: 1, winner: true,
    });
    await t.mutation(api.stats.settleTournament, {
      secret, eventId: 'deleted-final', tournamentId: 'deleted-tournament', final: true, departingUserIds: [],
      participants: [
        { userId: 'user-1', initialRating: 1000, score: 12 },
        { userId: 'user-2', initialRating: 1000, score: 0 },
      ],
    });
    const stored = await t.run(async (ctx) => ({
      user: await ctx.db.query('users').withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', 'user-1')).unique(),
      results: await ctx.db.query('roundResults').withIndex('by_event_id', (q) => q.eq('eventId', 'deleted-round')).unique(),
      solvedProblem: await ctx.db.query('solvedProblems').withIndex('by_user_problem', (q) => q.eq('userId', 'user-1').eq('problemId', 'sum')).unique(),
    }));
    expect(stored.user).toMatchObject({
      deleted: true, roundWins: 0, careerPoints: 0, solvedProblems: 0, rating: 1000, tournamentWins: 0,
    });
    expect(stored.results).toMatchObject({ userId: 'user-1', points: 12, winner: true });
    expect(stored.solvedProblem).toBeNull();
    await expect(t.query(api.users.requireSession, {
      secret, userId: 'user-2', sessionId: 'user-2-session',
    })).resolves.toMatchObject({ rating: 984, tournamentWins: 0, tournamentWinStreak: 0 });
  });
});
