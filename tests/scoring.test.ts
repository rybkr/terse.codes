import { describe, expect, it } from 'vitest';
import { roundPoints } from '../server/scoring.js';

describe('round scoring', () => {
  it('weights actual character efficiency twice as much as normalized time', () => {
    expect(roundPoints(50, 15, 25, 30)).toBe(50);
    expect(roundPoints(25, 15, 25, 30)).toBeCloseTo(83.3333, 4);
    expect(roundPoints(25, 0, 25, 30)).toBe(100);
  });

  it('gives unlocked solves no time bonus and retains precision for nearby lock times', () => {
    expect(roundPoints(25, null, 25, 30)).toBeCloseTo(200 / 3, 10);
    expect(roundPoints(25, 5, 25, 30)).toBeGreaterThan(roundPoints(25, 10, 25, 30));
    expect(roundPoints(25, 10, 25, 30)).toBeGreaterThan(roundPoints(25, null, 25, 30));
    expect(roundPoints(25, 1.001, 25, 30)).not.toBe(roundPoints(25, 1.002, 25, 30));
  });

  it('gives unsolved or invalid results no points', () => {
    expect(roundPoints(null, null, 25, 30)).toBe(0);
    expect(roundPoints(25, 15, Infinity, 30)).toBe(0);
    expect(roundPoints(25, 15, 25, 0)).toBe(0);
  });
});
