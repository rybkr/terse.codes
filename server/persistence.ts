import { api } from '../convex/_generated/api.js';
import { databaseClient } from './accounts.js';
import type { RoomEvent } from './rooms.js';

export class Persistence {
  private queue: RoomEvent[] = [];
  private running: Promise<void> | null = null;
  private ratings = new Map<string, Map<string, number>>();
  private lastError = false;

  enqueue(event: RoomEvent) {
    this.queue.push(event);
  }

  get healthy() {
    return !this.lastError;
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private async drain() {
    while (this.queue.length) {
      const event = this.queue[0];
      if (!event) return;
      try {
        await this.save(event);
        this.queue.shift();
        this.lastError = false;
      } catch (error) {
        this.lastError = true;
        throw error;
      }
    }
  }

  private async save(event: RoomEvent) {
    const { client, secret } = databaseClient();
    if (event.type === 'problem_solved') {
      await client.mutation(api.results.recordSolve, { secret, userId: event.userId, problemId: event.problemId });
      return;
    }
    if (event.type === 'tournament_started') {
      const profiles = await client.query(api.users.getProfiles, { secret, userIds: event.userIds });
      this.ratings.set(event.tournamentId, new Map(profiles.map((profile) => [profile.userId, profile.rating])));
      return;
    }
    if (event.type === 'round_finished') {
      const first = event.results.filter((row) => row.position === 1 && row.solved && !row.departed);
      await Promise.all(event.results.map((row) => client.mutation(api.results.recordRound, {
        secret, eventId: `${event.roundId}:${row.userId}`, userId: row.userId,
        roundId: event.roundId, problemId: event.problemId, competitive: event.competitive && !row.departed,
        solved: row.solved, points: row.points, position: row.position,
        winner: first.length === 1 && first[0]?.userId === row.userId && event.competitive,
      })));
      return;
    }
    const ratings = this.ratings.get(event.tournamentId);
    if (!ratings) throw new Error('Tournament rating snapshot is unavailable.');
    const final = event.reason !== 'departed' || event.remainingUserIds.length === 0;
    await client.mutation(api.stats.settleTournament, {
      secret,
      eventId: `${event.tournamentId}:${event.reason}:${event.departedUserIds.join(':')}`,
      tournamentId: event.tournamentId,
      participants: event.completedRoundScores.map((row) => ({
        userId: row.userId, score: row.points, initialRating: ratings.get(row.userId) ?? 1000,
      })),
      departingUserIds: event.departedUserIds,
      final,
    });
    if (final) this.ratings.delete(event.tournamentId);
  }
}
