import { describe, expect, it } from 'vitest';
import type { Problem } from '../server/problems.js';
import { RoomStore } from '../server/rooms.js';
import type { SubmissionResult } from '../server/runner.js';

const problem: Problem = {
  id: 'sum', title: 'Sum', difficulty: 'Easy', statement: 'Return a + b.',
  entryPoint: 'Solution().sum', starterCode: 'class Solution:\n    def sum(self, a: int, b: int) -> int:\n        pass\n',
  parameters: [{ name: 'a', type: 'int' }, { name: 'b', type: 'int' }],
  returnType: 'int', tests: [{ input: [1, 2], expected: 3 }],
};
const solved: SubmissionResult = {
  passed: 1, total: 1, solved: true, charCount: 20, error: null, timeMs: 1,
  firstFailure: null, stdout: '', stderr: '',
};

function createHost(store: RoomStore, settings: { name: string; timeLimit: number; difficulty: 'Easy' | null; rounds: number }) {
  return { ...store.create(settings, 'host'), userId: 'host' };
}

function joinAs(store: RoomStore, roomId: string, name: string, userId = 'guest') {
  return { ...store.join(roomId, name, userId), userId };
}

function setup(rounds = 1, execute: (code: string, problem: Problem) => Promise<SubmissionResult> = async () => solved) {
  let now = 0;
  const store = new RoomStore(() => problem, execute, () => now);
  const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds });
  store.listen(host.roomId, host.userId, () => {});
  return { store, host, advance: (milliseconds: number) => {
    now += milliseconds;
    try {
      store.heartbeat(host.roomId, host.userId);
    } catch {
      // Expired and deliberately disconnected hosts have no stream to refresh.
    }
    store.tick();
  } };
}

