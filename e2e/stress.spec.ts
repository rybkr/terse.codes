import type { Browser, BrowserContext, Page } from '@playwright/test';
import { setupClerkTestingToken } from '@clerk/testing/playwright';
import { createClerkClient } from '@clerk/backend';
import type { RouterInputs, RouterOutputs, RoomSnapshot } from '../frontend/src/api';
import { signInTestAccount, type TestAccount } from './accounts';
import { test, expect } from './fixtures';

interface Player {
  account: TestAccount;
  context: BrowserContext;
  page: Page;
}

let reservedAccounts: TestAccount[] | undefined;
let nextAccount = 0;
async function account(): Promise<TestAccount> {
  if (!reservedAccounts) {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey?.startsWith('sk_test_')) throw new Error('Stress tests require Clerk development credentials.');
    const backend = createClerkClient({ secretKey });
    const users = await backend.users.getUserList({ limit: 100, orderBy: '-created_at' });
    reservedAccounts = users.data.filter((user) => user.firstName === 'LeetRace' && user.lastName === 'E2E'
      && /^p[a-f0-9]{9}$/.test(user.username ?? '') && user.emailAddresses.length > 0)
      .slice(0, 9).map((user) => ({
        userId: user.id, username: user.username!, email: user.emailAddresses[0]!.emailAddress, password: '',
      }));
    if (reservedAccounts.length < 9) throw new Error('Stress tests need nine scoped development test users from the browser suite.');
  }
  return reservedAccounts[nextAccount++ % reservedAccounts.length]!;
}

async function rpc<P extends keyof RouterInputs>(page: Page, procedure: P, input: RouterInputs[P], mutation = false): Promise<RouterOutputs[P]> {
  const output = await page.evaluate(async ({ procedure, input, mutation }) => {
    const browserWindow = window as Window & { Clerk?: { session?: { getToken(): Promise<string | null> } } };
    const token = await browserWindow.Clerk?.session?.getToken();
    const response = await fetch(`/trpc/${procedure}${mutation ? '' : `?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`}`, {
      method: mutation ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(mutation ? { body: JSON.stringify(input) } : {}),
    });
    const body: { result?: { data: unknown }; error?: { message: string } } = await response.json();
    if (!response.ok || !body.result) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    return body.result.data;
  }, { procedure, input, mutation });
  return output as RouterOutputs[P];
}

async function player(browser: Browser): Promise<Player> {
  const selectedAccount = await account();
  const context = await browser.newContext();
  context.setDefaultTimeout(25_000);
  const page = await context.newPage();
  await setupClerkTestingToken({ page });
  await signInTestAccount(page, selectedAccount);
  const membership = await rpc(page, 'me', undefined);
  if (membership.roomId) await rpc(page, 'leave', { roomId: membership.roomId }, true);
  return { account: selectedAccount, context, page };
}

function solution(padding: number, unicode = false) {
  return `from time import sleep\nclass Solution:\n    def summaryRanges(self, nums: list[int]) -> list[str]:\n        sleep(.002)\n        if not nums:\n            return []\n        ranges = []\n        start = previous = nums[0]\n        for value in nums[1:]:\n            if value == previous + 1:\n                previous = value\n                continue\n            ranges.append(str(start) if start == previous else f"{start}->{previous}")\n            start = previous = value\n        ranges.append(str(start) if start == previous else f"{start}->{previous}")\n        return ranges\n#${(unicode ? '🧪' : 'x').repeat(padding)}\n`;
}

async function edit(page: Page, code: string) {
  const editor = page.locator('.monaco-editor');
  await expect(editor).toBeVisible();
  await page.bringToFront();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await editor.click();
  const modifier = await page.evaluate(() => /Macintosh|Mac OS X/.test(navigator.userAgent) ? 'Meta' : 'Control');
  await page.keyboard.press(`${modifier}+A`);
  await page.evaluate((text) => navigator.clipboard.writeText(text), code);
  await page.keyboard.press(`${modifier}+V`);
}

function scores(snapshot: RoomSnapshot, players: Player[]) {
  return players.map(({ account }) => snapshot.standings.find((row) => row.userId === account.userId)?.points ?? 0);
}

