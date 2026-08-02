/**
 * Core game type definitions for Duelcade.
 * These types define the shared vocabulary between the game engine,
 * network layer, stores, and UI components.
 */

/** The two asymmetric roles in the game. */
export type PlayerRole = 'operator' | 'explorer';

/** Role preference before assignment. */
export type RolePreference = 'no_preference' | 'operator' | 'explorer';

/** Player identity within a session. */
export interface Player {
  readonly id: string;
  readonly displayName: string;
  readonly avatarId: PlayerAvatarId;
  role: PlayerRole | null;
  isHost: boolean;
  isReady: boolean;
  rolePreference: RolePreference;
  connected: boolean;
  lastSeenAt: number;
}

/** High-level game session state machine. */
export type GamePhase =
  | 'boot'
  | 'auth_optional'
  | 'home'
  | 'room_setup'
  | 'lobby'
  | 'ready_check'
  | 'role_assignment'
  | 'loading_level'
  | 'playing'
  | 'paused_local'
  | 'reconnecting'
  | 'completed'
  | 'failed'
  | 'results'
  | 'abandoned';

/** Room status lifecycle. */
export type RoomStatus = 'waiting' | 'ready_check' | 'loading' | 'playing' | 'completed' | 'failed' | 'abandoned';

/** Connection quality buckets derived from ping. */
export type ConnectionQuality = 'good' | 'warning' | 'critical' | 'disconnected';

/** Room configuration before game starts. */
export interface RoomConfig {
  readonly code: string;
  readonly hostId: string;
  status: RoomStatus;
  players: Player[];
  seed: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  maxPlayers: number;
  difficulty: Difficulty;
  puzzleCount: number;
  matchDurationMinutes: number;
  /** Local solo sessions use the same board model without creating a network room. */
  sessionMode?: 'multiplayer' | 'single_player';
}

/** Difficulty levels for procedural generation. */
export type Difficulty = 'easy' | 'medium' | 'hard' | 'final';

/** A checkpoint snapshot for reconnect. */
export interface GameSnapshot {
  readonly snapshotId: string;
  readonly roomId: string;
  readonly seed: string;
  readonly roles: Record<string, PlayerRole>;
  readonly currentRoomId: string;
  readonly solvedPuzzleIds: string[];
  readonly remainingTimeMs: number;
  readonly doorStates: Record<string, DoorState>;
  readonly powerStates: Record<string, PowerState>;
  readonly playerPosition: { x: number; y: number } | null;
  readonly createdAt: number;
  readonly attemptCount: number;
  readonly mistakeCount: number;
}

/** Door lock/open state. */
export interface DoorState {
  readonly id: string;
  locked: boolean;
  open: boolean;
  requiresPuzzleId: string | null;
  requiresKeyId: string | null;
}

/** Power circuit state. */
export interface PowerState {
  readonly id: string;
  active: boolean;
  load: number;
  maxLoad: number;
  connectedCircuits: string[];
}

/** Interactable object in the game world. */
export interface InteractableObject {
  readonly id: string;
  readonly type: ObjectType;
  readonly displayName: string;
  readonly position: { x: number; y: number };
  readonly interactionRadius: number;
  readonly allowedRoles: PlayerRole[];
  readonly puzzleId: string | null;
  readonly requiredItemId: string | null;
  readonly targetTags: string[];
  state: ObjectState;
  readonly inspectText?: string;
}

/** Role-filtered world data sent by the authoritative server. */
export interface WorldViewState {
  readonly width: number;
  readonly height: number;
  readonly objects: InteractableObject[];
  readonly playerPosition: { x: number; y: number; sequence?: number } | null;
}

/** Types of interactable objects. */
export type ObjectType =
  | 'door'
  | 'panel'
  | 'terminal'
  | 'safe'
  | 'fuse_box'
  | 'camera'
  | 'valve'
  | 'keypad'
  | 'lever'
  | 'cable_panel'
  | 'note'
  | 'key_card'
  | 'pressure_plate'
  | 'laser';

/** State of an interactable object. */
export type ObjectState = 'idle' | 'active' | 'locked' | 'unlocked' | 'open' | 'broken' | 'powered';

/** Interaction input types from the player. */
export type InteractionType = 'tap' | 'hold' | 'rotate' | 'drag_drop' | 'sequence' | 'dual_sync';

/** Result of an interaction attempt. */
export interface InteractionResult {
  readonly success: boolean;
  readonly objectId: string;
  readonly newState: ObjectState;
  readonly feedback: InteractionFeedback;
  readonly errorCode?: string;
  readonly userMessageKey?: string;
}

/** Feedback hierarchy: primary (animation), secondary (sound/haptic), tertiary (text). */
export interface InteractionFeedback {
  readonly animation: 'success' | 'error' | 'neutral' | 'alarm';
  readonly haptic: 'light' | 'medium' | 'heavy' | 'success' | 'error' | 'warning' | 'none';
  readonly soundKey: string;
  readonly messageKey?: string;
  readonly messageDuration?: number;
}

/** Ping types for non-verbal communication. */
export type PingType = 'look_here' | 'im_ready' | 'stop' | 'repeat';

export interface ChatMessage {
  readonly id: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly text: string;
  readonly sentAt: number;
}

/** A ping event in the world. */
export interface PingEvent {
  readonly id: string;
  readonly playerId: string;
  type: PingType;
  readonly position: { x: number; y: number } | null;
  createdAt: number;
  expiresAt: number;
}

/** Game session result data. */
export interface GameResult {
  readonly roomId: string;
  readonly success: boolean;
  readonly failReason: FailReason | null;
  readonly completionTimeMs: number;
  readonly remainingTimeMs: number;
  readonly mistakeCount: number;
  readonly puzzlesSolved: number;
  readonly totalPuzzles: number;
  readonly hintsUsed: number;
  readonly score: number;
  readonly roles: Record<string, PlayerRole>;
  readonly ending: GameEnding | null;
  readonly winnerPlayerId?: string | null;
  readonly playerScores?: Record<string, number>;
  readonly forfeitedPlayerId?: string | null;
}

/** Reasons the game can fail. */
export type FailReason = 'time_expired' | 'alarm_triggered' | 'power_failure' | 'player_left' | 'max_attempts_exceeded';

/** Multiple endings from the story bible. */
export type GameEnding = 'escape' | 'shutdown' | 'restore';

/** Score breakdown. */
export interface ScoreBreakdown {
  readonly baseCompletion: number;
  readonly remainingTimeBonus: number;
  readonly lowMistakeBonus: number;
  readonly communicationBonus: number;
  readonly total: number;
}

/** Connection status info. */
export interface ConnectionInfo {
  quality: ConnectionQuality;
  pingMs: number;
  reconnecting: boolean;
  gracePeriodRemainingMs: number | null;
}

/** Telemetry event types for analytics. */
export type TelemetryEvent =
  | 'session_created'
  | 'session_started'
  | 'session_completed'
  | 'session_failed'
  | 'session_abandoned'
  | 'puzzle_started'
  | 'puzzle_attempted'
  | 'puzzle_solved'
  | 'puzzle_timeout'
  | 'role_assigned'
  | 'reconnect_started'
  | 'reconnect_success'
  | 'reconnect_failed';
import type { PlayerAvatarId } from './profile';
