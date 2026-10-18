import { v } from 'convex/values';
import { mutation } from './_generated/server.js';
import type { Doc } from './_generated/dataModel.js';
import { assertServerSecret } from './auth.js';

const participantValidator = v.object({ userId: v.string(), initialRating: v.number(), score: v.number() });
const ratingChangeValidator = v.object({ userId: v.string(), rating: v.number() });

function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

function resultScore(score: number, opponentScore: number): number {
  if (score === opponentScore) return 0.5;
  return score > opponentScore ? 1 : 0;
}

export const settleTournament = mutation({
  args: {
    secret: v.string(),
    eventId: v.string(),
    tournamentId: v.string(),
    participants: v.array(participantValidator),
    departingUserIds: v.array(v.string()),
    final: v.boolean(),
  },
  returns: v.object({ settled: v.boolean(), ratingChanges: v.array(ratingChangeValidator) }),
  handler: async (ctx, args) => {
    assertServerSecret(args.secret);
    if (args.participants.length < 1 || args.participants.length > 8) {
      throw new Error('Tournament must have between one and eight participants.');
    }
    const participantIds = new Set<string>();
    for (const participant of args.participants) {
      if (!Number.isFinite(participant.initialRating) || !Number.isFinite(participant.score) || participant.score < 0) {
        throw new Error('Invalid tournament participant.');
      }
      if (participantIds.has(participant.userId)) throw new Error('Duplicate tournament participant.');
      participantIds.add(participant.userId);
    }
    for (const userId of args.departingUserIds) {
      if (!participantIds.has(userId)) throw new Error('Departing user is not in the tournament.');
    }

    const duplicateEvent = await ctx.db.query('tournamentSettlementEvents')
      .withIndex('by_event_id', (q) => q.eq('eventId', args.eventId))
      .unique();
    if (duplicateEvent !== null) return { settled: false, ratingChanges: [] };
    const finalAlreadySaved = await ctx.db.query('tournamentFinals')
      .withIndex('by_tournament_id', (q) => q.eq('tournamentId', args.tournamentId))
      .unique();
    if (finalAlreadySaved !== null) return { settled: false, ratingChanges: [] };

    type StoredParticipant = Doc<'tournamentParticipants'>;
    const storedParticipants = new Map<string, StoredParticipant>();
    for (const participant of args.participants) {
      const stored = await ctx.db.query('tournamentParticipants')
        .withIndex('by_tournament_user', (q) => q.eq('tournamentId', args.tournamentId).eq('userId', participant.userId))
        .unique();
      if (stored === null) {
        const id = await ctx.db.insert('tournamentParticipants', {
          tournamentId: args.tournamentId,
          userId: participant.userId,
          initialRating: participant.initialRating,
          score: participant.score,
          departed: false,
          opponentCount: args.participants.length - 1,
        });
        const inserted = await ctx.db.get(id);
        if (inserted === null) throw new Error('Unable to store tournament participant.');
        storedParticipants.set(participant.userId, inserted);
      } else {
        if (stored.initialRating !== participant.initialRating) throw new Error('Tournament initial ratings are immutable.');
        await ctx.db.patch(stored._id, { score: participant.score });
        storedParticipants.set(participant.userId, { ...stored, score: participant.score });
      }
    }
    await ctx.db.insert('tournamentSettlementEvents', { eventId: args.eventId, tournamentId: args.tournamentId });
    if (args.participants.length === 1) {
      if (args.final) await ctx.db.insert('tournamentFinals', { tournamentId: args.tournamentId });
      return { settled: true, ratingChanges: [] };
    }

    const departing = new Set(args.departingUserIds);
    const ratingDeltas = new Map<string, number>();
    const settledPairs = new Set<string>();
    const pendingPairs: Array<{ tournamentId: string; userA: string; userB: string; deltaA: number }> = [];

    const settlePair = async (first: StoredParticipant, second: StoredParticipant) => {
      const userA = first.userId < second.userId ? first : second;
      const userB = userA.userId === first.userId ? second : first;
      const pairKey = JSON.stringify([userA.userId, userB.userId]);
      if (settledPairs.has(pairKey)) return;
      const existing = await ctx.db.query('tournamentPairs')
        .withIndex('by_tournament_pair', (q) => q.eq('tournamentId', args.tournamentId).eq('userA', userA.userId).eq('userB', userB.userId))
        .unique();
      if (existing !== null) {
        settledPairs.add(pairKey);
        return;
      }

      let deltaForA = 0;
      if (userA.score !== userB.score) {
        const outcome = resultScore(userA.score, userB.score);
        const opponentCount = userA.opponentCount;
        deltaForA = (32 / Math.max(1, opponentCount)) * (outcome - expectedScore(userA.initialRating, userB.initialRating));
        ratingDeltas.set(userA.userId, (ratingDeltas.get(userA.userId) ?? 0) + deltaForA);
        ratingDeltas.set(userB.userId, (ratingDeltas.get(userB.userId) ?? 0) - deltaForA);
      }
      pendingPairs.push({ tournamentId: args.tournamentId, userA: userA.userId, userB: userB.userId, deltaA: deltaForA });
      settledPairs.add(pairKey);
    };

    for (const departingUserId of args.departingUserIds) {
      const leaving = storedParticipants.get(departingUserId);
      if (leaving === undefined || leaving.departed) continue;
      for (const opponent of storedParticipants.values()) {
        if (opponent.userId !== departingUserId && (departing.has(opponent.userId) || !opponent.departed)) {
          await settlePair(leaving, opponent);
        }
      }
    }
    for (const departingUserId of args.departingUserIds) {
      const row = storedParticipants.get(departingUserId);
      if (row !== undefined) {
        await ctx.db.patch(row._id, { departed: true });
        storedParticipants.set(departingUserId, { ...row, departed: true });
      }
    }

    if (args.final) {
      const remaining = [...storedParticipants.values()].filter((participant) => !participant.departed);
      for (let leftIndex = 0; leftIndex < remaining.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < remaining.length; rightIndex += 1) {
          const left = remaining[leftIndex];
          const right = remaining[rightIndex];
          if (left !== undefined && right !== undefined) await settlePair(left, right);
        }
      }
      await ctx.db.insert('tournamentFinals', { tournamentId: args.tournamentId });
      const allParticipants = [...storedParticipants.values()];
      const highScore = Math.max(...allParticipants.map((participant) => participant.score));
      const winners = highScore > 0 ? allParticipants.filter((participant) => participant.score === highScore) : [];
      const winnerId = winners.length === 1 ? winners[0]?.userId : undefined;
      for (const participant of allParticipants) {
        if (allParticipants.length < 2) continue;
        const user = await ctx.db.query('users')
          .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', participant.userId))
          .unique();
        if (user === null || user.deleted) continue;
        const won = participant.userId === winnerId;
        const streak = won ? user.tournamentWinStreak + 1 : 0;
        await ctx.db.patch(user._id, {
          tournamentWins: user.tournamentWins + (won ? 1 : 0),
          tournamentWinStreak: streak,
          bestTournamentWinStreak: Math.max(user.bestTournamentWinStreak, streak),
        });
      }
    }

    for (const pair of pendingPairs) await ctx.db.insert('tournamentPairs', pair);
    const ratingChanges: Array<{ userId: string; rating: number }> = [];
    for (const [userId, delta] of ratingDeltas) {
      const user = await ctx.db.query('users')
        .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', userId))
        .unique();
      if (user === null || user.deleted) continue;
      const rating = user.rating + delta;
      await ctx.db.patch(user._id, { rating });
      ratingChanges.push({ userId, rating });
    }
    return { settled: true, ratingChanges };
  },
});
