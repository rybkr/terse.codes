import { v } from 'convex/values';
import { mutation, query } from './_generated/server.js';
import { assertServerSecret } from './auth.js';

const publicProfileValidator = v.object({
  userId: v.string(),
  username: v.string(),
  rating: v.number(),
  tournamentWins: v.number(),
  roundWins: v.number(),
  careerPoints: v.number(),
  solvedProblems: v.number(),
  roundWinStreak: v.number(),
  bestRoundWinStreak: v.number(),
  tournamentWinStreak: v.number(),
  bestTournamentWinStreak: v.number(),
});

function publicProfile(user: {
  clerkUserId: string;
  username?: string;
  deleted: boolean;
  rating: number;
  tournamentWins: number;
  roundWins: number;
  careerPoints: number;
  solvedProblems: number;
  roundWinStreak: number;
  bestRoundWinStreak: number;
  tournamentWinStreak: number;
  bestTournamentWinStreak: number;
}): {
  userId: string;
  username: string;
  rating: number;
  tournamentWins: number;
  roundWins: number;
  careerPoints: number;
  solvedProblems: number;
  roundWinStreak: number;
  bestRoundWinStreak: number;
  tournamentWinStreak: number;
  bestTournamentWinStreak: number;
} {
  if (user.deleted || user.username === undefined) throw new Error('User account is unavailable.');
  return {
    userId: user.clerkUserId,
    username: user.username,
    rating: user.rating,
    tournamentWins: user.tournamentWins,
    roundWins: user.roundWins,
    careerPoints: user.careerPoints,
    solvedProblems: user.solvedProblems,
    roundWinStreak: user.roundWinStreak,
    bestRoundWinStreak: user.bestRoundWinStreak,
    tournamentWinStreak: user.tournamentWinStreak,
    bestTournamentWinStreak: user.bestTournamentWinStreak,
  };
}

function validUsername(username: string): boolean {
  return /^[A-Za-z0-9_]{4,12}$/.test(username);
}

export const ensureSession = mutation({
  args: {
    secret: v.string(),
    userId: v.string(),
    username: v.string(),
    sessionId: v.string(),
    sessionCreatedAt: v.number(),
  },
  returns: v.object({
    profile: publicProfileValidator,
    active: v.boolean(),
    replacedSessionId: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    assertServerSecret(args.secret);
    if (!validUsername(args.username) || !Number.isFinite(args.sessionCreatedAt)) {
      throw new Error('Invalid verified account data.');
    }

    const user = await ctx.db.query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', args.userId))
      .unique();
    const usernameKey = args.username.toLowerCase();

    if (user === null) {
      const claimed = await ctx.db.query('users')
        .withIndex('by_username_key', (q) => q.eq('usernameKey', usernameKey))
        .first();
      if (claimed !== null) throw new Error('Username is already taken.');
      const id = await ctx.db.insert('users', {
        clerkUserId: args.userId,
        username: args.username,
        usernameKey,
        deleted: false,
        activeSessionId: args.sessionId,
        sessionCreatedAt: args.sessionCreatedAt,
        rating: 1000,
        tournamentWins: 0,
        roundWins: 0,
        careerPoints: 0,
        solvedProblems: 0,
        roundWinStreak: 0,
        bestRoundWinStreak: 0,
        tournamentWinStreak: 0,
        bestTournamentWinStreak: 0,
      });
      const created = await ctx.db.get(id);
      if (created === null) throw new Error('Unable to create user account.');
      return { profile: publicProfile(created), active: true };
    }

    if (user.deleted) throw new Error('User account is unavailable.');
    if (user.username !== args.username) throw new Error('Username is immutable.');
    const currentSessionId = user.activeSessionId;
    const currentCreatedAt = user.sessionCreatedAt ?? Number.NEGATIVE_INFINITY;
    const sameSession = currentSessionId === args.sessionId;
    const incomingWins = args.sessionCreatedAt > currentCreatedAt
      || (args.sessionCreatedAt === currentCreatedAt && (currentSessionId === undefined || args.sessionId > currentSessionId));
    if (!sameSession && !incomingWins) {
      return { profile: publicProfile(user), active: false };
    }
    if (sameSession) return { profile: publicProfile(user), active: true };

    await ctx.db.patch(user._id, {
      activeSessionId: args.sessionId,
      sessionCreatedAt: args.sessionCreatedAt,
    });
    return {
      profile: publicProfile(user),
      active: true,
      ...(currentSessionId === undefined ? {} : { replacedSessionId: currentSessionId }),
    };
  },
});

export const requireSession = query({
  args: { secret: v.string(), userId: v.string(), sessionId: v.string() },
  returns: publicProfileValidator,
  handler: async (ctx, args) => {
    assertServerSecret(args.secret);
    const user = await ctx.db.query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', args.userId))
      .unique();
    if (user === null || user.deleted || user.activeSessionId !== args.sessionId) {
      throw new Error('Session is no longer active.');
    }
    return publicProfile(user);
  },
});

export const revokeSession = mutation({
  args: { secret: v.string(), userId: v.string(), sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertServerSecret(args.secret);
    const user = await ctx.db.query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', args.userId))
      .unique();
    if (user !== null && user.activeSessionId === args.sessionId) {
      await ctx.db.patch(user._id, { activeSessionId: undefined });
    }
    return null;
  },
});

export const getProfiles = query({
  args: { secret: v.string(), userIds: v.array(v.string()) },
  returns: v.array(publicProfileValidator),
  handler: async (ctx, args) => {
    assertServerSecret(args.secret);
    const profiles = [];
    for (const userId of args.userIds) {
      const user = await ctx.db.query('users')
        .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', userId))
        .unique();
      if (user !== null && !user.deleted && user.username !== undefined) profiles.push(publicProfile(user));
    }
    return profiles;
  },
});

export const deleteUser = mutation({
  args: { secret: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertServerSecret(args.secret);
    const user = await ctx.db.query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', args.userId))
      .unique();
    if (user === null) {
      await ctx.db.insert('users', {
        clerkUserId: args.userId,
        deleted: true,
        rating: 1000,
        tournamentWins: 0,
        roundWins: 0,
        careerPoints: 0,
        solvedProblems: 0,
        roundWinStreak: 0,
        bestRoundWinStreak: 0,
        tournamentWinStreak: 0,
        bestTournamentWinStreak: 0,
      });
    } else if (!user.deleted) {
      await ctx.db.patch(user._id, {
        username: undefined,
        usernameKey: undefined,
        deleted: true,
        activeSessionId: undefined,
        sessionCreatedAt: undefined,
      });
    }
    return null;
  },
});
