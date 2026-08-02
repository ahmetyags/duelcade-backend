/**
 * Puzzle system type definitions.
 * Defines the modular puzzle architecture, procedural generation contracts,
 * and per-role state isolation as specified in the Puzzle System Bible.
 */

import type { Difficulty, PlayerRole } from './game';

/** All puzzle module categories from the design bible. */
export type PuzzleCategory =
  | 'code'
  | 'color'
  | 'symbol'
  | 'logic'
  | 'circuit'
  | 'map'
  | 'timing'
  | 'pressure_plate'
  | 'camera'
  | 'memory_sequence';

/** Puzzle lifecycle phases — server-authoritative. */
export type PuzzlePhase = 'locked' | 'active' | 'solved' | 'failed';

/** Unique identifier for a puzzle template in the registry. */
export type PuzzleTemplateId = string;

/** Unique identifier for a puzzle instance in a room. */
export type PuzzleInstanceId = string;

/**
 * The full state of a puzzle instance, as held by the server.
 * Private states are never sent to the wrong role.
 * The solution key is never included in any client payload.
 */
export interface PuzzleState {
  readonly puzzleId: PuzzleInstanceId;
  readonly templateId: PuzzleTemplateId;
  readonly category: PuzzleCategory;
  phase: PuzzlePhase;
  attemptCount: number;
  maxAttempts: number | null;
  startedAt: number | null;
  deadlineAt: number | null;
  /** Visible to both players. */
  publicState: Record<string, unknown>;
  /** Visible only to the operator. */
  operatorPrivateState: Record<string, unknown>;
  /** Visible only to the explorer. */
  explorerPrivateState: Record<string, unknown>;
  /** Never sent to any client. Server-only. */
  readonly solution: PuzzleSolution;
  /** Hints that can be unlocked after the 5-minute cooldown. */
  readonly hints: PuzzleHint[];
  hintsRevealed: number;
  hintCooldownMs: number;
  /** Operator-only decoding challenge that must be solved before clues appear. */
  guideChallenge?: GuideChallengeState;
  /** Server-only answer for the guide challenge. */
  guideChallengeAnswer?: string;
  /** Server-only generated route data used to validate path challenges. */
  guideChallengeSolution?: ColorPathSubmission[];
  guideSolved?: boolean;
  guideAttemptCount?: number;
  /** Explorer must activate the matching station on the map. */
  fieldUnlocked?: boolean;
}

export type GuideChallengeState =
  | {
      readonly kind: 'number_sequence';
      readonly sequence: number[];
      readonly options: number[];
      readonly maxAttempts: number;
    }
  | {
      readonly kind: 'rune_equation';
      readonly equations: {
        readonly runes: string[];
        readonly total: number;
      }[];
      readonly question: string;
      readonly options: number[];
      readonly maxAttempts: number;
    }
  | {
      readonly kind: 'color_paths';
      readonly gridSize: 5 | 6;
      readonly pairs: ColorPathPair[];
      readonly requireFullCoverage: true;
      readonly maxAttempts: number;
    };

export interface ColorPathPair {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly start: number;
  readonly end: number;
}

export interface ColorPathSubmission {
  readonly pairId: string;
  readonly cells: number[];
}

/** The solution data — server-only, never serialized to clients. */
export interface PuzzleSolution {
  readonly answer: unknown;
  readonly validationRule: ValidationRule;
}

/** How the server validates a player's submission. */
export type ValidationRule =
  | 'exact_match'
  | 'sequence_match'
  | 'set_match'
  | 'circuit_topology'
  | 'timing_window'
  | 'coordinate_match'
  | 'memory_replay'
  | 'custom';

/** A hint that guides without revealing the solution. */
export interface PuzzleHint {
  readonly id: string;
  readonly textKey: string;
  readonly revealAfterMs: number;
  readonly guidanceLevel: 1 | 2 | 3;
}

/** Actions a player can submit for a puzzle. */
export type PuzzleAction =
  | { type: 'solve_guide'; answer: string }
  | { type: 'solve_guide_paths'; paths: ColorPathSubmission[] }
  | { type: 'submit_code'; code: string | number[] }
  | { type: 'submit_sequence'; sequence: string[] }
  | { type: 'connect_circuit'; connections: CircuitConnection[] }
  | { type: 'press_plate'; plateId: string }
  | { type: 'rotate_valve'; valveId: string; angle: number }
  | { type: 'memory_replay'; sequence: string[] }
  | { type: 'rotate_pipes'; rotations: number[] }
  | { type: 'tune_frequencies'; frequencies: number[] }
  | { type: 'activate'; }
  | { type: 'request_hint' };

/** A circuit connection for electrical puzzles. */
export interface CircuitConnection {
  readonly fromNode: string;
  readonly toNode: string;
}

