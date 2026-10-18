/** Scores a solve with `100 * (2 * minSolvedChars / charCount + timeBonus) / 3`; an unlocked solve has a zero time bonus. */
export function roundPoints(
  charCount: number | null,
  finishTime: number | null,
  minSolvedChars: number,
  durationSeconds: number,
): number {
  if (charCount === null || minSolvedChars === Infinity || charCount <= 0 || durationSeconds <= 0) return 0;
  const characterScore = minSolvedChars / charCount;
  const timeScore = finishTime === null ? 0 : Math.max(0, Math.min(1, 1 - finishTime / durationSeconds));
  return 100 * (2 * characterScore + timeScore) / 3;
}