test('eight real players submit concurrently and settle a three-round tournament across departures', async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const players: Player[] = [];
  const pageErrors: string[] = [];
  const timings: number[][] = [];
  const ratingDeltas = Array.from({ length: 8 }, () => 0);
  const settledPairs = new Set<string>();
  const departed = new Set<number>();
  const scoreHistory: number[][] = [];
  let baseline: RouterOutputs['profile'][] = [];
  let roomId = '';

  function settle(indices: number[], points: number[]) {
    for (let left = 0; left < indices.length; left++) {
      for (let right = left + 1; right < indices.length; right++) {
        const a = indices[left]!;
        const b = indices[right]!;
        const key = [a, b].sort((x, y) => x - y).join(':');
        if (settledPairs.has(key)) continue;
        const outcome = points[a]! > points[b]! ? 1 : 0;
        const expected = 1 / (1 + 10 ** ((baseline[b]!.rating - baseline[a]!.rating) / 400));
        const delta = points[a] === points[b] ? 0 : 32 / 7 * (outcome - expected);
        ratingDeltas[a]! += delta;
        ratingDeltas[b]! -= delta;
        settledPairs.add(key);
      }
    }
  }

  function settlementAtDeparture(index: number, points: number[]) {
    for (const other of players.keys()) {
      if (other !== index && !departed.has(other)) settle([index, other], points);
    }
    departed.add(index);
  }

  function assertRoundPoints(round: RoomSnapshot, before: number[], codes: string[], eligible: number[]) {
    const shortest = Math.min(...eligible.map((index) => Array.from(codes[index]!).length));
    for (const index of players.keys()) {
      const row = round.rankings.find((row) => row.userId === players[index]!.account.userId);
      const elapsed = row?.lockedAt ?? round.timeLimit;
      const earned = eligible.includes(index)
        ? 100 / 3 * (2 * shortest / Array.from(codes[index]!).length + (round.timeLimit - elapsed) / round.timeLimit)
        : 0;
      expect(scores(round, players)[index]).toBeCloseTo(before[index]! + earned, 8);
    }
  }

  async function profiles() {
    return Promise.all(players.map(({ page }) => rpc(page, 'profile', undefined)));
  }

  async function assertRatings() {
    const current = await profiles();
    for (const [index, profile] of current.entries()) expect(profile.rating).toBeCloseTo(baseline[index]!.rating + ratingDeltas[index]!, 8);
    expect(current.reduce((sum, profile) => sum + profile.rating, 0)).toBeCloseTo(baseline.reduce((sum, profile) => sum + profile.rating, 0), 8);
    return current;
  }

  const snapshot = () => rpc(players[0]!.page, 'room', { roomId });
  async function submitBatch(indices: number[], codes: string[]) {
    for (const index of indices) await edit(players[index]!.page, codes[index]!);
    const requests = indices.map(async (index) => {
      const page = players[index]!.page;
      const started = performance.now();
      const response = page.waitForResponse((response) => new URL(response.url()).pathname.split('/trpc/')[1]?.split(',').includes('submit') === true);
      await page.getByRole('button', { name: /^Submit/ }).click();
      const submitted = await response;
      expect(submitted.status()).toBe(200);
      const payload: Record<string, { code?: string }> = submitted.request().postDataJSON();
      expect(Object.values(payload).find((input) => input.code !== undefined)?.code).toBe(codes[index]);
      await expect(page.getByText('All tests passed', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      return performance.now() - started;
    });
    const healthStarted = performance.now();
    const response = await players[0]!.page.request.get('/health');
    expect(response.status()).toBe(200);
    expect(performance.now() - healthStarted).toBeLessThan(3000);
    timings.push(await Promise.all(requests));
    const current = await snapshot();
    for (const index of indices) {
      const row = current.rankings.find((row) => row.userId === players[index]!.account.userId);
      expect(row?.solved).toBe(true);
      expect(row?.charCount).toBe(Array.from(codes[index]!).length);
    }
    return current;
  }

  try {
    for (let index = 0; index < 9; index++) {
      const created = await player(browser);
      created.page.on('pageerror', (error) => pageErrors.push(error.message));
      players.push(created);
      console.log(`Stress player ${index + 1}/9 authenticated.`);
    }
    const host = players[0]!.page;
    await host.locator('#rounds').fill('3');
    await host.getByRole('button', { name: 'Create room' }).click();
    await expect(host.getByRole('heading', { name: 'Room Invite' })).toBeVisible();
    roomId = new URL(host.url()).searchParams.get('id')!;
    for (const participant of players.slice(1, 8)) {
      await participant.page.goto(`/join/${roomId}`);
      await participant.page.getByRole('button', { name: 'Join room' }).click();
      await expect(participant.page.getByRole('heading', { name: 'Room Invite' })).toBeVisible();
    }
    await expect(host.getByRole('list', { name: 'Players' }).getByRole('listitem')).toHaveCount(8);
    expect((await snapshot()).members.every((member) => member.online)).toBe(true);
    await expect(host.getByRole('button', { name: /^Remove .* from room$/ })).toHaveCount(7);
    console.log('Eight players are online; all seven host kick controls are visible.');
    const outsider = players[8]!.page;
    await outsider.goto(`/join/${roomId}`);
    await outsider.getByRole('button', { name: 'Join room' }).click();
    await expect(outsider.getByRole('alert')).toContainText(/full/i);
    await expect(rpc(outsider, 'room', { roomId })).rejects.toThrow(/Rejoin/);
    await expect(rpc(players[1]!.page, 'start', { roomId }, true)).rejects.toThrow(/Only the host/);
    await expect(rpc(host, 'createRoom', { rounds: 1 }, true)).rejects.toThrow(/current room/);
    const ninth = players.pop();
    await ninth?.context.close();
    baseline = await profiles();

    await host.getByRole('button', { name: 'Start race' }).click();
    await Promise.all(players.map(({ page }) => expect(page.getByRole('timer')).toBeVisible()));
    const codes1 = [10, 30, 50, 50, 50, 70, 90, 110].map((padding, index) => solution(padding, index === 7));
    const first = await submitBatch([...players.keys()], codes1);
    console.log('Round 1: all eight concurrent editor submissions passed.');
    expect(first.rankings.every((row) => row.code === null)).toBe(true);
    expect(first.problem).not.toHaveProperty('tests');
    expect(Array.from(codes1[7]!).length).toBeLessThan(codes1[7]!.length);
    const wrong = await rpc(players[5]!.page, 'submit', { roomId, code: 'class Solution:\n    def summaryRanges(self, nums):\n        return []\n' }, true);
    expect(wrong.solved).toBe(false);
    await rpc(players[6]!.page, 'submit', { roomId, code: `${codes1[6]}# longer\n` }, true);
    codes1[7] = solution(100, true);
    await rpc(players[7]!.page, 'submit', { roomId, code: codes1[7] }, true);
    const retained = await snapshot();
    for (const index of [5, 6, 7]) expect(retained.rankings.find((row) => row.userId === players[index]!.account.userId)?.charCount).toBe(Array.from(codes1[index]!).length);

    for (const index of [1, 3, 2, 5, 6, 7, 0]) await players[index]!.page.getByRole('button', { name: 'Lock score' }).click();
    await players[4]!.page.getByRole('button', { name: 'Resign' }).click();
    await expect(host.getByRole('heading', { name: 'Round 1 complete' })).toBeVisible();
    const round1 = await snapshot();
    assertRoundPoints(round1, Array.from({ length: 8 }, () => 0), codes1, [...players.keys()]);
    expect(round1.rankings.map((row) => row.userId)).toEqual([0, 1, 3, 2, 4, 5, 6, 7].map((index) => players[index]!.account.userId));
    expect(round1.rankings.find((row) => row.userId === players[7]!.account.userId)?.code).toBe(codes1[7]);
    scoreHistory.push(scores(round1, players));
    console.log('Round 1: character, lock ordering and exact points verified.');
    const firstRoundProfiles = await profiles();
    expect(firstRoundProfiles.every((profile, index) => profile.rating === baseline[index]!.rating
      && profile.solvedProblems >= baseline[index]!.solvedProblems
      && profile.solvedProblems <= baseline[index]!.solvedProblems + 1)).toBe(true);
    await players[1]!.page.getByRole('button', { name: `View ${players[0]!.account.username}'s code` }).click();
    await expect(players[1]!.page.getByRole('button', { name: 'Back to results' })).toBeVisible();
    await players[1]!.page.getByRole('button', { name: 'Back to results' }).click();
    await host.getByRole('button', { name: 'Continue', exact: true }).click();
    await Promise.all(players.map(({ page }) => expect(page.getByText('Round 2/3')).toBeVisible()));
    expect((await snapshot()).rankings.every((row) => row.code === null && !row.solved)).toBe(true);

    const codes2 = [10, 10, 90, 110, 130, 150, 170, 190].map((padding) => solution(padding));
    await submitBatch([...players.keys()], codes2);
    console.log('Round 2: all eight concurrent editor submissions passed.');
    await host.getByRole('button', { name: `Remove ${players[6]!.account.username} from room` }).click();
    settlementAtDeparture(6, scoreHistory[0]!);
    await players[6]!.page.goto('/');
    await expect(players[6]!.page.getByText(`Signed in as ${players[6]!.account.username}`)).toBeVisible();
    await assertRatings();
    console.log('Mid-round kick settled ratings using only round 1.');
    await expect(rpc(players[6]!.page, 'joinRoom', { roomId }, true)).rejects.toThrow(/removed/);

    await players[5]!.context.setOffline(true);
    await players[5]!.page.goto('about:blank');
    await expect.poll(async () => (await snapshot()).members.find((member) => member.userId === players[5]!.account.userId)?.online).toBe(false);
    await players[5]!.context.setOffline(false);
    await players[5]!.page.goto(`/room?id=${roomId}`);
    await expect(players[5]!.page.getByText('Round 2/3')).toBeVisible();
    expect((await rpc(players[5]!.page, 'room', { roomId })).me.submission?.solved).toBe(true);

    await players[7]!.page.goto('/profile');
    await expect.poll(async () => (await snapshot()).members.find((member) => member.userId === players[7]!.account.userId)?.online).toBe(false);
    for (const index of [1, 2, 3, 4, 5, 0]) await players[index]!.page.getByRole('button', { name: 'Lock score' }).click();
    expect((await snapshot()).state).toBe('playing');
    await expect(host.getByRole('heading', { name: 'Round 2 complete' })).toBeVisible({ timeout: 40_000 });
    settlementAtDeparture(7, scoreHistory[0]!);
    const round2 = await snapshot();
    assertRoundPoints(round2, scoreHistory[0]!, codes2, [0, 1, 2, 3, 4, 5]);
    expect(round2.members).toHaveLength(6);
    expect(round2.rankings[0]?.userId).toBe(players[1]!.account.userId);
    scoreHistory.push(scores(round2, players));
    expect(scoreHistory[1]![6]).toBe(scoreHistory[0]![6]);
    expect(scoreHistory[1]![7]).toBe(scoreHistory[0]![7]);
    await assertRatings();
    console.log('Round 2: reconnect and 30-second eviction settled correctly.');
    await expect(rpc(players[7]!.page, 'joinRoom', { roomId }, true)).rejects.toThrow(/already started/);

    await players[5]!.page.getByRole('button', { name: 'Leave room and go home' }).click();
    await expect(players[5]!.page).toHaveURL(/\/$/);
    settlementAtDeparture(5, scoreHistory[1]!);
    const afterDepartures = await assertRatings();
    await host.getByRole('button', { name: 'Continue', exact: true }).click();
    const remaining = [0, 1, 2, 3, 4];
    await Promise.all(remaining.map((index) => expect(players[index]!.page.getByText('Round 3/3')).toBeVisible()));
    const codes3 = [10, 50, 90, 130, 170].map((padding) => solution(padding));
    await submitBatch(remaining, codes3);
    console.log('Round 3: remaining five concurrent editor submissions passed.');
    for (const index of [4, 3, 2, 1, 0]) await players[index]!.page.getByRole('button', { name: 'Lock score' }).click();
    await expect(host.getByRole('heading', { name: 'Race complete' })).toBeVisible();
    const final = await snapshot();
    assertRoundPoints(final, scoreHistory[1]!, codes3, remaining);
    scoreHistory.push(scores(final, players));
    settle(remaining, scoreHistory[2]!);
    expect(settledPairs.size).toBe(28);
    const finalProfiles = await assertRatings();
    for (const index of [5, 6, 7]) expect(finalProfiles[index]!.rating).toBe(afterDepartures[index]!.rating);
    for (const [index, profile] of finalProfiles.entries()) {
      expect(profile.careerPoints).toBeCloseTo(baseline[index]!.careerPoints + scoreHistory[2]![index]!, 8);
      expect(profile.solvedProblems).toBe(firstRoundProfiles[index]!.solvedProblems);
      expect(profile.roundWins).toBe(baseline[index]!.roundWins + (index === 0 ? 2 : index === 1 ? 1 : 0));
      expect(profile.roundWinStreak).toBe(index === 0 ? 1 : 0);
      expect(profile.bestRoundWinStreak).toBe(Math.max(baseline[index]!.bestRoundWinStreak, index === 0 ? baseline[index]!.roundWinStreak + 1 : index === 1 ? 1 : 0));
      expect(profile.tournamentWins).toBe(baseline[index]!.tournamentWins + (index === 0 ? 1 : 0));
    }
    expect(final.standings).toHaveLength(8);
    expect(final.standings[0]?.userId).toBe(players[0]!.account.userId);
    await host.getByRole('link', { name: 'Tournament results' }).click();
    await expect(host).toHaveURL(/\/room\/results/);
    await expect(host.getByRole('table').first().getByRole('row')).toHaveCount(9);
    await host.reload();
    await expect(host.getByRole('table').first().getByRole('row')).toHaveCount(9);
    await host.goBack();
    await expect(host.getByRole('button', { name: 'Play again' })).toBeVisible();
    await host.getByRole('button', { name: 'Play again' }).click();
    await expect(host.getByRole('heading', { name: 'Room Invite' })).toBeVisible();
    const replay = await snapshot();
    expect(replay.rankings).toEqual([]);
    expect(replay.me.submission).toBeNull();
    expect(replay.problem).toBeNull();
    expect((await profiles()).map((profile) => profile.rating)).toEqual(finalProfiles.map((profile) => profile.rating));
    await host.getByRole('link', { name: 'Open player profile' }).click();
    await expect(host.getByRole('heading', { name: players[0]!.account.username })).toBeVisible();
    const careerPoints = host.locator('dl > div').filter({ has: host.getByText('Career points', { exact: true }) }).locator('dd');
    await expect(careerPoints).toHaveText(new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(finalProfiles[0]!.careerPoints));
    expect(pageErrors).toEqual([]);
    await testInfo.attach('eight-player-measurements', {
      body: JSON.stringify({ timingsMs: timings, completedRoundScores: scoreHistory, finalRatings: finalProfiles.map((profile) => profile.rating), settledPairs: settledPairs.size }, null, 2),
      contentType: 'application/json',
    });
    console.log(JSON.stringify({ players: 8, rounds: 3, submissionLatencyMs: timings.map((batch) => ({ min: Math.round(Math.min(...batch)), max: Math.round(Math.max(...batch)) })), finalRatings: finalProfiles.map((profile) => profile.rating), settledPairs: settledPairs.size }));
  } finally {
    await Promise.all(players.map(({ context }) => context.close()));
  }
});

test('eight on-time submissions drain through the round deadline without allowing late locks', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const players: Player[] = [];
  const pageErrors: string[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const created = await player(browser);
      created.page.on('pageerror', (error) => pageErrors.push(error.message));
      players.push(created);
    }
    const host = players[0]!.page;
    const baseline = await Promise.all(players.map(({ page }) => rpc(page, 'profile', undefined)));
    const { roomId } = await rpc(host, 'createRoom', { timeLimit: 30, rounds: 1 }, true);
    for (const [index, participant] of players.entries()) {
      if (index > 0) await rpc(participant.page, 'joinRoom', { roomId }, true);
      await participant.page.goto(`/room?id=${roomId}`);
      await expect(participant.page.getByRole('heading', { name: 'Room Invite' })).toBeVisible();
    }
    await host.getByRole('button', { name: 'Start race' }).click();
    await Promise.all(players.map(({ page }) => expect(page.getByRole('timer')).toBeVisible()));
    const started = await rpc(host, 'room', { roomId });
    expect(started.problem?.id).toBe('summary-ranges');
    const codes = players.map((_, index) => solution(index * 20));
    await host.waitForTimeout(Math.max(0, started.endsAt! - started.serverNow - 2200));
    console.log('Deadline stress: eight submissions sent with 2.2 seconds remaining.');
    const burstStarted = performance.now();
    const submissions = Promise.all(players.map(async ({ page }, index) => {
      const result = await rpc(page, 'submit', { roomId, code: codes[index]! }, true);
      return { result, latencyMs: performance.now() - burstStarted };
    }));
    await expect.poll(async () => (await rpc(host, 'room', { roomId })).rankings.some((row) => row.solved), {
      timeout: 15_000,
    }).toBe(true);
    const current = await rpc(host, 'room', { roomId });
    await host.waitForTimeout(Math.max(0, current.endsAt! - current.serverNow + 150));
    const afterDeadline = await rpc(host, 'room', { roomId });
    expect(afterDeadline.state).toBe('playing');
    expect(afterDeadline.remaining).toBe(0);
    const solvedUserId = afterDeadline.rankings.find((row) => row.solved)!.userId;
    const solvedPlayer = players.find(({ account }) => account.userId === solvedUserId)!;
    await expect(rpc(solvedPlayer.page, 'lock', { roomId }, true)).rejects.toThrow(/not playing/);
    await expect(rpc(solvedPlayer.page, 'resign', { roomId }, true)).rejects.toThrow(/not playing/);
    const healthStarted = performance.now();
    expect((await host.request.get('/health')).status()).toBe(200);
    const healthLatencyMs = performance.now() - healthStarted;
    expect(healthLatencyMs).toBeLessThan(3000);
    const completed = await submissions;
    expect(completed.every(({ result }) => result.solved && result.passed === 600 && result.submitTime < 30)).toBe(true);
    const final = await rpc(host, 'room', { roomId });
    expect(final.state).toBe('finished');
    expect(final.rankings.every((row) => row.solved && row.lockedAt === null)).toBe(true);
    const profiles = await Promise.all(players.map(({ page }) => rpc(page, 'profile', undefined)));
    for (const [index, profile] of profiles.entries()) {
      const delta = baseline.reduce((sum, opponent, opponentIndex) => opponentIndex === index ? sum
        : sum + 32 / 7 * ((index < opponentIndex ? 1 : 0) - 1 / (1 + 10 ** ((opponent.rating - baseline[index]!.rating) / 400))), 0);
      expect(profile.rating).toBeCloseTo(baseline[index]!.rating + delta, 8);
      expect(profile.careerPoints).toBeCloseTo(baseline[index]!.careerPoints + 200 / 3 * Array.from(codes[0]!).length / Array.from(codes[index]!).length, 8);
      expect(profile.solvedProblems).toBeGreaterThanOrEqual(baseline[index]!.solvedProblems);
      expect(profile.solvedProblems).toBeLessThanOrEqual(baseline[index]!.solvedProblems + 1);
      expect(profile.roundWins).toBe(baseline[index]!.roundWins + (index === 0 ? 1 : 0));
      expect(profile.tournamentWins).toBe(baseline[index]!.tournamentWins + (index === 0 ? 1 : 0));
    }
    expect(pageErrors).toEqual([]);
    const measurements = { healthLatencyMs, submissionLatencyMs: completed.map(({ latencyMs }) => Math.round(latencyMs)), latestSubmitTime: Math.max(...completed.map(({ result }) => result.submitTime)) };
    await testInfo.attach('deadline-queue-measurements', { body: JSON.stringify(measurements), contentType: 'application/json' });
    console.log(JSON.stringify(measurements));
  } finally {
    await Promise.all(players.map(({ context }) => context.close()));
  }
});
