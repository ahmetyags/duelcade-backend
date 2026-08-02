/**
 * Game state machine implementation.
 * Manages transitions between game phases per the state diagram in Bölüm 6.
 *
 * BOOT → AUTH_OPTIONAL → HOME → ROOM_SETUP → LOBBY → READY_CHECK →
 * ROLE_ASSIGNMENT → LOADING_LEVEL → PLAYING → PAUSED_LOCAL →
 * RECONNECTING → PLAYING | ABANDONED
 * PLAYING → COMPLETED | FAILED → RESULTS → REMATCH | HOME
 */

import type { GamePhase, FailReason, RoomStatus } from '@/types/game';

/** Valid state transitions mapped from the design bible. */
const TRANSITIONS: Record<GamePhase, GamePhase[]> = {
  boot: ['auth_optional'],
  auth_optional: ['home', 'boot'],
  home: ['room_setup', 'auth_optional'],
  room_setup: ['lobby', 'home'],
  lobby: ['ready_check', 'home', 'room_setup'],
  ready_check: ['role_assignment', 'lobby'],
  role_assignment: ['loading_level', 'lobby'],
  loading_level: ['playing', 'abandoned'],
  playing: ['paused_local', 'reconnecting', 'completed', 'failed', 'abandoned'],
  paused_local: ['playing', 'reconnecting', 'abandoned'],
  reconnecting: ['playing', 'abandoned', 'failed'],
  completed: ['results'],
  failed: ['results'],
  results: ['home', 'room_setup'],
  abandoned: ['home'],
};

/** Result of a transition attempt. */
export interface TransitionResult {
  readonly success: boolean;
  readonly from: GamePhase;
  readonly to: GamePhase;
  readonly error?: string;
}

/** Check if a transition is valid. */
export function isValidTransition(from: GamePhase, to: GamePhase): boolean {
  const allowed = TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

/**
 * Attempt a state transition.
 * Returns the result without mutating — the caller applies the new state.
 */
export function attemptTransition(
  current: GamePhase,
  target: GamePhase,
): TransitionResult {
  if (current === target) {
    return { success: true, from: current, to: target };
  }

  if (isValidTransition(current, target)) {
    return { success: true, from: current, to: target };
  }

  return {
    success: false,
    from: current,
    to: target,
    error: `Invalid transition: ${current} → ${target}`,
  };
}

/** Map game phase to room status. */
export function phaseToRoomStatus(phase: GamePhase): RoomStatus {
  switch (phase) {
    case 'lobby':
    case 'ready_check':
      return 'waiting';
    case 'role_assignment':
    case 'loading_level':
      return 'loading';
    case 'playing':
    case 'paused_local':
    case 'reconnecting':
      return 'playing';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'abandoned':
      return 'abandoned';
    default:
      return 'waiting';
  }
}

/** Determine if a phase allows player actions. */
export function isActionablePhase(phase: GamePhase): boolean {
  return phase === 'playing';
}

/** Determine if a phase is a terminal state. */
export function isTerminalPhase(phase: GamePhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'abandoned';
}

/** Determine if a phase requires network connectivity. */
export function requiresConnection(phase: GamePhase): boolean {
  return (
    phase === 'lobby' ||
    phase === 'ready_check' ||
    phase === 'role_assignment' ||
    phase === 'loading_level' ||
    phase === 'playing' ||
    phase === 'paused_local' ||
    phase === 'reconnecting'
  );
}

/** Get valid next phases from the current phase. */
export function getNextPhases(phase: GamePhase): GamePhase[] {
  return TRANSITIONS[phase] ?? [];
}

/** Check if a fail reason is valid for the current phase. */
export function isValidFailReason(
  phase: GamePhase,
  reason: FailReason,
): boolean {
  if (phase !== 'playing' && phase !== 'paused_local' && phase !== 'reconnecting') {
    return false;
  }

  switch (reason) {
    case 'time_expired':
    case 'alarm_triggered':
    case 'power_failure':
      return phase === 'playing';
    case 'player_left':
      return phase === 'playing' || phase === 'reconnecting' || phase === 'paused_local';
    case 'max_attempts_exceeded':
      return phase === 'playing';
    default:
      return false;
  }
}
