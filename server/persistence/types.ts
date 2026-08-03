import type { Difficulty, GameResult, Player } from '../../types/game';
import type { TurnGameMode } from '../../types/turnGame';
import type {
  CoreMode,
  CosmeticDefinition,
  CosmeticType,
  QuestKey,
} from '../progression';

export interface StoredPlayer {
  id: string;
  displayName: string;
  createdAt: number;
}

export interface CreateGuestSessionInput {
  playerId: string;
  displayName: string;
  sessionId: string;
  refreshTokenHash: string;
  refreshTokenExpiresAt: number;
}

export interface RotateSessionInput {
  currentRefreshTokenHash: string;
  nextRefreshTokenHash: string;
  nextRefreshTokenExpiresAt: number;
  now: number;
}

export interface MatchRecord {
  id: string;
  roomId: string;
  startedAt: number;
  finishedAt: number;
  difficulty: Difficulty;
  totalRounds: number;
  modeOrder: TurnGameMode[];
  players: Player[];
  authenticatedPlayerIds: ReadonlySet<string>;
  result: GameResult;
}

export interface MatchHistoryItem {
  id: string;
  roomId: string;
  startedAt: number;
  finishedAt: number;
  difficulty: Difficulty;
  totalRounds: number;
  modeOrder: TurnGameMode[];
  winnerPlayerId: string | null;
  forfeitedPlayerId: string | null;
  score: number;
  opponentDisplayName: string;
  opponentScore: number;
  xpEarned: number;
}

export interface ModeMastery {
  mode: CoreMode;
  xp: number;
  matchesPlayed: number;
}

export interface InventoryItem {
  type: CosmeticType;
  itemId: string;
  unlockedAt: number;
  source: string;
}

export interface DailyQuest {
  key: QuestKey;
  date: string;
  progress: number;
  target: number;
  rewardXp: number;
  claimed: boolean;
}

export interface PlayerProgression {
  totalXp: number;
  level: number;
  currentLevelXp: number;
  nextLevelXp: number;
  equipped: {
    avatar: string;
    frame: string;
    tableTheme: string;
  };
  mastery: ModeMastery[];
  inventory: InventoryItem[];
  catalog: readonly CosmeticDefinition[];
  dailyQuests: DailyQuest[];
}

export type QuestClaimResult =
  | { status: 'claimed'; progression: PlayerProgression }
  | { status: 'not_found' | 'not_complete' | 'already_claimed' };

export type EquipCosmeticResult =
  | { status: 'equipped'; progression: PlayerProgression }
  | { status: 'invalid_item' | 'not_owned' };

export interface PersistenceStore {
  readonly available: boolean;
  initialize(): Promise<void>;
  close(): Promise<void>;
  createGuestSession(input: CreateGuestSessionInput): Promise<StoredPlayer>;
  rotateSession(input: RotateSessionInput): Promise<{
    player: StoredPlayer;
    sessionId: string;
  } | null>;
  revokeSession(refreshTokenHash: string): Promise<void>;
  updatePlayerName(playerId: string, displayName: string): Promise<StoredPlayer | null>;
  getPlayer(playerId: string): Promise<StoredPlayer | null>;
  recordMatch(record: MatchRecord): Promise<void>;
  listMatches(playerId: string, limit: number): Promise<MatchHistoryItem[]>;
  getProgression(playerId: string, date: string): Promise<PlayerProgression | null>;
  claimDailyQuest(
    playerId: string,
    date: string,
    questKey: QuestKey,
  ): Promise<QuestClaimResult>;
  equipCosmetic(
    playerId: string,
    type: CosmeticType,
    itemId: string,
    date: string,
  ): Promise<EquipCosmeticResult>;
}
