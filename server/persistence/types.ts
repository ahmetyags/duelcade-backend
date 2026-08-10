import type { Difficulty, GameResult, Player } from '../../types/game';
import type { TurnGameMode } from '../../types/turnGame';
import type {
  CoreMode,
  CosmeticDefinition,
  CosmeticType,
  QuestKey,
} from '../progression';
import type { AnalyticsEvent } from '../analytics';
import type { FeedbackSubmission } from '../feedback';

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

export type AccountProvider = 'email' | 'google' | 'facebook' | 'github' | 'firebase';

export interface CreateAccountSessionInput {
  playerId: string;
  displayName: string;
  provider: AccountProvider;
  providerSubject: string;
  email: string | null;
  passwordHash: string | null;
  sessionId: string;
  refreshTokenHash: string;
  refreshTokenExpiresAt: number;
}

export interface AccountCredential {
  player: StoredPlayer;
  passwordHash: string;
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  displayName: string;
  totalScore: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
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
  createEmailAccount?(input: CreateAccountSessionInput): Promise<StoredPlayer | null>;
  findEmailAccount?(email: string): Promise<AccountCredential | null>;
  createSessionForPlayer?(input: Omit<CreateAccountSessionInput, 'displayName' | 'provider' | 'providerSubject' | 'email' | 'passwordHash'>): Promise<StoredPlayer | null>;
  upsertOAuthAccount?(input: CreateAccountSessionInput): Promise<StoredPlayer>;
  listLeaderboard?(limit: number): Promise<LeaderboardEntry[]>;
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
  recordAnalyticsEvents(
    playerId: string,
    events: readonly AnalyticsEvent[],
  ): Promise<number>;
  recordFeedback(
    playerId: string,
    submission: FeedbackSubmission,
  ): Promise<boolean>;
}
