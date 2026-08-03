import type { Difficulty, GameResult, Player } from '../../types/game';
import type { TurnGameMode } from '../../types/turnGame';

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
}

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
}
