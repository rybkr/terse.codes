import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TRPCError } from '@trpc/server';
import { publicProblem, type Difficulty, type Problem } from './problems.js';
import { runCode, type SubmissionResult } from './runner.js';
import { roundPoints } from './scoring.js';

export type Submission = SubmissionResult & { submitTime: number };

interface Player {
  userId: string;
  name: string;
  joinedAt: number;
  generation: number;
  streams: number;
  offlineSince: number | null;
  lastHeartbeat: number;
  submission: Submission | null;
  best: Submission | null;
  bestCode: string | null;
  solveRecorded: boolean;
  lockedAt: number | null;
  resigned: boolean;
  pending: boolean;
}

export interface RoundResult {
  userId: string;
  name: string;
  charCount: number | null;
  solved: boolean;
  solveTime: number | null;
  position: number;
  points: number;
  departed: boolean;
}

interface CompletedRound {
  roundId: string;
  problemId: string;
  competitive: boolean;
  results: RoundResult[];
}

interface Room {
  id: string;
  tournamentId: string;
  hostId: string | null;
  state: 'lobby' | 'playing' | 'finished';
  players: Map<string, Player>;
  roundRoster: Map<string, Player>;
  departedRoundUsers: Set<string>;
  banned: Set<string>;
  timeLimit: number;
  difficulty: Difficulty | null;
  totalRounds: number;
  currentRound: number;
  roundId: number;
  tournamentStarted: boolean;
  problem: Problem | null;
  lastProblemId?: string;
  startedAt: number;
  breakUntil: number | null;
  epoch: number;
  messages: { id: number; senderId: string; sender: string; message: string }[];
  messageId: number;
  events: EventEmitter;
  tournamentRounds: CompletedRound[];
  tournamentPoints: Map<string, number>;
  participants: Map<string, string>;
  departureReported: Set<string>;
  settlementComplete: boolean;
}

export interface RoomSettings {
  name: string;
  timeLimit: number;
  difficulty: Difficulty | null;
  rounds: number;
}

export type RoomEvent =
  | {
      type: 'problem_solved';
      userId: string;
      problemId: string;
      tournamentId: string;
      roundId: string;
    }
  | {
      type: 'tournament_started';
      roomId: string;
      tournamentId: string;
      userIds: string[];
    }
  | {
      type: 'round_finished';
      roomId: string;
      tournamentId: string;
      roundId: string;
      round: number;
      problemId: string;
      competitive: boolean;
      durationSeconds: number;
      results: RoundResult[];
    }
  | {
      type: 'tournament_settled';
      roomId: string;
      tournamentId: string;
      reason: 'completed' | 'departed' | 'restarted';
      completedRoundScores: { userId: string; points: number }[];
      departedUserIds: string[];
      remainingUserIds: string[];
    };

export interface RoomStoreOptions {
  onEvent?: (event: RoomEvent) => void;
}

const AWAY_AFTER_MS = 30_000;
const RUNNER_TIMEOUT_MS = 600_000;

function reject(message: string, code: 'BAD_REQUEST' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'TOO_MANY_REQUESTS' = 'BAD_REQUEST'): never {
  throw new TRPCError({ code, message });
}

function opaqueId(): string {
  return randomBytes(18).toString('base64url');
}

function tournamentId(): string {
  return randomBytes(16).toString('hex');
}

function freshPlayer(userId: string, name: string, now: number, generation: number): Player {
  return {
    userId, name, joinedAt: now, generation, streams: 0, offlineSince: now, lastHeartbeat: now,
    submission: null, best: null, bestCode: null, solveRecorded: false, lockedAt: null, resigned: false, pending: false,
  };
}

function resetRound(player: Player): void {
  player.submission = null;
  player.best = null;
  player.bestCode = null;
  player.solveRecorded = false;
  player.lockedAt = null;
  player.resigned = false;
  player.pending = false;
}

function better(submission: Submission, previous: Submission): boolean {
  if (submission.solved !== previous.solved) return submission.solved;
  if (submission.solved) return submission.charCount < previous.charCount;
  return submission.passed > previous.passed;
}

function cmpNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rankCompare(left: Player, right: Player): number {
  const a = left.best;
  const b = right.best;
  const solved = Number(b?.solved ?? false) - Number(a?.solved ?? false);
  if (solved !== 0) return solved;
  if (a?.solved && b?.solved) {
    const length = cmpNumber(a.charCount, b.charCount);
    if (length !== 0) return length;
  } else {
    const passed = cmpNumber(b?.passed ?? 0, a?.passed ?? 0);
    if (passed !== 0) return passed;
  }

  if (left.lockedAt !== null && right.lockedAt !== null) return cmpNumber(left.lockedAt, right.lockedAt);
  if (left.lockedAt !== null) return -1;
  if (right.lockedAt !== null) return 1;
  return cmpNumber(a?.submitTime ?? Infinity, b?.submitTime ?? Infinity);
}

export class RoomStore {
  private rooms = new Map<string, Room>();
  private memberships = new Map<string, string>();
  private generation = 0;

  constructor(
    private pickProblem: (difficulty: Difficulty | null, previousId?: string) => Problem,
    private execute: typeof runCode = runCode,
    private now: () => number = Date.now,
    private options: RoomStoreOptions = {},
  ) {}

  create(settings: RoomSettings, userId: string) {
    this.tick();
    if (this.memberships.has(userId)) reject('Leave your current room before creating another one.');
    if (this.rooms.size >= 500) reject('Room capacity reached. Try again later.', 'TOO_MANY_REQUESTS');
    let id = opaqueId();
    while (this.rooms.has(id)) id = opaqueId();
    const player = freshPlayer(userId, settings.name, this.now(), ++this.generation);
    const room: Room = {
      id, tournamentId: tournamentId(), hostId: userId, state: 'lobby', players: new Map([[userId, player]]),
      roundRoster: new Map(), departedRoundUsers: new Set(), banned: new Set(), timeLimit: settings.timeLimit, difficulty: settings.difficulty,
      totalRounds: settings.rounds, currentRound: 0, roundId: 0, tournamentStarted: false, problem: null, startedAt: 0,
      breakUntil: null, epoch: 0, messages: [], messageId: 0,
      events: new EventEmitter(), tournamentRounds: [], tournamentPoints: new Map(), participants: new Map(),
      departureReported: new Set(), settlementComplete: false,
    };
    room.events.setMaxListeners(100);
    this.rooms.set(id, room);
    this.memberships.set(userId, id);
    return { roomId: id, name: settings.name };
  }

  join(roomId: string, name: string, userId: string) {
    this.tick();
    const room = this.get(roomId);
    if (room.banned.has(userId)) reject('You were removed from this room.', 'FORBIDDEN');
    const existing = room.players.get(userId);
    if (existing) return { roomId: room.id, name: existing.name };
    if (this.memberships.has(userId)) reject('You are already in another room.');
    if (room.state !== 'lobby') reject('This game has already started.');
    if (room.players.size >= 8) reject('This room is full.');
    if ([...room.players.values()].some((player) => player.name === name)) reject('This name is already taken.');
    const player = freshPlayer(userId, name, this.now(), ++this.generation);
    room.players.set(userId, player);
    this.memberships.set(userId, room.id);
    this.emit(room);
    return { roomId: room.id, name };
  }

  currentRoom(userId: string): string | null {
    this.tick();
    return this.memberships.get(userId) ?? null;
  }

