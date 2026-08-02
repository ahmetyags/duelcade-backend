import type { Difficulty } from './game';

export type TurnGameMode =
  | 'rune_grid'
  | 'pipe_circuit'
  | 'connect_four'
  | 'resonance_dials'
  | 'memory_pairs'
  | 'cipher_clash'
  | 'circuit_claim'
  | 'neon_trail'
  | 'gateway_race'
  | 'polarity_war';
export type TurnMatchStatus =
  | 'playing'
  | 'resolving'
  | 'round_complete'
  | 'match_complete';

export interface TurnMatchState {
  roundId: string;
  mode: TurnGameMode;
  roundIndex: number;
  totalRounds: number;
  playerIds: [string, string];
  activePlayerIndex: 0 | 1;
  scores: [number, number];
  roundPoints: [number, number];
  /** Per-seat approval for skipping only the current round. */
  skipVotes: [boolean, boolean];
  cells: (number | null)[];
  cellOwners: (0 | 1 | null)[];
  selectedCells: number[];
  matchedCells: number[];
  status: TurnMatchStatus;
  winnerIndex: 0 | 1 | null;
  moveNumber: number;
  playerTimeMs: [number, number];
  tileKinds?: ('straight' | 'corner')[];
  targets?: number[];
  boardRows: number;
  boardColumns: number;
  winLength: number;
  difficulty: Difficulty;
  /** Current pawn/head locations for movement-based games. */
  playerPositions?: [number, number];
  /** Remaining placeable barriers in Gateway Race. */
  wallsRemaining?: [number, number];
  /** Number of symbols and slots used by Cipher Clash. */
  cipherSymbolCount?: number;
  cipherCodeLength?: number;
  /** Public feedback history; the server never sends either secret code. */
  cipherHistory?: CipherGuessFeedback[];
}

export interface CipherGuessFeedback {
  playerIndex: 0 | 1;
  guess: number[];
  exact: number;
  misplaced: number;
  /** Public indexes whose rune and position are both correct. */
  exactPositions: number[];
}

export interface TurnMatchSession {
  state: TurnMatchState;
  memoryDeck: number[];
  solution: number[];
  cipherSolutions: [number[], number[]];
  seed: string;
  modeOrder: TurnGameMode[];
  difficulty: Difficulty;
  playerTimeLimitMs: number;
}

export interface TurnMoveResult {
  accepted: boolean;
  reason?: 'not_playing' | 'not_your_turn' | 'stale_move' | 'invalid_cell';
  needsResolve?: boolean;
  roundEnded?: boolean;
}
