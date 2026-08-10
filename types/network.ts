/**
 * Network layer type definitions.
 * Defines the event contract between client and server,
 * following the authoritative server model from the design bible.
 */

import type { PlayerRole, RoomConfig, GameSnapshot, GameResult } from './game';
import type { ClientPuzzleState, PuzzleAction, PuzzleFeedback } from './puzzle';
import type { TurnMatchState } from './turnGame';

/** Protocol version for compatibility checking. */
export const PROTOCOL_VERSION = '1.10.0' as const;

/**
 * Application-owned WebSocket close codes.
 * Keep these outside Colyseus' reserved 4000-4010 range.
 */
export const SERVER_CLOSE_CODE = {
  HOST_LEFT: 4100,
  REGISTRATION_REJECTED: 4101,
  REGISTRATION_TIMEOUT: 4102,
} as const;

/** Common fields in every network message. */
export interface NetworkMessageBase {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly roomId: string;
  readonly playerId: string;
  readonly messageId: string;
  readonly sentAt: number;
}

/** Client → Server events. */
export type ClientEvent =
  | { event: 'room.create'; payload: RoomCreatePayload }
  | { event: 'room.join'; payload: RoomJoinPayload }
  | { event: 'room.leave'; payload: RoomLeavePayload }
  | { event: 'player.ready'; payload: PlayerReadyPayload }
  | { event: 'player.rolePreference'; payload: RolePreferencePayload }
  | { event: 'game.loaded'; payload: GameLoadedPayload }
  | { event: 'player.move'; payload: PlayerMovePayload }
  | { event: 'interaction.request'; payload: InteractionRequestPayload }
  | { event: 'puzzle.submit'; payload: PuzzleSubmitPayload }
  | { event: 'ping.send'; payload: PingSendPayload }
  | { event: 'chat.send'; payload: ChatSendPayload }
  | { event: 'rematch.vote'; payload: RematchVotePayload }
  | { event: 'request.hint'; payload: RequestHintPayload }
  | { event: 'match.forfeit'; payload: MatchForfeitPayload }
  | { event: 'round.skip.vote'; payload: RoundSkipVotePayload }
  | { event: 'turn.move'; payload: TurnMovePayload };

/** Server → Client events. */
export type ServerEvent =
  | { event: 'room.snapshot'; payload: RoomSnapshotPayload }
  | { event: 'player.joined'; payload: PlayerJoinedPayload }
  | { event: 'player.left'; payload: PlayerLeftPayload }
  | { event: 'role.assigned'; payload: RoleAssignedPayload }
  | { event: 'game.starting'; payload: GameStartingPayload }
  | { event: 'state.patch'; payload: StatePatchPayload }
  | { event: 'interaction.result'; payload: InteractionResultPayload }
  | { event: 'puzzle.feedback'; payload: PuzzleFeedbackPayload }
  | { event: 'puzzle.updated'; payload: PuzzleUpdatedPayload }
  | { event: 'checkpoint.saved'; payload: CheckpointSavedPayload }
  | { event: 'connection.warning'; payload: ConnectionWarningPayload }
  | { event: 'ping.received'; payload: PingReceivedPayload }
  | { event: 'chat.received'; payload: ChatReceivedPayload }
  | { event: 'game.completed'; payload: GameCompletedPayload }
  | { event: 'game.failed'; payload: GameFailedPayload }
  | { event: 'rematch.prompt'; payload: RematchPromptPayload }
  | { event: 'round.skip.updated'; payload: RoundSkipUpdatedPayload }
  | { event: 'error'; payload: ErrorPayload };

/** Full client message with base fields. */
export type ClientMessage = NetworkMessageBase & { payload: ClientEvent };

/** Full server message with base fields. */
export type ServerMessage = NetworkMessageBase & { payload: ServerEvent };

// ─── Payload definitions ───────────────────────────────────────────

export interface RoomCreatePayload {
  readonly displayName: string;
  readonly avatarId: import('./profile').PlayerAvatarId;
  readonly rolePreference: import('./game').RolePreference;
  readonly difficulty: import('./game').Difficulty;
  readonly matchDurationMinutes: number;
}

export interface RoomJoinPayload {
  readonly roomCode: string;
  readonly displayName: string;
  readonly avatarId: import('./profile').PlayerAvatarId;
  readonly rolePreference: import('./game').RolePreference;
}