  private get(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) reject('Room not found.', 'NOT_FOUND');
    return room;
  }

  private authenticate(roomId: string, userId: string | undefined) {
    const room = this.get(roomId);
    if (!userId || room.banned.has(userId)) reject('Rejoin the room to continue.', 'UNAUTHORIZED');
    const player = room.players.get(userId);
    if (!player) reject('Rejoin the room to continue.', 'UNAUTHORIZED');
    return { room, player };
  }

  private host(room: Room, userId: string | undefined) {
    if (userId !== room.hostId) reject('Only the host can do this.', 'FORBIDDEN');
  }

  private emit(room: Room) {
    room.events.emit('update');
  }

  private report(event: RoomEvent) {
    this.options.onEvent?.(event);
  }

  private away(player: Player): boolean {
    const disconnectedAt = player.offlineSince;
    return (player.streams > 0 && this.now() - player.lastHeartbeat >= AWAY_AFTER_MS)
      || (player.streams === 0 && disconnectedAt !== null && this.now() - disconnectedAt >= AWAY_AFTER_MS);
  }

  private online(player: Player): boolean {
    return player.streams > 0 && !this.away(player);
  }

  private everyoneDone(room: Room) {
    return [...room.roundRoster.values()].every((player) => player.resigned || player.lockedAt !== null || this.away(player));
  }

  private rank(room: Room) {
    const compare = (left: Player, right: Player) => Number(room.departedRoundUsers.has(left.userId))
      - Number(room.departedRoundUsers.has(right.userId)) || rankCompare(left, right);
    const ranked = [...room.roundRoster.values()].sort(compare);
    let previous: Player | undefined;
    let previousPosition = 0;
    return ranked.map((player, index) => {
      const position = previous && compare(previous, player) === 0 ? previousPosition : index + 1;
      previous = player;
      previousPosition = position;
      return { player, position };
    });
  }

  snapshot(roomId: string, userId: string | undefined) {
    const { room, player } = this.authenticate(roomId, userId);
    const rankings = this.rank(room).map(({ player: entry, position }) => ({
      userId: entry.userId,
      name: entry.name,
      solved: entry.best?.solved ?? false,
      charCount: entry.best?.solved ? entry.best.charCount : null,
      solveTime: entry.best?.solved ? entry.best.submitTime : null,
      testsPassed: entry.best?.passed ?? 0,
      testsTotal: room.problem ? room.problem.testCount ?? room.problem.tests.length : 0,
      lockedAt: entry.lockedAt,
      resigned: entry.resigned,
      away: this.away(entry),
      code: room.state === 'finished' ? entry.bestCode : null,
      position,
    }));
    const soloProblemsSolved = new Set(room.tournamentRounds.flatMap((round) =>
      round.results.some((result) => result.userId === userId && result.solved) ? [round.problemId] : []));
    const standings = room.tournamentRounds.some((round) => round.competitive)
      ? [...room.tournamentPoints].map(([memberId, points]) => ({
        userId: memberId,
        name: room.participants.get(memberId) ?? '',
        points,
      })).sort((left, right) => right.points - left.points)
      : [];
    return {
      roomId: room.id,
      tournamentId: room.tournamentId,
      host: room.hostId ? room.players.get(room.hostId)?.name ?? '' : '',
      hostId: room.hostId,
      state: room.state,
      players: [...room.players.values()].map((entry) => entry.name),
      members: [...room.players.values()].map((entry) => ({ userId: entry.userId, name: entry.name, online: this.online(entry), host: entry.userId === room.hostId })),
      timeLimit: room.timeLimit,
      difficulty: room.difficulty,
      currentRound: room.currentRound,
      roundId: `${room.tournamentId}:${room.roundId}`,
      totalRounds: room.totalRounds,
      remaining: room.state === 'playing' ? Math.max(0, Math.ceil((room.startedAt + room.timeLimit * 1000 - this.now()) / 1000)) : 0,
      breakRemaining: room.breakUntil === null ? null : Math.max(0, Math.ceil((room.breakUntil - this.now()) / 1000)),
      endsAt: room.state === 'playing' ? room.startedAt + room.timeLimit * 1000 : null,
      breakUntil: room.breakUntil,
      serverNow: this.now(),
      problem: room.problem ? publicProblem(room.problem) : null,
      rankings,
      standings,
      messages: room.messages,
      me: { userId: player.userId, name: player.name, locked: player.lockedAt !== null, resigned: player.resigned, submission: player.submission, soloProblemsSolved: soloProblemsSolved.size },
    };
  }

  listen(roomId: string, userId: string, listener: () => void) {
    const { room, player } = this.authenticate(roomId, userId);
    if (player.streams >= 8) reject('Too many account connections.', 'TOO_MANY_REQUESTS');
    if (room.events.listenerCount('update') >= 80) reject('Too many room connections.', 'TOO_MANY_REQUESTS');
    room.events.on('update', listener);
    const generation = player.generation;
    const wasOffline = player.streams === 0;
    player.streams += 1;
    player.offlineSince = null;
    player.lastHeartbeat = this.now();
    if (room.hostId === null) room.hostId = userId;
    if (wasOffline || room.hostId === userId) this.emit(room);
    return () => {
      room.events.off('update', listener);
      const current = room.players.get(userId);
      if (current !== player || current.generation !== generation) return;
      player.streams = Math.max(0, player.streams - 1);
      if (player.streams === 0) {
        player.offlineSince = this.now();
        this.emit(room);
      }
    };
  }

  heartbeat(roomId: string, userId: string | undefined): void {
    const { room, player } = this.authenticate(roomId, userId);
    if (player.streams === 0) reject('Open the room stream before sending a heartbeat.');
    const wasOffline = !this.online(player);
    player.lastHeartbeat = this.now();
    player.offlineSince = null;
    if (wasOffline) this.emit(room);
  }

  disconnectUser(userId: string): void {
    const roomId = this.memberships.get(userId);
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    const player = room?.players.get(userId);
    if (!room || !player || player.streams === 0) return;
    player.streams = 0;
    player.offlineSince = this.now();
    player.generation = ++this.generation;
    this.emit(room);
  }

  start(roomId: string, userId: string | undefined) {
    const { room } = this.authenticate(roomId, userId);
    this.host(room, userId);
    if (room.state !== 'lobby') reject('The game has already started.');
    this.beginRound(room);
  }

  private beginRound(room: Room) {
    const problem = this.pickProblem(room.difficulty, room.lastProblemId);
    room.roundRoster.clear();
    room.departedRoundUsers.clear();
    for (const [userId, player] of room.players) {
      resetRound(player);
      room.roundRoster.set(userId, player);
      room.participants.set(userId, player.name);
      if (!room.tournamentPoints.has(userId)) room.tournamentPoints.set(userId, 0);
    }
    room.problem = problem;
    room.lastProblemId = problem.id;
    room.state = 'playing';
    room.currentRound += 1;
    room.roundId += 1;
    room.startedAt = this.now();
    room.breakUntil = null;
    room.epoch += 1;
    if (!room.tournamentStarted) {
      room.tournamentStarted = true;
      this.report({ type: 'tournament_started', roomId: room.id, tournamentId: room.tournamentId, userIds: [...room.participants.keys()] });
    }
    this.emit(room);
  }

  private completeRound(room: Room) {
    if (room.state !== 'playing') return;
    if ([...room.roundRoster.values()].some((player) => player.pending)) return;
    const ranking = this.rank(room);
    const minSolvedChars = ranking.reduce((minimum, entry) => entry.player.best?.solved && !room.departedRoundUsers.has(entry.player.userId)
      ? Math.min(minimum, entry.player.best.charCount)
      : minimum, Infinity);
    const competitive = room.roundRoster.size > 1;
    const results = ranking.map(({ player, position }) => {
      const departed = room.departedRoundUsers.has(player.userId);
      const best = player.best;
      return {
        userId: player.userId,
        name: player.name,
        charCount: best?.solved ? best.charCount : null,
        solved: best?.solved ?? false,
        solveTime: best?.solved ? best.submitTime : null,
        position,
        points: departed || !competitive ? 0 : roundPoints(best?.solved ? best.charCount : null, best?.solved ? player.lockedAt : null, minSolvedChars, room.timeLimit),
        departed,
      };
    });
    const roundId = `${room.tournamentId}:${room.roundId}`;
    const problemId = room.problem?.id ?? '';
    const completed = { roundId, problemId, competitive, results };
    room.tournamentRounds.push(completed);
    for (const result of results) room.tournamentPoints.set(result.userId, (room.tournamentPoints.get(result.userId) ?? 0) + result.points);
    this.report({
      type: 'round_finished', roomId: room.id, tournamentId: room.tournamentId, roundId,
      round: room.currentRound, problemId, competitive, durationSeconds: room.timeLimit, results,
    });
    room.state = 'finished';
    room.breakUntil = room.currentRound < room.totalRounds ? this.now() + 30_000 : null;
    room.epoch += 1;
    this.emit(room);
    if (room.breakUntil === null) this.settleTournament(room, 'completed', []);
  }

  private requirePlaying(room: Room) {
    if (room.state === 'playing' && this.now() >= room.startedAt + room.timeLimit * 1000) this.completeRound(room);
    if (room.state !== 'playing' || this.now() >= room.startedAt + room.timeLimit * 1000) reject('The round is not playing.');
  }

  skipBreak(roomId: string, userId: string | undefined) {
    const { room } = this.authenticate(roomId, userId);
    this.host(room, userId);
    if (room.breakUntil === null) reject('There is no break to skip.');
    this.beginRound(room);
  }

  restart(roomId: string, userId: string | undefined) {
    const { room } = this.authenticate(roomId, userId);
    this.host(room, userId);
    if (room.state !== 'finished') reject('Finish the round before restarting.');
    this.settleTournament(room, 'restarted', []);
    room.state = 'lobby';
    room.problem = null;
    room.currentRound = 0;
    room.roundId = 0;
    room.breakUntil = null;
    room.epoch += 1;
    room.tournamentId = tournamentId();
    room.tournamentRounds = [];
    room.tournamentPoints.clear();
    room.participants.clear();
    room.departureReported.clear();
    room.settlementComplete = false;
    room.tournamentStarted = false;
    room.roundRoster.clear();
    room.departedRoundUsers.clear();
    for (const player of room.players.values()) resetRound(player);
    this.emit(room);
  }

  async submit(roomId: string, userId: string | undefined, code: string): Promise<Submission> {
    const { room, player } = this.authenticate(roomId, userId);
    this.requirePlaying(room);
    if (!room.problem || this.now() >= room.startedAt + room.timeLimit * 1000) reject('This round has ended.');
    if (player.lockedAt !== null || player.resigned) reject('You have already finished this round.');
    if (player.pending) reject('Wait for your current submission to finish.', 'TOO_MANY_REQUESTS');
    player.pending = true;
    const epoch = room.epoch;
    const submitTime = (this.now() - room.startedAt) / 1000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.execute(code, room.problem),
        new Promise<SubmissionResult>((_, rejectTimeout) => {
          timeout = setTimeout(() => rejectTimeout(new Error('Runner timed out.')), RUNNER_TIMEOUT_MS);
        }),
      ]);
      if (room.epoch !== epoch || room.roundRoster.get(userId ?? '') !== player || room.state !== 'playing' || player.resigned || player.lockedAt !== null) {
        reject('This round ended while your submission was running.');
      }
      const submission = { ...result, submitTime };
      if (result.solved && !player.solveRecorded) {
        player.solveRecorded = true;
        this.report({
          type: 'problem_solved',
          userId: player.userId,
          problemId: room.problem.id,
          tournamentId: room.tournamentId,
          roundId: `${room.tournamentId}:${room.roundId}`,
        });
      }
      player.submission = submission;
      if (!player.best || better(submission, player.best)) {
        player.best = submission;
        player.bestCode = code;
      }
      this.emit(room);
      return submission;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      player.pending = false;
      if (this.rooms.get(room.id) === room) {
        if (room.state === 'playing' && this.now() >= room.startedAt + room.timeLimit * 1000) this.completeRound(room);
        else if (room.state === 'playing' && this.everyoneDone(room)) this.completeRound(room);
      }
    }
  }

  lock(roomId: string, userId: string | undefined) {
    const { room, player } = this.authenticate(roomId, userId);
    this.requirePlaying(room);
    if (player.pending) reject('Wait for your current submission to finish.', 'TOO_MANY_REQUESTS');
    if (player.resigned || player.lockedAt !== null) reject('You have already finished this round.');
    if (!player.best?.solved) reject('Solve the problem before locking in.');
    player.lockedAt = (this.now() - room.startedAt) / 1000;
    if (this.everyoneDone(room)) this.completeRound(room);
    else this.emit(room);
  }

  resign(roomId: string, userId: string | undefined) {
    const { room, player } = this.authenticate(roomId, userId);
    this.requirePlaying(room);
    if (player.resigned || player.lockedAt !== null) reject('You have already finished this round.');
    player.resigned = true;
    if (this.everyoneDone(room)) this.completeRound(room);
    else this.emit(room);
  }

  chat(roomId: string, userId: string | undefined, message: string) {
    const { room, player } = this.authenticate(roomId, userId);
    room.messages.push({ id: ++room.messageId, senderId: player.userId, sender: player.name, message });
    if (room.messages.length > 100) room.messages.shift();
    this.emit(room);
  }

  kick(roomId: string, hostId: string | undefined, targetUserId: string) {
    const { room } = this.authenticate(roomId, hostId);
    this.host(room, hostId);
    if (targetUserId === hostId) reject('The host cannot remove themselves.');
    this.removeMember(room, targetUserId, true);
  }

  leave(roomId: string, userId: string | undefined) {
    const { room } = this.authenticate(roomId, userId);
    this.removeMember(room, userId ?? '', false);
  }

  private settleTournament(room: Room, reason: 'completed' | 'departed' | 'restarted', departedUserIds: string[]) {
    if (!room.tournamentStarted || room.settlementComplete) return;
    if (reason === 'departed') {
      const affected = departedUserIds.filter((userId) => !room.departureReported.has(userId));
      if (affected.length === 0) return;
      for (const userId of affected) room.departureReported.add(userId);
      departedUserIds = affected;
    } else {
      room.settlementComplete = true;
    }
    this.report({
      type: 'tournament_settled', roomId: room.id, tournamentId: room.tournamentId, reason,
      completedRoundScores: [...room.participants.keys()].map((memberId) => ({ userId: memberId, points: room.tournamentPoints.get(memberId) ?? 0 })),
      departedUserIds,
      remainingUserIds: [...room.players.keys()],
    });
  }

  private removeMember(room: Room, userId: string, ban: boolean) {
    const player = room.players.get(userId);
    if (!player) return;
    room.players.delete(userId);
    this.memberships.delete(userId);
    if (ban) room.banned.add(userId);
    const roundPlayer = room.roundRoster.get(userId);
    if (roundPlayer && room.state === 'playing') {
      room.departedRoundUsers.add(userId);
      if (roundPlayer.lockedAt === null) roundPlayer.resigned = true;
    }
    if (room.hostId === userId) room.hostId = null;
    if (room.hostId === null) this.transferHost(room);
    this.settleTournament(room, 'departed', [userId]);
    if (room.players.size === 0) {
      this.rooms.delete(room.id);
      room.epoch += 1;
    } else if (room.state === 'playing' && this.everyoneDone(room)) {
      this.completeRound(room);
    }
    this.emit(room);
  }

  private transferHost(room: Room) {
    const next = [...room.players.values()].filter((player) => this.online(player))
      .sort((left, right) => left.joinedAt - right.joinedAt)[0];
    room.hostId = next?.userId ?? null;
  }

  tick() {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      for (const player of [...room.players.values()]) {
        if (this.away(player)) this.removeMember(room, player.userId, false);
      }
      if (!this.rooms.has(room.id)) continue;
      if (room.hostId === null && room.players.size > 0) this.transferHost(room);
      if (room.state === 'playing') {
        if (now >= room.startedAt + room.timeLimit * 1000) this.completeRound(room);
        else if (this.everyoneDone(room)) this.completeRound(room);
      } else if (room.breakUntil !== null) {
        if ([...room.players.values()].every((player) => !this.online(player))) {
          if (room.players.size === 0) this.rooms.delete(room.id);
          else if ([...room.players.values()].every((player) => this.away(player))) {
            for (const player of [...room.players.values()]) this.removeMember(room, player.userId, false);
          }
        } else if (now >= room.breakUntil) {
          this.beginRound(room);
        }
      }
    }
  }
}
