/**
 * Score calculation service.
 * Implements the scoring formula from Bölüm 10 (Süre, başarısızlık ve skor sistemi):
 *
 * score = baseCompletionScore + remainingTimeBonus + lowMistakeBonus + communicationBonus
 */

import type { ScoreBreakdown, GameResult } from '@/types/game';

/** Score constants tuned for a 20-minute session. */
const SCORE_CONSTANTS = {
  baseCompletion: 1000,
  remainingTimePerSecond: 5,
  remainingTimeMaxBonus: 3000,
  lowMistakeThreshold: 3,
  lowMistakeBonus: 500,
  noMistakeBonus: 1000,
  communicationBonusPerPing: 2,
  communicationMaxBonus: 200,
  hintPenaltyPerHint: 100,
  firstTryBonus: 500,
} as const;

/**
 * Calculate the full score breakdown from game result data.
 * @param params - Game outcome data.
 * @returns Detailed score breakdown.
 */
export function calculateScore(params: {
  completed: boolean;
  remainingTimeMs: number;
  mistakeCount: number;
  hintsUsed: number;
  pingCount: number;
  firstTryPuzzles: number;
  totalPuzzles: number;
}): ScoreBreakdown {
  if (!params.completed) {
    return {
      baseCompletion: 0,
      remainingTimeBonus: 0,
      lowMistakeBonus: 0,
      communicationBonus: 0,
      total: 0,
    };
  }

  // Base completion score
  const baseCompletion = SCORE_CONSTANTS.baseCompletion;

  // Remaining time bonus (capped)
  const remainingSeconds = Math.floor(params.remainingTimeMs / 1000);
  const remainingTimeBonus = Math.min(
    remainingSeconds * SCORE_CONSTANTS.remainingTimePerSecond,
    SCORE_CONSTANTS.remainingTimeMaxBonus,
  );

  // Low mistake bonus
  let lowMistakeBonus = 0;
  if (params.mistakeCount === 0) {
    lowMistakeBonus = SCORE_CONSTANTS.noMistakeBonus;
  } else if (params.mistakeCount <= SCORE_CONSTANTS.lowMistakeThreshold) {
    lowMistakeBonus = SCORE_CONSTANTS.lowMistakeBonus;
  }

  // Communication bonus from ping usage
  const communicationBonus = Math.min(
    params.pingCount * SCORE_CONSTANTS.communicationBonusPerPing,
    SCORE_CONSTANTS.communicationMaxBonus,
  );

  // Apply hint penalty and first-try bonus as adjustments to base
  const hintPenalty = params.hintsUsed * SCORE_CONSTANTS.hintPenaltyPerHint;
  const firstTryBonus =
    params.firstTryPuzzles === params.totalPuzzles
      ? SCORE_CONSTANTS.firstTryBonus
      : params.firstTryPuzzles * 100;

  const total = Math.max(
    0,
    baseCompletion +
      remainingTimeBonus +
      lowMistakeBonus +
      communicationBonus +
      firstTryBonus -
      hintPenalty,
  );

  return {
    baseCompletion: baseCompletion + firstTryBonus - hintPenalty,
    remainingTimeBonus,
    lowMistakeBonus,
    communicationBonus,
    total,
  };
}

/** Format time in ms to a human-readable MM:SS string. */
export function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/** Format time in ms to a detailed string with hours if needed. */
export function formatTimeDetailed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/** Create a GameResult from session data. */
export function createGameResult(params: {
  roomId: string;
  success: boolean;
  failReason: GameResult['failReason'];
  startTimeMs: number;
  endTimeMs: number;
  remainingTimeMs: number;
  mistakeCount: number;
  puzzlesSolved: number;
  totalPuzzles: number;
  hintsUsed: number;
  pingCount: number;
  firstTryPuzzles: number;
  roles: Record<string, import('@/types/game').PlayerRole>;
  ending: GameResult['ending'];
}): GameResult {
  const score = calculateScore({
    completed: params.success,
    remainingTimeMs: params.remainingTimeMs,
    mistakeCount: params.mistakeCount,
    hintsUsed: params.hintsUsed,
    pingCount: params.pingCount,
    firstTryPuzzles: params.firstTryPuzzles,
    totalPuzzles: params.totalPuzzles,
  });

  return {
    roomId: params.roomId,
    success: params.success,
    failReason: params.failReason,
    completionTimeMs: params.endTimeMs - params.startTimeMs,
    remainingTimeMs: params.remainingTimeMs,
    mistakeCount: params.mistakeCount,
    puzzlesSolved: params.puzzlesSolved,
    totalPuzzles: params.totalPuzzles,
    hintsUsed: params.hintsUsed,
    score: score.total,
    roles: params.roles,
    ending: params.ending,
  };
}