/** Result of a puzzle action validation. */
export interface PuzzleActionResult {
  readonly puzzleId: PuzzleInstanceId;
  readonly success: boolean;
  readonly newPhase: PuzzlePhase;
  readonly attemptCount: number;
  readonly remainingAttempts: number | null;
  readonly feedback: PuzzleFeedback;
  readonly updatedPublicState: Record<string, unknown> | null;
  readonly updatedPrivateState: Record<string, unknown> | null;
  readonly unlockedPuzzleIds: string[];
  readonly unlockedDoorIds: string[];
  readonly hint?: PuzzleHint;
}

/** Feedback for a puzzle attempt. */
export interface PuzzleFeedback {
  readonly correct: boolean;
  readonly messageKey: string;
  readonly alarmTriggered: boolean;
  readonly timePenaltyMs: number;
}

/** Configuration for generating a puzzle procedurally. */
export interface PuzzleGenerationConfig {
  readonly templateId: PuzzleTemplateId;
  readonly category: PuzzleCategory;
  readonly difficulty: Difficulty;
  readonly seed: string;
  readonly roomId: string;
  readonly roomIndex: number;
  readonly roleDistribution: RoleDistribution;
  readonly maxAttempts?: number;
}

/** Which role sees which pieces of information. */
export interface RoleDistribution {
  readonly operatorInfo: string[];
  readonly explorerInfo: string[];
}

/** Template definition for a puzzle module in the registry. */
export interface PuzzleTemplate {
  readonly id: PuzzleTemplateId;
  readonly category: PuzzleCategory;
  readonly displayName: string;
  readonly description: string;
  readonly difficultyRange: Difficulty[];
  readonly generator: PuzzleGeneratorFn;
  readonly validator: PuzzleValidatorFn;
  readonly maxAttemptsDefault: number | null;
  readonly timeLimitMs: number | null;
}

/** Function signature for procedural puzzle generation. */
export type PuzzleGeneratorFn = (
  config: PuzzleGenerationConfig,
) => Omit<PuzzleState, 'puzzleId'>;

/** Function signature for validating a puzzle action server-side. */
export type PuzzleValidatorFn = (
  state: PuzzleState,
  action: PuzzleAction,
  role: PlayerRole,
) => PuzzleActionResult;

/** Filtered puzzle state sent to a specific client — never includes solution. */
export interface ClientPuzzleState {
  readonly puzzleId: PuzzleInstanceId;
  readonly templateId: PuzzleTemplateId;
  readonly category: PuzzleCategory;
  phase: PuzzlePhase;
  attemptCount: number;
  maxAttempts: number | null;
  startedAt: number | null;
  deadlineAt: number | null;
  publicState: Record<string, unknown>;
  privateState: Record<string, unknown>;
  hintsRevealed: number;
  availableHints: number;
  /** Only hints already unlocked by the server; future hint text stays private. */
  revealedHints: PuzzleHint[];
  guideChallenge: GuideChallengeState | null;
  guideSolved: boolean;
  guideAttemptCount: number;
  fieldUnlocked: boolean;
}

/** Room template with puzzle slots for procedural generation. */
export interface RoomTemplate {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly puzzleSlots: PuzzleSlot[];
  readonly decorSlots: DecorSlot[];
  readonly entryPoint: { x: number; y: number };
  readonly exitPoint: { x: number; y: number };
  readonly bounds: { width: number; height: number };
  readonly themeColor: string;
}

/** A slot where a puzzle can be placed. */
export interface PuzzleSlot {
  readonly id: string;
  readonly position: { x: number; y: number };
  readonly allowedCategories: PuzzleCategory[];
  readonly allowedRoles: PlayerRole[];
}

/** A decorative slot for atmosphere. */
export interface DecorSlot {
  readonly id: string;
  readonly position: { x: number; y: number };
  readonly decorType: string;
}

/** A generated level containing multiple rooms. */
export interface GeneratedLevel {
  readonly levelId: string;
  readonly seed: string;
  readonly rooms: GeneratedRoom[];
  readonly roomOrder: string[];
  readonly totalPuzzleCount: number;
  readonly difficulty: Difficulty;
}

/** A room that has been procedurally populated. */
export interface GeneratedRoom {
  readonly roomTemplateId: string;
  readonly displayName: string;
  readonly puzzles: PuzzleState[];
  readonly objects: import('./game').InteractableObject[];
  readonly doors: import('./game').DoorState[];
  readonly powerCircuits: import('./game').PowerState[];
  readonly decor: DecorPlacement[];
}

/** A placed decoration. */
export interface DecorPlacement {
  readonly slotId: string;
  readonly decorType: string;
  readonly position: { x: number; y: number };
}
