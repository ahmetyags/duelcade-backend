import type { MatchRecord } from './persistence/types';
import type { TurnGameMode } from '../types/turnGame';

export const CORE_MODES = [
  'rune_grid',
  'memory_pairs',
  'circuit_claim',
  'neon_trail',
] as const satisfies readonly TurnGameMode[];

export type CoreMode = typeof CORE_MODES[number];
export type CosmeticType = 'avatar' | 'frame' | 'table_theme';
export type QuestKey = 'play_duel' | 'win_duel' | 'win_rounds';

export interface CosmeticDefinition {
  type: CosmeticType;
  itemId: string;
  unlockLevel: number;
}

export interface QuestDefinition {
  key: QuestKey;
  target: number;
  rewardXp: number;
}

export const COSMETIC_CATALOG: readonly CosmeticDefinition[] = [
  { type: 'avatar', itemId: 'sparkles', unlockLevel: 1 },
  { type: 'avatar', itemId: 'bolt', unlockLevel: 1 },
  { type: 'avatar', itemId: 'gamepad', unlockLevel: 1 },
  { type: 'frame', itemId: 'default', unlockLevel: 1 },
  { type: 'table_theme', itemId: 'classic', unlockLevel: 1 },
  { type: 'avatar', itemId: 'bot', unlockLevel: 2 },
  { type: 'frame', itemId: 'neon', unlockLevel: 3 },
  { type: 'avatar', itemId: 'shield', unlockLevel: 3 },
  { type: 'avatar', itemId: 'cat', unlockLevel: 4 },
  { type: 'table_theme', itemId: 'midnight', unlockLevel: 4 },
  { type: 'avatar', itemId: 'flame', unlockLevel: 5 },
  { type: 'avatar', itemId: 'rocket', unlockLevel: 6 },
  { type: 'frame', itemId: 'ember', unlockLevel: 6 },
  { type: 'avatar', itemId: 'gem', unlockLevel: 7 },
  { type: 'avatar', itemId: 'swords', unlockLevel: 8 },
  { type: 'table_theme', itemId: 'aurora', unlockLevel: 8 },
  { type: 'avatar', itemId: 'crown', unlockLevel: 10 },
  { type: 'frame', itemId: 'royal', unlockLevel: 10 },
  { type: 'avatar', itemId: 'trophy', unlockLevel: 12 },
] as const;

export const DAILY_QUESTS: readonly QuestDefinition[] = [
  { key: 'play_duel', target: 1, rewardXp: 40 },
  { key: 'win_duel', target: 1, rewardXp: 60 },
  { key: 'win_rounds', target: 3, rewardXp: 50 },
] as const;

export function utcDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function xpFloorForLevel(level: number): number {
  const completedLevels = Math.max(0, Math.floor(level) - 1);
  return completedLevels * 100
    + (completedLevels * Math.max(0, completedLevels - 1) * 25) / 2;
}

export function levelFromXp(totalXp: number): number {
  const safeXp = Math.max(0, Math.floor(totalXp));
  let level = 1;
  while (xpFloorForLevel(level + 1) <= safeXp && level < 100) level += 1;
  return level;
}

export function levelProgress(totalXp: number): {
  level: number;
  currentLevelXp: number;
  nextLevelXp: number;
} {
  const safeXp = Math.max(0, Math.floor(totalXp));
  const level = levelFromXp(safeXp);
  const floor = xpFloorForLevel(level);
  return {
    level,
    currentLevelXp: safeXp - floor,
    nextLevelXp: xpFloorForLevel(level + 1) - floor,
  };
}

export function matchXpForPlayer(record: MatchRecord, playerId: string): number {
  const forfeited = record.result.forfeitedPlayerId === playerId;
  const winner = record.result.winnerPlayerId === playerId;
  const draw = record.result.winnerPlayerId == null;
  const score = Math.max(0, record.result.playerScores?.[playerId] ?? 0);
  return (forfeited ? 10 : 30)
    + (winner ? 20 : draw ? 10 : 0)
    + Math.min(25, score * 5);
}

export function masteryXpForPlayer(record: MatchRecord, playerId: string): number {
  return 10 + (record.result.winnerPlayerId === playerId ? 5 : 0);
}

export function coreModesInMatch(record: MatchRecord): CoreMode[] {
  return [...new Set(record.modeOrder)]
    .filter((mode): mode is CoreMode => (CORE_MODES as readonly string[]).includes(mode));
}

export function findCosmetic(
  type: CosmeticType,
  itemId: string,
): CosmeticDefinition | null {
  return COSMETIC_CATALOG.find(
    (item) => item.type === type && item.itemId === itemId,
  ) ?? null;
}
