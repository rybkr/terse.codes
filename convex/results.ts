import { v } from 'convex/values';
import { mutation } from './_generated/server.js';
import { assertServerSecret } from './auth.js';

export const recordSolve = mutation({
  args: { secret: v.string(), userId: v.string(), problemId: v.string() },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, args) => {
    assertServerSecret(args.secret);
    if (!args.userId || !args.problemId) throw new Error('Invalid solve identity.');
    const user = await ctx.db.query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', args.userId))
      .unique();
    if (user === null || user.deleted) return { recorded: false };

    const prior = await ctx.db.query('solvedProblems')
      .withIndex('by_user_problem', (q) => q.eq('userId', args.userId).eq('problemId', args.problemId))
      .unique();
    if (prior !== null) return { recorded: false };

    await ctx.db.insert('solvedProblems', { userId: args.userId, problemId: args.problemId });
    await ctx.db.patch(user._id, { solvedProblems: user.solvedProblems + 1 });
    return { recorded: true };
  },
});

export const recordRound = mutation({
  args: {
    secret: v.string(),
    eventId: v.string(),
    userId: v.string(),
    roundId: v.string(),
    problemId: v.string(),
    competitive: v.boolean(),
    solved: v.boolean(),
    points: v.number(),
    position: v.number(),
    winner: v.boolean(),
  },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, args) => {
    assertServerSecret(args.secret);
    if (!Number.isFinite(args.points) || args.points < 0 || !Number.isSafeInteger(args.position) || args.position < 1) {
      throw new Error('Invalid round result.');
    }
    if (!args.eventId || !args.userId || !args.roundId || !args.problemId) {
      throw new Error('Invalid round result identity.');
    }
    if (args.winner && (!args.competitive || !args.solved || args.position !== 1)) {
      throw new Error('Invalid round winner.');
    }

    const prior = await ctx.db.query('roundResults')
      .withIndex('by_event_id', (q) => q.eq('eventId', args.eventId))
      .unique();
    if (prior !== null) return { recorded: false };

    await ctx.db.insert('roundResults', {
      eventId: args.eventId,
      userId: args.userId,
      roundId: args.roundId,
      problemId: args.problemId,
      competitive: args.competitive,
      solved: args.solved,
      points: args.points,
      position: args.position,
      winner: args.winner,
    });

    const user = await ctx.db.query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', args.userId))
      .unique();
    if (user !== null && !user.deleted) {
      const solvedProblem = await ctx.db.query('solvedProblems')
        .withIndex('by_user_problem', (q) => q.eq('userId', args.userId).eq('problemId', args.problemId))
        .unique();
      const shouldCountSolved = args.solved && solvedProblem === null;
      if (shouldCountSolved) {
        await ctx.db.insert('solvedProblems', { userId: args.userId, problemId: args.problemId });
      }
      const won = args.competitive && args.winner;
      const nextStreak = args.competitive ? (won ? user.roundWinStreak + 1 : 0) : user.roundWinStreak;
      if (args.competitive || shouldCountSolved) {
        await ctx.db.patch(user._id, {
          ...(args.competitive ? {
            careerPoints: user.careerPoints + args.points,
            roundWins: user.roundWins + (won ? 1 : 0),
            roundWinStreak: nextStreak,
            bestRoundWinStreak: Math.max(user.bestRoundWinStreak, nextStreak),
          } : {}),
          solvedProblems: user.solvedProblems + (shouldCountSolved ? 1 : 0),
        });
      }
    }
    return { recorded: true };
  },
});
