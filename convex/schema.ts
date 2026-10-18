import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  users: defineTable({
    clerkUserId: v.string(),
    username: v.optional(v.string()),
    usernameKey: v.optional(v.string()),
    deleted: v.boolean(),
    activeSessionId: v.optional(v.string()),
    sessionCreatedAt: v.optional(v.number()),
    rating: v.number(),
    tournamentWins: v.number(),
    roundWins: v.number(),
    careerPoints: v.number(),
    solvedProblems: v.number(),
    roundWinStreak: v.number(),
    bestRoundWinStreak: v.number(),
    tournamentWinStreak: v.number(),
    bestTournamentWinStreak: v.number(),
  })
    .index('by_clerk_user_id', ['clerkUserId'])
    .index('by_username_key', ['usernameKey']),
  solvedProblems: defineTable({ userId: v.string(), problemId: v.string() })
    .index('by_user_problem', ['userId', 'problemId']),
  roundResults: defineTable({
    eventId: v.string(),
    userId: v.string(),
    roundId: v.string(),
    problemId: v.string(),
    competitive: v.boolean(),
    solved: v.boolean(),
    points: v.number(),
    position: v.number(),
    winner: v.boolean(),
  }).index('by_event_id', ['eventId']),
  tournamentParticipants: defineTable({
    tournamentId: v.string(),
    userId: v.string(),
    initialRating: v.number(),
    score: v.number(),
    departed: v.boolean(),
    opponentCount: v.number(),
  }).index('by_tournament_user', ['tournamentId', 'userId']),
  tournamentPairs: defineTable({
    tournamentId: v.string(),
    userA: v.string(),
    userB: v.string(),
    deltaA: v.number(),
  }).index('by_tournament_pair', ['tournamentId', 'userA', 'userB']),
  tournamentSettlementEvents: defineTable({ eventId: v.string(), tournamentId: v.string() })
    .index('by_event_id', ['eventId']),
  tournamentFinals: defineTable({ tournamentId: v.string() })
    .index('by_tournament_id', ['tournamentId']),
});