export interface RoomLeavePayload {
  readonly reason: string;
}

export interface PlayerReadyPayload {
  readonly ready: boolean;
}

export interface RolePreferencePayload {
  readonly preference: import('./game').RolePreference;
}

export interface GameLoadedPayload {
  readonly loaded: boolean;
}

export interface PlayerMovePayload {
  readonly x: number;
  readonly y: number;
  readonly sequence: number;
  readonly timestamp: number;
}

export interface InteractionRequestPayload {
  readonly objectId: string;
  readonly interactionType: import('./game').InteractionType;
  readonly data: Record<string, unknown>;
  readonly clientActionId: number;
}

export interface PuzzleSubmitPayload {
  readonly puzzleId: string;
  readonly action: PuzzleAction;
  readonly clientActionId: number;
}

export interface PingSendPayload {
  readonly pingType: import('./game').PingType;
  readonly position: { x: number; y: number } | null;
}

export interface ChatSendPayload {
  readonly text: string;
}

export interface RematchVotePayload {
  readonly vote: boolean;
}

export interface RequestHintPayload {
  readonly puzzleId: string;
}

export interface TurnMovePayload {
  readonly cell: number;
  readonly expectedMove: number;
}

export interface MatchForfeitPayload {
  readonly reason: 'player_confirmed_exit';
}

export interface RoundSkipVotePayload {
  readonly vote: boolean;
}

export interface RoundSkipUpdatedPayload {
  readonly skipVotes: readonly [boolean, boolean];
  readonly requestedByPlayerId: string | null;
}

// ─── Server payload definitions ────────────────────────────────────

export interface RoomSnapshotPayload {
  readonly room: RoomConfig;
  readonly isReconnect: boolean;
}

export interface PlayerJoinedPayload {
  readonly player: import('./game').Player;
}

export interface PlayerLeftPayload {
  readonly playerId: string;
  readonly reason: string;
  readonly isHost: boolean;
}

export interface RoleAssignedPayload {
  readonly role: PlayerRole;
  readonly roles: Record<string, PlayerRole>;
}

export interface GameStartingPayload {
  readonly seed: string;
  readonly levelId: string;
  readonly loadTimeoutMs: number;
  readonly durationMs: number;
}

export interface StatePatchPayload {
  readonly patches: StatePatch[];
  readonly sequence: number;
}

export interface StatePatch {
  readonly path: string;
  readonly op: 'set' | 'remove' | 'append';
  readonly value: unknown;
}

export interface InteractionResultPayload {
  readonly result: import('./game').InteractionResult;
  readonly clientActionId: number;
}

export interface PuzzleFeedbackPayload {
  readonly puzzleId: string;
  readonly feedback: PuzzleFeedback;
  readonly clientActionId: number;
}

export interface PuzzleUpdatedPayload {
  readonly puzzle: ClientPuzzleState;
}

export interface CheckpointSavedPayload {
  readonly snapshot: GameSnapshot;
}

export interface ConnectionWarningPayload {
  readonly quality: import('./game').ConnectionQuality;
  readonly pingMs: number;
  readonly message: string;
}

export interface PingReceivedPayload {
  readonly ping: import('./game').PingEvent;
}

export interface ChatReceivedPayload {
  readonly message: import('./game').ChatMessage;
}

export interface GameCompletedPayload {
  readonly result: GameResult;
}

export interface GameFailedPayload {
  readonly result: GameResult;
}

export interface RematchPromptPayload {
  readonly playerId: string;
  readonly vote: boolean;
}

export interface ErrorPayload {
  readonly errorCode: string;
  readonly userMessageKey: string;
  readonly retryable: boolean;
  readonly details: string | null;
}

/** Known error codes from the backend architecture bible. */
export type KnownErrorCode =
  | 'AUTH_ERROR'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'PLAYER_NOT_READY'
  | 'INVALID_ACTION'
  | 'PUZZLE_VALIDATION_FAILED'
  | 'VERSION_MISMATCH'
  | 'HOST_LEFT'
  | 'DATABASE_ERROR'
  | 'RATE_LIMITED'
  | 'TIMEOUT';

/** Connection state for the network layer. */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/** Network layer event listener. */
export type ServerEventListener = (message: ServerMessage) => void;