describe('game rooms', () => {
  it('allows eight players including the host and rejects the ninth', () => {
    const { store, host } = setup();
    for (let index = 1; index < 8; index++) store.join(host.roomId, `Player ${index}`, `player-${index}`);
    expect(store.snapshot(host.roomId, host.userId).players).toHaveLength(8);
    expect(() => store.join(host.roomId, 'Player 8', 'player-8')).toThrow('This room is full.');
    expect(store.snapshot(host.roomId, host.userId).players).toHaveLength(8);
  });

  it('requires the host token and rejects duplicate display names', () => {
    const { store, host } = setup();
    const guest = joinAs(store, host.roomId, 'Chat');
    expect(() => store.join(host.roomId, 'Dark', 'other')).toThrow('already taken');
    expect(() => store.start(host.roomId, guest.userId)).toThrow('Only the host');
    expect(() => store.start(host.roomId, 'Dark')).toThrow('Rejoin');
    store.start(host.roomId, host.userId);
    expect(store.snapshot(host.roomId, host.userId).state).toBe('playing');
  });

  it('uses opaque room identifiers and keeps one active room per account', () => {
    const { store, host } = setup();
    expect(host.roomId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(() => createHost(store, { name: 'Again', timeLimit: 30, difficulty: null, rounds: 1 })).toThrow('current room');
    expect(() => store.snapshot(host.roomId, 'a-bearer-token')).toThrow('Rejoin');
  });

  it('reconnects existing members in any phase and aggregates streams per account', () => {
    const { store, host } = setup();
    const guest = joinAs(store, host.roomId, 'Chat');
    let changes = 0;
    const closeFirst = store.listen(host.roomId, guest.userId, () => { changes += 1; });
    const closeSecond = store.listen(host.roomId, guest.userId, () => { changes += 1; });
    store.start(host.roomId, host.userId);
    closeFirst();
    expect(store.snapshot(host.roomId, host.userId).members.find((member) => member.userId === guest.userId)?.online).toBe(true);
    expect(store.join(host.roomId, 'Changed', guest.userId).name).toBe('Chat');
    closeSecond();
    expect(store.snapshot(host.roomId, host.userId).members.find((member) => member.userId === guest.userId)?.online).toBe(false);
    expect(changes).toBeGreaterThan(0);
  });

  it('bounds account streams and releases the slot when a tab closes', () => {
    const { store, host } = setup();
    const tabs = Array.from({ length: 7 }, () => store.listen(host.roomId, host.userId, () => {}));
    expect(() => store.listen(host.roomId, host.userId, () => {})).toThrow('Too many account connections.');
    tabs[0]?.();
    const replacement = store.listen(host.roomId, host.userId, () => {});
    expect(store.snapshot(host.roomId, host.userId).members[0]?.online).toBe(true);
    replacement();
    for (const close of tabs.slice(1)) close();
  });

  it('keeps a round result after a member leaves and forbids further room access', async () => {
    const events: import('../server/rooms.js').RoomEvent[] = [];
    const store = new RoomStore(() => problem, async () => solved, Date.now, { onEvent: (event) => events.push(event) });
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    store.listen(host.roomId, host.userId, () => {});
    const guest = joinAs(store, host.roomId, 'Chat');
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, guest.userId, 'correct');
    await store.submit(host.roomId, guest.userId, 'also correct');
    expect(events.filter((event) => event.type === 'problem_solved')).toHaveLength(1);
    expect(events.some((event) => event.type === 'round_finished')).toBe(false);
    store.leave(host.roomId, guest.userId);
    expect(() => store.snapshot(host.roomId, guest.userId)).toThrow('Rejoin');
    expect(store.snapshot(host.roomId, host.userId).rankings.find((entry) => entry.userId === guest.userId)?.solved).toBe(true);
  });

  it('does not record a correct result from a submission pending when its member is kicked', async () => {
    let finish: ((result: SubmissionResult) => void) | undefined;
    const pendingRun = new Promise<SubmissionResult>((resolve) => { finish = resolve; });
    const events: import('../server/rooms.js').RoomEvent[] = [];
    const store = new RoomStore(() => problem, async () => pendingRun, Date.now, { onEvent: (event) => events.push(event) });
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    const guest = joinAs(store, host.roomId, 'Chat');
    store.start(host.roomId, host.userId);
    const submission = store.submit(host.roomId, guest.userId, 'pending correct');
    store.kick(host.roomId, host.userId, guest.userId);
    finish?.(solved);
    await expect(submission).rejects.toThrow('round ended');
    expect(events.some((event) => event.type === 'problem_solved')).toBe(false);
  });

  it('bans a kicked account for the room lifetime and preserves their round score', async () => {
    const { store, host } = setup(1);
    const guest = joinAs(store, host.roomId, 'Chat');
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, guest.userId, 'correct');
    store.kick(host.roomId, host.userId, guest.userId);
    expect(() => store.join(host.roomId, 'Chat', guest.userId)).toThrow('removed');
    expect(store.snapshot(host.roomId, host.userId).rankings.find((entry) => entry.userId === guest.userId)?.solved).toBe(true);
  });

  it('emits round and tournament records with stable participant IDs and actual character points', async () => {
    const events: import('../server/rooms.js').RoomEvent[] = [];
    const store = new RoomStore(() => problem, async (code) => ({ ...solved, charCount: code.length }), () => 0, {
      onEvent: (event) => events.push(event),
    });
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    const guest = joinAs(store, host.roomId, 'Chat');
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, host.userId, 'host-code');
    await store.submit(host.roomId, guest.userId, 'short');
    store.lock(host.roomId, host.userId);
    store.lock(host.roomId, guest.userId);
    const started = events.find((event) => event.type === 'tournament_started');
    const round = events.find((event) => event.type === 'round_finished');
    const settled = events.find((event) => event.type === 'tournament_settled' && event.reason === 'completed');
    expect(started?.type === 'tournament_started' && started.userIds).toEqual(['host', 'guest']);
    expect(round?.type === 'round_finished' && round.problemId).toBe('sum');
    expect(round?.type === 'round_finished' && round.results.find((result) => result.userId === 'guest')?.charCount).toBe(5);
    expect(settled?.type === 'tournament_settled' && settled.completedRoundScores).toHaveLength(2);
    expect(settled?.type === 'tournament_settled' && settled.departedUserIds).toEqual([]);
  });

  it('awards the current round to the remaining solver when a shorter solver departs', async () => {
    const events: import('../server/rooms.js').RoomEvent[] = [];
    const store = new RoomStore(() => problem, async (code) => ({ ...solved, charCount: code.length }), () => 0, {
      onEvent: (event) => events.push(event),
    });
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    const guest = joinAs(store, host.roomId, 'Chat');
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, host.userId, 'host-code');
    await store.submit(host.roomId, guest.userId, 'short');
    store.leave(host.roomId, guest.userId);
    store.lock(host.roomId, host.userId);
    const round = events.find((event) => event.type === 'round_finished');
    expect(round?.type === 'round_finished' && round.results[0]).toMatchObject({ userId: host.userId, position: 1, departed: false, points: 100 });
    expect(round?.type === 'round_finished' && round.results[1]).toMatchObject({ userId: guest.userId, position: 2, departed: true, points: 0 });
  });

  it('does not emit empty lobby settlements or repeat a completed tournament settlement', async () => {
    const events: import('../server/rooms.js').RoomEvent[] = [];
    const store = new RoomStore(() => problem, async () => solved, Date.now, { onEvent: (event) => events.push(event) });
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    store.leave(host.roomId, host.userId);
    expect(events.filter((event) => event.type === 'tournament_settled')).toHaveLength(0);

    const nextHost = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    store.listen(nextHost.roomId, nextHost.userId, () => {});
    store.start(nextHost.roomId, nextHost.userId);
    await store.submit(nextHost.roomId, nextHost.userId, 'solve');
    store.lock(nextHost.roomId, nextHost.userId);
    const completedCount = events.filter((event) => event.type === 'tournament_settled' && event.reason === 'completed').length;
    store.restart(nextHost.roomId, nextHost.userId);
    expect(events.filter((event) => event.type === 'tournament_settled' && event.reason === 'completed')).toHaveLength(completedCount);
  });

  it('does not award solo points and counts unique solved problems', async () => {
    const events: import('../server/rooms.js').RoomEvent[] = [];
    const store = new RoomStore(() => problem, async () => solved, Date.now, { onEvent: (event) => events.push(event) });
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 2 });
    store.listen(host.roomId, host.userId, () => {});
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, host.userId, 'solve');
    store.lock(host.roomId, host.userId);
    const firstRound = store.snapshot(host.roomId, host.userId);
    expect(firstRound.standings).toEqual([]);
    expect(firstRound.me.soloProblemsSolved).toBe(1);
    expect(store.snapshot(host.roomId, host.userId).rankings[0]?.solved).toBe(true);
    const finished = events.find((event) => event.type === 'round_finished');
    expect(finished?.type === 'round_finished' && finished.results[0]?.points).toBe(0);
  });

  it('refreshes an active account heartbeat and evicts stale members after thirty seconds', () => {
    let now = 0;
    const store = new RoomStore(() => problem, async () => solved, () => now);
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    const guest = joinAs(store, host.roomId, 'Chat');
    store.listen(host.roomId, host.userId, () => {});
    store.listen(host.roomId, guest.userId, () => {});
    now = 29_000;
    store.heartbeat(host.roomId, guest.userId);
    now = 58_999;
    store.heartbeat(host.roomId, host.userId);
    store.tick();
    expect(store.snapshot(host.roomId, host.userId).players).toContain('Chat');
    now = 59_000;
    store.heartbeat(host.roomId, host.userId);
    store.tick();
    expect(store.snapshot(host.roomId, host.userId).players).not.toContain('Chat');
    expect(store.currentRoom(guest.userId)).toBeNull();
  });

  it('allows the full thirty seconds after a known disconnect even when its heartbeat is older', () => {
    let now = 0;
    const store = new RoomStore(() => problem, async () => solved, () => now);
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    const close = store.listen(host.roomId, host.userId, () => {});
    now = 4000;
    close();
    now = 33_999;
    store.tick();
    expect(store.currentRoom(host.userId)).toBe(host.roomId);
    now = 34_000;
    store.tick();
    expect(store.currentRoom(host.userId)).toBeNull();
  });

  it('keeps a healthy room alive beyond its former idle lifetime', () => {
    let now = 0;
    const store = new RoomStore(() => problem, async () => solved, () => now);
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    store.listen(host.roomId, host.userId, () => {});
    now = 8_000_000;
    store.heartbeat(host.roomId, host.userId);
    store.tick();
    expect(store.currentRoom(host.userId)).toBe(host.roomId);
    expect(store.snapshot(host.roomId, host.userId).players).toEqual(['Dark']);
  });

  it('does not let an old stream disposer mark a rejoined member offline', () => {
    const { store, host, advance } = setup();
    const guest = joinAs(store, host.roomId, 'Chat');
    const closeOld = store.listen(host.roomId, guest.userId, () => {});
    store.leave(host.roomId, guest.userId);
    const rejoined = joinAs(store, host.roomId, 'Chat', guest.userId);
    const closeNew = store.listen(host.roomId, rejoined.userId, () => {});
    closeOld();
    expect(store.snapshot(host.roomId, host.userId).members.find((member) => member.userId === guest.userId)?.online).toBe(true);
    advance(29_000);
    store.heartbeat(host.roomId, guest.userId);
    advance(2_000);
    expect(store.snapshot(host.roomId, host.userId).players).toContain('Chat');
    closeNew();
  });

  it('keeps opponent code private until a round ends', async () => {
    const { store, host } = setup();
    const guest = joinAs(store, host.roomId, 'Chat');
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, host.userId, 'class Solution:\n    def sum(self, a, b):\n        return a + b');
    expect(store.snapshot(host.roomId, guest.userId).rankings[0]?.code).toBeNull();
    expect(store.snapshot(host.roomId, guest.userId).me.submission).toBeNull();
    store.lock(host.roomId, host.userId);
    store.resign(host.roomId, guest.userId);
    expect(store.snapshot(host.roomId, guest.userId).rankings[0]?.code).toBe('class Solution:\n    def sum(self, a, b):\n        return a + b');
  });

  it('ranks solved submissions by length and retains the best on a regression', async () => {
    let submissionNumber = 0;
    const { store, host } = setup(1, async () => {
      submissionNumber += 1;
      return submissionNumber === 2 ? { ...solved, passed: 0, solved: false, charCount: 10 } : solved;
    });
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, host.userId, 'first');
    await store.submit(host.roomId, host.userId, 'bad');
    const snapshot = store.snapshot(host.roomId, host.userId);
    expect(snapshot.me.submission?.solved).toBe(false);
    expect(snapshot.rankings[0]?.solved).toBe(true);
    store.lock(host.roomId, host.userId);
    expect(store.snapshot(host.roomId, host.userId).rankings[0]?.code).toBe('first');
  });

  it('ranks equal length locked solves ahead of later or unlocked solves and shares true ties', async () => {
    let now = 0;
    const store = new RoomStore(() => problem, async () => solved, () => now);
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    const guest = joinAs(store, host.roomId, 'Chat');
    store.listen(host.roomId, host.userId, () => {});
    store.listen(host.roomId, guest.userId, () => {});
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, guest.userId, 'guest');
    now = 1_000;
    await store.submit(host.roomId, host.userId, 'host');
    store.lock(host.roomId, host.userId);
    expect(store.snapshot(host.roomId, host.userId).rankings.map((entry) => entry.userId)).toEqual(['host', 'guest']);

    const tied = setup();
    const tiedGuest = joinAs(tied.store, tied.host.roomId, 'Chat');
    tied.store.start(tied.host.roomId, tied.host.userId);
    await tied.store.submit(tied.host.roomId, tied.host.userId, 'host');
    await tied.store.submit(tiedGuest.roomId, tiedGuest.userId, 'guest');
    const tiedRanks = tied.store.snapshot(tied.host.roomId, tied.host.userId).rankings;
    expect(tiedRanks[0]?.position).toBe(1);
    expect(tiedRanks[1]?.position).toBe(1);
  });

  it('rewards an earlier lock over an earlier unlocked solve at equal length', async () => {
    let now = 0;
    const events: import('../server/rooms.js').RoomEvent[] = [];
    const store = new RoomStore(() => problem, async () => solved, () => now, { onEvent: (event) => events.push(event) });
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    const guest = joinAs(store, host.roomId, 'Chat');
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, host.userId, 'host solution');
    now = 5_000;
    await store.submit(host.roomId, guest.userId, 'guest solution');
    now = 10_000;
    store.lock(host.roomId, guest.userId);
    store.resign(host.roomId, host.userId);

    const round = events.find((event) => event.type === 'round_finished');
    expect(round?.type === 'round_finished' && round.results.map((result) => result.userId)).toEqual(['guest', 'host']);
    if (round?.type !== 'round_finished') throw new Error('Expected a finished round event.');
    const guestResult = round.results.find((result) => result.userId === guest.userId);
    const hostResult = round.results.find((result) => result.userId === host.userId);
    expect(guestResult?.solveTime).toBe(5);
    expect(guestResult?.points).toBeGreaterThan(hostResult?.points ?? Infinity);
    expect(hostResult?.points).toBeCloseTo(200 / 3, 10);
  });

  it('keeps shorter solves first even when the longer solve locks earlier', async () => {
    let now = 0;
    const store = new RoomStore(() => problem, async (code) => ({ ...solved, charCount: code.length }), () => now);
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    const guest = joinAs(store, host.roomId, 'Chat');
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, host.userId, 'a much longer solution');
    await store.submit(host.roomId, guest.userId, 'short');
    store.lock(host.roomId, guest.userId);
    now = 1_000;
    store.lock(host.roomId, host.userId);
    const ranks = store.snapshot(host.roomId, host.userId).rankings;
    expect(ranks.map((entry) => entry.userId)).toEqual([guest.userId, host.userId]);
  });

  it('reports when the shortest correct submission was sent, independent of judging, later attempts and locking', async () => {
    let now = 0;
    const store = new RoomStore(() => problem, async (code) => {
      now += 800;
      return { ...solved, solved: code !== 'bad', passed: code === 'bad' ? 0 : 1, charCount: code.length };
    }, () => now);
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    const guest = joinAs(store, host.roomId, 'Unsolved');
    store.start(host.roomId, host.userId);
    expect(store.snapshot(host.roomId, host.userId).rankings[0]?.solveTime).toBeNull();
    now = 1234;
    await store.submit(host.roomId, host.userId, 'long correct solution');
    expect(store.snapshot(host.roomId, host.userId).rankings[0]?.solveTime).toBe(1.234);
    now = 9876;
    await store.submit(host.roomId, host.userId, 'short');
    now = 12_345;
    await store.submit(host.roomId, host.userId, 'short');
    now = 14_000;
    await store.submit(host.roomId, host.userId, 'bad');
    await store.submit(host.roomId, guest.userId, 'bad');
    now = 16_000;
    await store.submit(host.roomId, host.userId, 'long correct solution');
    now = 20_000;
    store.resign(host.roomId, guest.userId);
    store.lock(host.roomId, host.userId);
    const final = store.snapshot(host.roomId, host.userId);
    expect(final.rankings[0]).toMatchObject({ solveTime: 9.876, charCount: 5, lockedAt: 20, code: 'short' });
    expect(final.rankings[1]?.solveTime).toBeNull();
    store.restart(host.roomId, host.userId);
    expect(store.snapshot(host.roomId, host.userId).rankings.every((entry) => entry.solveTime === null)).toBe(true);
  });

  it('runs a 30 second break and does not let an old break skip a later round', () => {
    const { store, host, advance } = setup(3);
    store.start(host.roomId, host.userId);
    advance(30_000);
    expect(store.snapshot(host.roomId, host.userId).breakRemaining).toBe(30);
    store.skipBreak(host.roomId, host.userId);
    advance(29_000);
    expect(store.snapshot(host.roomId, host.userId).currentRound).toBe(2);
    advance(1_000);
    expect(store.snapshot(host.roomId, host.userId).breakRemaining).toBe(30);
    advance(30_000);
    expect(store.snapshot(host.roomId, host.userId).currentRound).toBe(3);
    advance(30_000);
    expect(store.snapshot(host.roomId, host.userId).breakRemaining).toBeNull();
  });

  it('cancels a break on restart and clears submissions', async () => {
    const { store, host, advance } = setup(2);
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, host.userId, 'solve');
    store.lock(host.roomId, host.userId);
    store.restart(host.roomId, host.userId);
    advance(30_000);
    const snapshot = store.snapshot(host.roomId, host.userId);
    expect(snapshot.state).toBe('lobby');
    expect(snapshot.problem).toBeNull();
    expect(snapshot.me.submission).toBeNull();
  });

  it('selects a different problem after replaying while clearing the lobby problem', () => {
    const nextProblem = { ...problem, id: 'next', title: 'Next problem' };
    const store = new RoomStore((_difficulty, previousId) => previousId === problem.id ? nextProblem : problem);
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: 'Easy', rounds: 1 });
    store.start(host.roomId, host.userId);
    expect(store.snapshot(host.roomId, host.userId).problem?.id).toBe('sum');
    store.resign(host.roomId, host.userId);
    store.restart(host.roomId, host.userId);
    expect(store.snapshot(host.roomId, host.userId).problem).toBeNull();
    store.start(host.roomId, host.userId);
    const replay = store.snapshot(host.roomId, host.userId);
    expect(replay.problem?.id).toBe('next');
    expect(replay.difficulty).toBe('Easy');
    expect(replay.currentRound).toBe(1);
  });

  it('gives repeated problems distinct round identities across rounds and replays', () => {
    const { store, host } = setup(2);
    store.start(host.roomId, host.userId);
    const first = store.snapshot(host.roomId, host.userId);
    store.resign(host.roomId, host.userId);
    expect(store.snapshot(host.roomId, host.userId).roundId).toBe(first.roundId);
    store.skipBreak(host.roomId, host.userId);
    const second = store.snapshot(host.roomId, host.userId);
    expect(second.problem?.id).toBe(first.problem?.id);
    expect(second.roundId).not.toBe(first.roundId);
    store.resign(host.roomId, host.userId);
    store.restart(host.roomId, host.userId);
    store.start(host.roomId, host.userId);
    const replay = store.snapshot(host.roomId, host.userId);
    expect(replay.currentRound).toBe(first.currentRound);
    expect(replay.problem?.id).toBe(first.problem?.id);
    expect(replay.roundId).not.toBe(second.roundId);
    expect(replay.tournamentId).not.toBe(first.tournamentId);
  });

  it('rejects concurrent submissions and discards results from an old round', async () => {
    let finish: ((value: SubmissionResult) => void) | undefined;
    const execution = new Promise<SubmissionResult>((resolve) => { finish = resolve; });
    const { store, host } = setup(2, async () => execution);
    store.start(host.roomId, host.userId);
    const pending = store.submit(host.roomId, host.userId, 'solve');
    await expect(store.submit(host.roomId, host.userId, 'solve again')).rejects.toThrow('current submission');
    store.resign(host.roomId, host.userId);
    finish?.(solved);
    await expect(pending).rejects.toThrow('round ended');
    store.skipBreak(host.roomId, host.userId);
    expect(store.snapshot(host.roomId, host.userId).me.submission).toBeNull();
  });

  it('accepts a result submitted before the deadline even when judging finishes afterward', async () => {
    let now = 0;
    const store = new RoomStore(() => problem, async () => { now = 30_001; return solved; }, () => now);
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    store.start(host.roomId, host.userId);
    await expect(store.submit(host.roomId, host.userId, 'solve')).resolves.toMatchObject({ solved: true });
    expect(store.snapshot(host.roomId, host.userId).me.submission?.solved).toBe(true);
    expect(store.snapshot(host.roomId, host.userId).state).toBe('finished');
  });

  it('enforces the deadline on lock before the next timer tick', async () => {
    let now = 0;
    const store = new RoomStore(() => problem, async () => solved, () => now);
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    store.start(host.roomId, host.userId);
    await store.submit(host.roomId, host.userId, 'solve');
    now = 30_001;
    expect(() => store.lock(host.roomId, host.userId)).toThrow('not playing');
    expect(store.snapshot(host.roomId, host.userId).state).toBe('finished');
    expect(store.snapshot(host.roomId, host.userId).me.locked).toBe(false);
  });

  it.each(['lock', 'resign'] as const)('rejects a late %s while another on-time submission is pending', async (action) => {
    let now = 0;
    let finish: ((result: SubmissionResult) => void) | undefined;
    const pendingRun = new Promise<SubmissionResult>((resolve) => { finish = resolve; });
    const store = new RoomStore(() => problem, async (code) => code === 'pending' ? pendingRun : solved, () => now);
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    const guest = joinAs(store, host.roomId, 'Chat');
    store.start(host.roomId, host.userId);
    const pending = store.submit(host.roomId, host.userId, 'pending');
    await store.submit(host.roomId, guest.userId, 'solved');

    now = 30_001;
    expect(() => store[action](host.roomId, guest.userId)).toThrow('not playing');
    finish?.(solved);
    await expect(pending).resolves.toMatchObject({ solved: true });
    expect(store.snapshot(host.roomId, host.userId).state).toBe('finished');
  });

  it('stops waiting for players whose room stream closed without leaving', () => {
    const { store, host, advance } = setup();
    const guest = joinAs(store, host.roomId, 'Chat');
    store.listen(host.roomId, host.userId, () => {});
    const closeGuest = store.listen(host.roomId, guest.userId, () => {});
    store.start(host.roomId, host.userId);
    closeGuest();
    store.resign(host.roomId, host.userId);
    advance(29_000);
    expect(store.snapshot(host.roomId, host.userId).state).toBe('playing');
    expect(store.snapshot(host.roomId, host.userId).rankings.find((player) => player.name === 'Chat')?.away).toBe(false);
    advance(1_000);
    const snapshot = store.snapshot(host.roomId, host.userId);
    expect(snapshot.state).toBe('finished');
    expect(snapshot.rankings.find((player) => player.name === 'Chat')?.away).toBe(true);
  });

  it('keeps waiting for a player who reconnects within the grace period', () => {
    const { store, host, advance } = setup();
    const guest = joinAs(store, host.roomId, 'Chat');
    store.listen(host.roomId, host.userId, () => {});
    const closeGuest = store.listen(host.roomId, guest.userId, () => {});
    store.start(host.roomId, host.userId);
    closeGuest();
    advance(5_000);
    store.listen(host.roomId, guest.userId, () => {});
    store.resign(host.roomId, host.userId);
    advance(20_000);
    expect(store.snapshot(host.roomId, host.userId).state).toBe('playing');
  });

  it('transfers host on leave and removes empty or expired rooms', () => {
    const { store, host, advance } = setup();
    const guest = joinAs(store, host.roomId, 'Chat');
    store.listen(host.roomId, host.userId, () => {});
    store.listen(host.roomId, guest.userId, () => {});
    store.leave(host.roomId, host.userId);
    expect(store.snapshot(host.roomId, guest.userId).host).toBe('Chat');
    store.leave(host.roomId, guest.userId);
    expect(() => store.snapshot(host.roomId, guest.userId)).toThrow('not found');
    const second = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    advance(7_200_000);
    expect(() => store.snapshot(second.roomId, second.userId)).toThrow('not found');
  });

  it('transfers host to the oldest online member when the host expires', () => {
    let now = 0;
    const store = new RoomStore(() => problem, async () => solved, () => now);
    const host = createHost(store, { name: 'Dark', timeLimit: 30, difficulty: null, rounds: 1 });
    const guest = joinAs(store, host.roomId, 'Chat');
    store.listen(host.roomId, host.userId, () => {});
    store.listen(host.roomId, guest.userId, () => {});
    store.disconnectUser(host.userId);
    now = 30_000;
    store.heartbeat(host.roomId, guest.userId);
    store.tick();
    expect(store.snapshot(host.roomId, guest.userId).hostId).toBe(guest.userId);
    expect(store.currentRoom(host.userId)).toBeNull();
  });
});
