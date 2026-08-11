import { Client, Room, type AuthContext } from 'colyseus';
import { z } from 'zod';

import { SeededRandom } from '../engine/SeededRandom';
import { validateColorPathSubmission } from '../engine/ColorPathPuzzle';
import {
  filterPuzzleForClient,
  generateLevel,
  validatePuzzleAction,
} from '../engine/PuzzleRegistry';
import { createGameResult } from '../engine/ScoreCalculator';
import {
  advanceTurnRound,
  applyTurnMove,
  createTurnMatchSession,
  normalizeMatchDurationMinutes,
  resolveMemoryTurn,
  roundCountForDuration,
  skipTurnRound,
  tickTurnClock,
} from '../engine/TurnGameEngine';
import type {
  Difficulty,
  DoorState,
  FailReason,
  GameResult,
  GameSnapshot,
  InteractableObject,
  Player,
  PlayerRole,
  RolePreference,
} from '../types/game';
import type {
  ClientEvent,
  ServerEvent,
  ServerMessage,
} from '../types/network';
import { PROTOCOL_VERSION, SERVER_CLOSE_CODE } from '../types/network';
import type { PuzzleState } from '../types/puzzle';
import type { TurnMatchSession } from '../types/turnGame';
import { PLAYER_AVATAR_IDS, type PlayerAvatarId } from '../types/profile';
import {
  authenticateRoomClient,
  createDisabledRuntime,
  persistMatch,
  type BackendRuntime,
  type RoomAuthData,
} from './runtime';
import { utcDateKey } from './progression';

const DEFAULT_MATCH_DURATION_MINUTES = 5;
const RECONNECT_GRACE_SECONDS = 60;
export const ROOM_REGISTRATION_TIMEOUT_MS = 5_000;
const ROOM_ID_CHANNEL = '$duelcade_room_ids';

const JoinOptionsSchema = z.object({
  playerId: z.string().min(3).max(96),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});

const RolePreferenceSchema = z.enum(['no_preference', 'operator', 'explorer']);
const DifficultySchema = z.enum(['easy', 'medium', 'hard', 'final']);
const PlayerAvatarIdSchema = z.enum(PLAYER_AVATAR_IDS);
const PositionSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const ActionIdSchema = z.number().int().nonnegative().safe();
const PuzzleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('solve_guide'), answer: z.string().max(32) }),
  z.object({
    type: z.literal('solve_guide_paths'),
    paths: z.array(z.object({
      pairId: z.string().min(1).max(32),
      cells: z.array(z.number().int().min(0).max(63)).min(2).max(36),
    })).min(2).max(6),
  }),
  z.object({ type: z.literal('submit_code'), code: z.union([
    z.string().max(16),
    z.array(z.number().int().min(0).max(9)).max(16),
  ]) }),
  z.object({ type: z.literal('submit_sequence'), sequence: z.array(z.string().max(32)).max(20) }),
  z.object({
    type: z.literal('connect_circuit'),
    connections: z.array(z.object({
      fromNode: z.string().max(32),
      toNode: z.string().max(32),
    })).max(20),
  }),
  z.object({ type: z.literal('press_plate'), plateId: z.string().max(64) }),
  z.object({
    type: z.literal('rotate_valve'),
    valveId: z.string().max(64),
    angle: z.number().finite().min(-360).max(360),
  }),
  z.object({ type: z.literal('memory_replay'), sequence: z.array(z.string().max(32)).max(20) }),
  z.object({
    type: z.literal('rotate_pipes'),
    rotations: z.array(z.number().int().min(0).max(3)).length(9),
  }),
  z.object({
    type: z.literal('tune_frequencies'),
    frequencies: z.array(z.number().int().min(20).max(5000)).min(2).max(5),
  }),
  z.object({ type: z.literal('activate') }),
  z.object({ type: z.literal('request_hint') }),
]);

const ClientEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('room.create'),
    payload: z.object({
      displayName: z.string().max(24),
      avatarId: PlayerAvatarIdSchema,
      rolePreference: RolePreferenceSchema,
      difficulty: DifficultySchema,
      matchDurationMinutes: z.number().int().min(2).max(25),
    }),
  }),
  z.object({
    event: z.literal('room.join'),
    payload: z.object({
      roomCode: z.string().length(6),
      displayName: z.string().max(24),
      avatarId: PlayerAvatarIdSchema,
      rolePreference: RolePreferenceSchema,
    }),
  }),
  z.object({ event: z.literal('room.sync'), payload: z.object({}) }),
  z.object({ event: z.literal('room.leave'), payload: z.object({ reason: z.string().max(64) }) }),
  z.object({ event: z.literal('player.ready'), payload: z.object({ ready: z.boolean() }) }),
  z.object({
    event: z.literal('player.rolePreference'),
    payload: z.object({ preference: RolePreferenceSchema }),
  }),
  z.object({ event: z.literal('game.loaded'), payload: z.object({ loaded: z.boolean() }) }),
  z.object({
    event: z.literal('player.move'),
    payload: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      sequence: ActionIdSchema,
      timestamp: z.number().finite().nonnegative(),
    }),
  }),
  z.object({
    event: z.literal('interaction.request'),
    payload: z.object({
      objectId: z.string().max(96),
      interactionType: z.enum(['tap', 'hold', 'rotate', 'drag_drop', 'sequence', 'dual_sync']),
      data: z.record(z.string(), z.unknown()),
      clientActionId: ActionIdSchema,
    }),
  }),
  z.object({
    event: z.literal('puzzle.submit'),
    payload: z.object({
      puzzleId: z.string().max(160),
      action: PuzzleActionSchema,
      clientActionId: ActionIdSchema,
    }),
  }),
  z.object({
    event: z.literal('ping.send'),
    payload: z.object({
      pingType: z.enum(['look_here', 'im_ready', 'stop', 'repeat']),
      position: PositionSchema.nullable(),
    }),
  }),
  z.object({
    event: z.literal('chat.send'),
    payload: z.object({ text: z.string().trim().min(1).max(240) }),
  }),
  z.object({ event: z.literal('rematch.vote'), payload: z.object({ vote: z.boolean() }) }),
  z.object({
    event: z.literal('request.hint'),
    payload: z.object({ puzzleId: z.string().max(160) }),
  }),
  z.object({
    event: z.literal('turn.move'),
    payload: z.object({
      cell: z.number().int().min(0).max(1_000_000),
      expectedMove: ActionIdSchema,
    }),
  }),
  z.object({
    event: z.literal('match.forfeit'),
    payload: z.object({ reason: z.literal('player_confirmed_exit') }),
  }),
  z.object({
    event: z.literal('round.skip.vote'),
    payload: z.object({ vote: z.boolean() }),
  }),
]);

interface ClientData {
  playerId: string;
  registered: boolean;
  authenticated: boolean;
  authoritativeAvatarId?: PlayerAvatarId;
}

interface PlayerPosition {
  x: number;
  y: number;
  sequence: number;
}

interface EscapeState {
  players: Player[];
  seed: string;
  difficulty: Difficulty;
  puzzleCount: number;
  matchDurationMinutes: number;
  status: 'waiting' | 'loading' | 'playing' | 'completed' | 'failed';
  puzzles: PuzzleState[];
  puzzleOrder: string[];
  solvedPuzzleIds: string[];
  doors: DoorState[];
  objects: InteractableObject[];
  positions: Map<string, PlayerPosition>;
  mistakeCount: number;
  hintsUsed: number;
  pingCount: number;
  firstTryPuzzles: number;
  startedAt: number | null;
  finishedAt: number | null;
  remainingTimeMs: number;
  durationMs: number;
  snapshots: GameSnapshot[];
  rematchVotes: Set<string>;
  result: GameResult | null;
  turnSession: TurnMatchSession | null;
  lastTurnTickAt: number | null;
  forfeitedPlayerId: string | null;
  authenticatedPlayerIds: Set<string>;
  matchPersisted: boolean;
}

type EscapeClient = Client<{ userData: ClientData }>;

function makeWorldObjects(): InteractableObject[] {
  return [
    {
      id: 'note_access_log',
      type: 'note',
      displayName: 'Access Log',
      position: { x: 18, y: 22 },
      interactionRadius: 14,
      allowedRoles: ['explorer'],
      puzzleId: null,
      requiredItemId: null,
      targetTags: ['clue'],
      state: 'idle',
      inspectText: 'The newest access code replaced the crossed-out entry.',
    },
    {
      id: 'key_card_alpha',
      type: 'key_card',
      displayName: 'Alpha Key Card',
      position: { x: 78, y: 25 },
      interactionRadius: 14,
      allowedRoles: ['explorer'],
      puzzleId: null,
      requiredItemId: null,
      targetTags: ['pickup', 'key'],
      state: 'idle',
      inspectText: 'A worn security card marked ALPHA.',
    },
    {
      id: 'room_terminal',
      type: 'terminal',
      displayName: 'Security Terminal',
      position: { x: 50, y: 62 },
      interactionRadius: 16,
      allowedRoles: ['explorer'],
      puzzleId: null,
      requiredItemId: null,
      targetTags: ['terminal', 'puzzle'],
      state: 'powered',
    },
    {
      id: 'fuse_box_main',
      type: 'fuse_box',
      displayName: 'Main Fuse Box',
      position: { x: 20, y: 103 },
      interactionRadius: 16,
      allowedRoles: ['explorer'],
      puzzleId: null,
      requiredItemId: null,
      targetTags: ['power', 'panel'],
      state: 'idle',
    },
    {
      id: 'escape_door',
      type: 'door',
      displayName: 'Escape Door',
      position: { x: 80, y: 128 },
      interactionRadius: 18,
      allowedRoles: ['explorer'],
      puzzleId: null,
      requiredItemId: 'key_card_alpha',
      targetTags: ['door', 'exit'],
      state: 'locked',
    },
  ];
}

export class DuelcadeRoom extends Room {
  static runtime: BackendRuntime = createDisabledRuntime();
  maxClients = 2;
  maxMessagesPerSecond = 30;
  private game: EscapeState = this.createInitialState('easy', DEFAULT_MATCH_DURATION_MINUTES);
  private createdAt = Date.now();
  private pausedAt: number | null = null;
  private pingCooldowns = new Map<string, number>();
  private clientDataBySessionId = new Map<string, ClientData>();

  async onCreate(options: unknown): Promise<void> {
    JoinOptionsSchema.parse(options);
    this.roomId = await this.generateRoomId();
    this.createdAt = Date.now();
    this.game = this.createInitialState('easy', DEFAULT_MATCH_DURATION_MINUTES);

    this.onMessage('event', (client: EscapeClient, raw: unknown) => {
      const parsed = ClientEventSchema.safeParse(raw);
      if (!parsed.success) {
        this.sendError(client, 'INVALID_MESSAGE', 'error.invalid_message', false);
        return;
      }
      this.handleEvent(client, parsed.data as ClientEvent);
    });

    this.onMessage('ping', (client: EscapeClient, sentAt: unknown) => {
      client.send('pong', typeof sentAt === 'number' ? sentAt : Date.now());
    });

    this.clock.setInterval(() => this.tickGameTimer(), 1000);
  }

  async onAuth(
    _client: EscapeClient,
    options: unknown,
    context: AuthContext,
  ): Promise<RoomAuthData | false> {
    const parsed = JoinOptionsSchema.safeParse(options);
    if (!parsed.success) return false;
    const runtime = (this.constructor as typeof DuelcadeRoom).runtime;
    const auth = authenticateRoomClient(
      runtime,
      context,
      parsed.data.playerId,
    );
    if (!auth || !auth.authenticated || !runtime.store) return auth;
    const progression = await runtime.store.getProgression(
      auth.playerId,
      utcDateKey(),
    );
    const avatarId = progression?.equipped.avatar;
    return {
      ...auth,
      avatarId: PlayerAvatarIdSchema.safeParse(avatarId).success
        ? avatarId as PlayerAvatarId
        : undefined,
    };
  }

  onJoin(client: EscapeClient, options: unknown, auth?: RoomAuthData): void {
    const parsed = JoinOptionsSchema.parse(options);
    if (!auth) {
      this.evictClient(
        client,
        SERVER_CLOSE_CODE.REGISTRATION_REJECTED,
        'Player authentication failed',
      );
      return;
    }
    client.userData = {
      playerId: auth.playerId,
      registered: false,
      authenticated: auth.authenticated,
      authoritativeAvatarId: auth.avatarId,
    };
    this.clock.setTimeout(() => {
      if (!client.userData?.registered) {
        this.evictClient(
          client,
          SERVER_CLOSE_CODE.REGISTRATION_TIMEOUT,
          'Player registration timed out',
        );
      }
    }, ROOM_REGISTRATION_TIMEOUT_MS);
  }

  async onDrop(client: EscapeClient, code?: number): Promise<void> {
    const terminalServerClose = Object.values(SERVER_CLOSE_CODE).includes(
      code as (typeof SERVER_CLOSE_CODE)[keyof typeof SERVER_CLOSE_CODE],
    );
    if (!client.userData?.registered || terminalServerClose) return;

    const player = this.findPlayer(client);
    if (player) {
      player.connected = false;
      player.lastSeenAt = Date.now();
      if (this.game.status === 'playing' && this.pausedAt === null) {
        this.pausedAt = Date.now();
      }
      this.broadcastSnapshots(false);
      this.broadcastEvent({
        event: 'connection.warning',
        payload: {
          quality: 'critical',
          pingMs: 0,
          message: 'Partner disconnected. The timer is paused for 60 seconds.',
        },
      });
    }

    try {
      await this.allowReconnection(client, RECONNECT_GRACE_SECONDS);
    } catch {
      if (this.game.status === 'playing') this.failGame('player_left');
    }
  }

  onReconnect(client: EscapeClient): void {
    const player = this.findPlayer(client);
    if (!player) return;
    player.connected = true;
    player.lastSeenAt = Date.now();
    const position = this.game.positions.get(player.id);
    if (position) {
      // Movement sequence numbers are scoped to a client connection. A full
      // reload creates a fresh counter, so the reconnected seat must not keep
      // rejecting its new movement as older than the previous connection.
      this.game.positions.set(player.id, { ...position, sequence: 0 });
    }
    this.resumeTimerIfReady();
    this.broadcastSnapshots(false);
    // During onReconnect the client is still joining, so Colyseus queues this
    // initial replay until the JOIN_ROOM handshake. The client also requests a
    // deterministic sync after attaching its listeners.
    this.restoreReconnectedClient(client);
  }

  private restoreReconnectedClient(client: EscapeClient): void {
    const player = this.findPlayer(client);
    if (!player?.connected) return;
    this.sendRoomSnapshot(client, true);
    if (this.game.status === 'playing') {
      if (this.game.turnSession) {
        this.sendPatch(client, [
          { path: 'turnMatch', op: 'set', value: this.game.turnSession.state },
        ]);
      }
    } else if (this.game.status === 'completed' && this.game.result) {
      this.sendEvent(client, {
        event: 'game.completed',
        payload: { result: this.game.result },
      });
    } else if (this.game.status === 'failed' && this.game.result) {
      this.sendEvent(client, {
        event: 'game.failed',
        payload: { result: this.game.result },
      });
    }
  }

  async onLeave(client: EscapeClient): Promise<void> {
    if (!client.userData?.registered) return;
    const player = this.findPlayer(client);
    if (!player) return;
    this.game.players = this.game.players.filter((item) => item.id !== player.id);
    this.broadcastEvent({
      event: 'player.left',
      payload: { playerId: player.id, reason: 'user_left', isHost: player.isHost },
    });
    if (this.game.status === 'playing') {
      this.failGame('player_left');
    } else if (player.isHost) {
      this.broadcastEvent({
        event: 'error',
        payload: {
          errorCode: 'HOST_LEFT',
          userMessageKey: 'error.host_left',
          retryable: false,
          details: null,
        },
      });
      for (const remainingClient of this.clients as unknown as EscapeClient[]) {
        this.evictClient(
          remainingClient,
          SERVER_CLOSE_CODE.HOST_LEFT,
          'Host left the room',
        );
      }
    }
  }

  async onDispose(): Promise<void> {
    await this.presence.srem(ROOM_ID_CHANNEL, this.roomId);
  }

  private createInitialState(difficulty: Difficulty, matchDurationMinutes: number): EscapeState {
    const normalizedDuration = normalizeMatchDurationMinutes(matchDurationMinutes);
    const normalizedPuzzleCount = roundCountForDuration(normalizedDuration);
    const durationMs = normalizedDuration * 60 * 1000;
    return {
      players: [],
      seed: SeededRandom.generateSeed(),
      difficulty,
      puzzleCount: normalizedPuzzleCount,
      matchDurationMinutes: normalizedDuration,
      status: 'waiting',
      puzzles: [],
      puzzleOrder: [],
      solvedPuzzleIds: [],
      doors: [],
      objects: makeWorldObjects(),
      positions: new Map(),
      mistakeCount: 0,
      hintsUsed: 0,
      pingCount: 0,
      firstTryPuzzles: 0,
      startedAt: null,
      finishedAt: null,
      remainingTimeMs: durationMs,
      durationMs,
      snapshots: [],
      rematchVotes: new Set(),
      result: null,
      turnSession: null,
      lastTurnTickAt: null,
      forfeitedPlayerId: null,
      authenticatedPlayerIds: new Set(),
      matchPersisted: false,
    };
  }

  private async generateRoomId(): Promise<string> {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const currentIds = await this.presence.smembers(ROOM_ID_CHANNEL);
    let code = '';
    do {
      code = Array.from(
        { length: 6 },
        () => alphabet[Math.floor(Math.random() * alphabet.length)],
      ).join('');
    } while (currentIds.includes(code));
    await this.presence.sadd(ROOM_ID_CHANNEL, code);
    return code;
  }

  private handleEvent(client: EscapeClient, message: ClientEvent): void {
    switch (message.event) {
      case 'room.create':
        this.registerHost(client, message.payload);
        break;
      case 'room.join':
        this.registerGuest(client, message.payload);
        break;
      case 'room.sync':
        this.restoreReconnectedClient(client);
        break;
      case 'room.leave':
        this.evictClient(client, 1000, message.payload.reason);
        break;
      case 'player.ready':
        this.setReady(client, message.payload.ready);
        break;
      case 'player.rolePreference':
        this.setRolePreference(client, message.payload.preference);
        break;
      case 'player.move':
        this.movePlayer(client, message.payload);
        break;
      case 'interaction.request':
        this.interact(client, message.payload);
        break;
      case 'puzzle.submit':
        this.submitPuzzle(client, message.payload);
        break;
      case 'ping.send':
        this.sendPing(client, message.payload);
        break;
      case 'chat.send':
        this.sendChat(client, message.payload.text);
        break;
      case 'request.hint':
        this.requestHint(client, message.payload.puzzleId);
        break;
      case 'turn.move':
        this.playTurn(client, message.payload);
        break;
      case 'match.forfeit':
        this.forfeitMatch(client);
        break;
      case 'round.skip.vote':
        this.voteRoundSkip(client, message.payload.vote);
        break;
      case 'rematch.vote':
        this.voteRematch(client, message.payload.vote);
        break;
      case 'game.loaded':
        break;
    }
  }

  private registerHost(
    client: EscapeClient,
    payload: {
      displayName: string;
      avatarId: PlayerAvatarId;
      rolePreference: RolePreference;
      difficulty: Difficulty;
      matchDurationMinutes: number;
    },
  ): void {
    const clientData = client.userData;
    if (!clientData) {
      this.sendError(client, 'INVALID_ACTION', 'error.invalid_message', false);
      return;
    }
    if (this.game.players.length > 0 || clientData.registered) {
      this.rejectRegistration(
        client,
        'INVALID_ACTION',
        'error.room_already_created',
      );
      return;
    }
    this.game.difficulty = payload.difficulty;
    this.game.matchDurationMinutes = normalizeMatchDurationMinutes(payload.matchDurationMinutes);
    this.game.puzzleCount = roundCountForDuration(this.game.matchDurationMinutes);
    this.game.durationMs = this.game.matchDurationMinutes * 60 * 1000;
    this.game.remainingTimeMs = this.game.durationMs;
    const player = this.createPlayer(
      clientData.playerId,
      payload.displayName,
      clientData.authoritativeAvatarId ?? payload.avatarId,
      payload.rolePreference,
      true,
    );
    clientData.registered = true;
    this.clientDataBySessionId.set(client.sessionId, { ...clientData });
    if (clientData.authenticated) {
      this.game.authenticatedPlayerIds.add(clientData.playerId);
    }
    this.game.players.push(player);
    this.game.positions.set(player.id, { x: 50, y: 132, sequence: 0 });
    this.sendRoomSnapshot(client, false);
  }

  private registerGuest(
    client: EscapeClient,
    payload: {
      roomCode: string;
      displayName: string;
      avatarId: PlayerAvatarId;
      rolePreference: RolePreference;
    },
  ): void {
    const clientData = client.userData;
    if (!clientData) {
      this.sendError(client, 'INVALID_ACTION', 'error.invalid_message', false);
      return;
    }
    if (clientData.registered) {
      this.sendError(client, 'INVALID_ACTION', 'error.invalid_message', false);
      return;
    }
    if (payload.roomCode !== this.roomId) {
      this.rejectRegistration(client, 'ROOM_NOT_FOUND', 'error.room_not_found');
      return;
    }
    if (this.game.status !== 'waiting') {
      this.rejectRegistration(client, 'ROOM_IN_PROGRESS', 'error.room_in_progress');
      return;
    }
    if (this.game.players.length >= 2) {
      this.rejectRegistration(client, 'ROOM_FULL', 'error.room_full');
      return;
    }
    if (this.game.players.some((player) => player.id === clientData.playerId)) {
      this.rejectRegistration(
        client,
        'PLAYER_ID_CONFLICT',
        'error.player_id_conflict',
      );
      return;
    }
    const player = this.createPlayer(
      clientData.playerId,
      payload.displayName,
      clientData.authoritativeAvatarId ?? payload.avatarId,
      payload.rolePreference,
      false,
    );
    clientData.registered = true;
    this.clientDataBySessionId.set(client.sessionId, { ...clientData });
    if (clientData.authenticated) {
      this.game.authenticatedPlayerIds.add(clientData.playerId);
    }
    this.game.players.push(player);
    this.game.positions.set(player.id, { x: 50, y: 132, sequence: 0 });
    this.broadcastEvent({ event: 'player.joined', payload: { player } });
    this.broadcastSnapshots(false);
  }

  private createPlayer(
    id: string,
    displayName: string,
    avatarId: PlayerAvatarId,
    rolePreference: RolePreference,
    isHost: boolean,
  ): Player {
    return {
      id,
      displayName: displayName.trim().slice(0, 24) || (isHost ? 'Host' : 'Guest'),
      avatarId,
      role: null,
      isHost,
      isReady: false,
      rolePreference,
      connected: true,
      lastSeenAt: Date.now(),
    };
  }

  private setReady(client: EscapeClient, ready: boolean): void {
    const player = this.findPlayer(client);
    if (!player || this.game.status !== 'waiting') return;
    player.isReady = ready;
    player.lastSeenAt = Date.now();
    this.broadcastSnapshots(false);
    if (this.game.players.length === 2 && this.game.players.every((item) => item.isReady)) {
      this.startGame();
    }
  }

  private setRolePreference(client: EscapeClient, preference: RolePreference): void {
    const player = this.findPlayer(client);
    if (!player || this.game.status !== 'waiting') return;
    player.rolePreference = preference;
    this.broadcastSnapshots(false);
  }

  private startGame(): void {
    const [first, second] = this.game.players;
    const roles = this.assignRoles(first, second);
    first.role = roles[first.id];
    second.role = roles[second.id];
    this.game.status = 'loading';

    for (const client of this.clients as unknown as EscapeClient[]) {
      const playerId = client.userData?.playerId;
      if (!playerId) continue;
      const role = roles[playerId];
      this.sendEvent(client, { event: 'role.assigned', payload: { role, roles } });
    }

    this.game.turnSession = createTurnMatchSession(
      this.game.seed,
      [first.id, second.id],
      this.game.puzzleCount,
      this.game.difficulty,
      this.game.durationMs,
    );
    this.game.status = 'playing';
    this.game.startedAt = Date.now();
    this.game.lastTurnTickAt = this.game.startedAt;
    this.game.remainingTimeMs = this.game.durationMs;

    this.broadcastEvent({
      event: 'game.starting',
      payload: {
        seed: this.game.seed,
        levelId: 'shared-turn-table',
        loadTimeoutMs: 30_000,
        durationMs: this.game.durationMs,
      },
    });
    this.broadcastTurnMatch();
  }

  private assignRoles(first: Player, second: Player): Record<string, PlayerRole> {
    if (
      first.rolePreference !== 'no_preference' &&
      second.rolePreference !== 'no_preference' &&
      first.rolePreference !== second.rolePreference
    ) {
      return { [first.id]: first.rolePreference, [second.id]: second.rolePreference };
    }
    if (first.rolePreference !== 'no_preference' && second.rolePreference === 'no_preference') {
      return {
        [first.id]: first.rolePreference,
        [second.id]: first.rolePreference === 'operator' ? 'explorer' : 'operator',
      };
    }
    if (second.rolePreference !== 'no_preference' && first.rolePreference === 'no_preference') {
      return {
        [second.id]: second.rolePreference,
        [first.id]: second.rolePreference === 'operator' ? 'explorer' : 'operator',
      };
    }
    const firstRole = new SeededRandom(`${this.game.seed}_roles`).pick<PlayerRole>(['operator', 'explorer']);
    return {
      [first.id]: firstRole,
      [second.id]: firstRole === 'operator' ? 'explorer' : 'operator',
    };
  }

  private tickGameTimer(): void {
    if (this.game.status !== 'playing' || this.pausedAt !== null || !this.game.startedAt) return;
    const now = Date.now();
    const elapsed = this.game.lastTurnTickAt ? now - this.game.lastTurnTickAt : 1000;
    this.game.lastTurnTickAt = now;
    if (this.game.turnSession && tickTurnClock(this.game.turnSession, elapsed)) {
      this.broadcastTurnMatch();
      this.completeGame();
      return;
    }
    this.game.remainingTimeMs = this.game.turnSession
      ? this.game.turnSession.state.playerTimeMs[0] + this.game.turnSession.state.playerTimeMs[1]
      : Math.max(0, this.game.durationMs - (now - this.game.startedAt));
    this.broadcastStatePatches([
      { path: 'remainingTimeMs', op: 'set', value: this.game.remainingTimeMs },
      { path: 'serverNow', op: 'set', value: now },
      ...(this.game.turnSession
        ? [{ path: 'turnMatch', op: 'set' as const, value: this.game.turnSession.state }]
        : []),
    ]);
  }

  private playTurn(
    client: EscapeClient,
    payload: Extract<ClientEvent, { event: 'turn.move' }>['payload'],
  ): void {
    const player = this.findPlayer(client);
    const session = this.game.turnSession;
    if (!player || !session || this.game.status !== 'playing') {
      this.sendError(client, 'INVALID_ACTION', 'error.match_not_ready', true);
      return;
    }
    const result = applyTurnMove(
      session,
      player.id,
      payload.cell,
      payload.expectedMove,
    );
    if (!result.accepted) {
      const key = result.reason === 'not_your_turn'
        ? 'error.not_your_turn'
        : result.reason === 'stale_move'
          ? 'error.board_changed'
          : 'error.invalid_move';
      this.sendError(client, 'INVALID_TURN', key, true);
      return;
    }
    if (session.state.skipVotes.some(Boolean)) {
      session.state.skipVotes = [false, false];
    }
    this.broadcastTurnMatch();
    if (result.needsResolve) {
      this.clock.setTimeout(() => {
        if (!this.game.turnSession) return;
        resolveMemoryTurn(this.game.turnSession);
        this.broadcastTurnMatch();
      }, 850);
    } else if (result.roundEnded) {
      this.clock.setTimeout(() => {
        const current = this.game.turnSession;
        if (!current || current.state.status !== 'round_complete') return;
        if (advanceTurnRound(current)) {
          this.game.lastTurnTickAt = Date.now();
          this.broadcastTurnMatch();
        } else {
          this.broadcastTurnMatch();
          this.completeGame();
        }
      }, 2200);
    }
  }

  private forfeitMatch(client: EscapeClient): void {
    const player = this.findPlayer(client);
    const session = this.game.turnSession;
    if (!player || !session || this.game.status !== 'playing') return;
    const forfeitedIndex = session.state.playerIds.indexOf(player.id);
    if (forfeitedIndex < 0) return;
    const winnerIndex = (1 - forfeitedIndex) as 0 | 1;
    session.state.scores[winnerIndex] += 1;
    session.state.winnerIndex = winnerIndex;
    session.state.status = 'match_complete';
    this.game.forfeitedPlayerId = player.id;
    this.broadcastTurnMatch();
    this.completeGame();
  }

  private voteRoundSkip(client: EscapeClient, vote: boolean): void {
    const player = this.findPlayer(client);
    const session = this.game.turnSession;
    if (!player || !session || this.game.status !== 'playing') return;
    if (session.state.status !== 'playing' && session.state.status !== 'resolving') return;
    const playerIndex = session.state.playerIds.indexOf(player.id);
    if (playerIndex < 0) return;

    if (!vote) {
      session.state.skipVotes = [false, false];
      this.broadcastSkipVotes(null);
      this.broadcastTurnMatch();
      return;
    }

    session.state.skipVotes[playerIndex as 0 | 1] = true;
    this.broadcastSkipVotes(player.id);
    if (!session.state.skipVotes.every(Boolean)) {
      this.broadcastTurnMatch();
      return;
    }

    if (skipTurnRound(session)) {
      this.game.lastTurnTickAt = Date.now();
      this.broadcastTurnMatch();
    } else {
      this.broadcastTurnMatch();
      this.completeGame();
    }
  }

  private broadcastSkipVotes(requestedByPlayerId: string | null): void {
    const skipVotes = this.game.turnSession?.state.skipVotes;
    if (!skipVotes) return;
    this.broadcastEvent({
      event: 'round.skip.updated',
      payload: { skipVotes: [...skipVotes] as [boolean, boolean], requestedByPlayerId },
    });
  }

  private broadcastTurnMatch(): void {
    if (!this.game.turnSession) return;
    this.broadcastStatePatches([
      { path: 'turnMatch', op: 'set', value: this.game.turnSession.state },
    ]);
  }

  private movePlayer(
    client: EscapeClient,
    payload: { x: number; y: number; sequence: number; timestamp: number },
  ): void {
    const player = this.findPlayer(client);
    if (!player || player.role !== 'explorer' || this.game.status !== 'playing') return;
    if (![payload.x, payload.y, payload.sequence].every(Number.isFinite)) return;
    const current = this.game.positions.get(player.id) ?? { x: 50, y: 132, sequence: 0 };
    if (payload.sequence <= current.sequence) return;
    const target = {
      x: Math.max(4, Math.min(96, payload.x)),
      y: Math.max(4, Math.min(136, payload.y)),
    };
    const position = { ...target, sequence: payload.sequence };
    this.game.positions.set(player.id, position);
    this.broadcastStatePatches([{ path: `playerPositions.${player.id}`, op: 'set', value: position }]);
  }

  private interact(
    client: EscapeClient,
    payload: { objectId: string; interactionType: string; data: Record<string, unknown>; clientActionId: number },
  ): void {
    const player = this.findPlayer(client);
    const object = this.game.objects.find((item) => item.id === payload.objectId);
    if (!player || !object || !object.allowedRoles.includes(player.role as PlayerRole)) {
      this.sendInteractionResult(client, payload.clientActionId, payload.objectId, false, 'locked', 'error.not_allowed');
      return;
    }
    if (player.role === 'explorer') {
      const position = this.game.positions.get(player.id);
      if (!position || Math.hypot(position.x - object.position.x, position.y - object.position.y) > object.interactionRadius) {
        this.sendInteractionResult(client, payload.clientActionId, object.id, false, object.state, 'error.too_far');
        return;
      }
    }

    const currentPuzzle = this.game.puzzles[this.game.solvedPuzzleIds.length];
    const requiredStationId = currentPuzzle?.category === 'circuit'
      ? 'fuse_box_main'
      : 'room_terminal';
    let completesGame = false;

    if (
      currentPuzzle &&
      ['fuse_box_main', 'room_terminal'].includes(object.id) &&
      object.id !== requiredStationId
    ) {
      this.sendInteractionResult(
        client,
        payload.clientActionId,
        object.id,
        false,
        object.state,
        'error.station_inactive',
      );
      return;
    }

    if (currentPuzzle && object.id === requiredStationId) {
      if (!currentPuzzle.guideSolved) {
        this.sendInteractionResult(
          client,
          payload.clientActionId,
          object.id,
          false,
          object.state,
          'error.guide_locked',
        );
        return;
      }
      currentPuzzle.fieldUnlocked = true;
      object.state = 'active';
      this.broadcastPuzzle(currentPuzzle);
    } else if (object.id === 'key_card_alpha' && object.state !== 'active') {
      object.state = 'active';
    } else if (object.id === 'escape_door') {
      const hasCard = this.game.objects.some(
        (item) => item.id === 'key_card_alpha' && item.state === 'active',
      );
      if (!hasCard || this.game.solvedPuzzleIds.length !== this.game.puzzles.length) {
        this.sendInteractionResult(client, payload.clientActionId, object.id, false, 'locked', 'error.door_locked');
        return;
      }
      object.state = 'open';
      completesGame = true;
    } else {
      object.state = object.state === 'idle' ? 'active' : object.state;
    }

    this.sendInteractionResult(client, payload.clientActionId, object.id, true, object.state);
    this.broadcastWorld();
    if (completesGame) this.completeGame();
  }

  private submitPuzzle(
    client: EscapeClient,
    payload: Extract<ClientEvent, { event: 'puzzle.submit' }>['payload'],
  ): void {
    const player = this.findPlayer(client);
    const puzzle = this.game.puzzles.find((item) => item.puzzleId === payload.puzzleId);
    if (!player || !player.role || !puzzle || this.game.status !== 'playing') {
      this.sendError(client, 'INVALID_ACTION', 'error.puzzle_not_found', false);
      return;
    }
    if (this.game.puzzleOrder[this.game.solvedPuzzleIds.length] !== puzzle.puzzleId) {
      this.sendError(client, 'PUZZLE_LOCKED', 'error.puzzle_locked', false);
      return;
    }

    if (
      payload.action.type === 'solve_guide' ||
      payload.action.type === 'solve_guide_paths'
    ) {
      if (player.role !== 'operator') {
        this.sendError(client, 'INVALID_ACTION', 'error.guide_role', false);
        return;
      }
      if (puzzle.guideSolved) return;
      puzzle.guideAttemptCount = (puzzle.guideAttemptCount ?? 0) + 1;
      const challenge = puzzle.guideChallenge;
      const correct = challenge?.kind === 'color_paths'
        ? payload.action.type === 'solve_guide_paths' &&
          validateColorPathSubmission(challenge, payload.action.paths)
        : payload.action.type === 'solve_guide' &&
          payload.action.answer.trim() === puzzle.guideChallengeAnswer;
      if (correct) {
        puzzle.guideSolved = true;
      } else {
        this.game.mistakeCount += 1;
        if (this.game.startedAt) this.game.startedAt -= 10_000;
      }
      this.broadcastPuzzle(puzzle);
      if (
        !puzzle.guideSolved &&
        (puzzle.guideAttemptCount ?? 0) >= (puzzle.guideChallenge?.maxAttempts ?? 3)
      ) {
        this.failGame('max_attempts_exceeded');
      }
      return;
    }

    if (player.role === 'explorer' && !puzzle.guideSolved) {
      this.sendError(client, 'GUIDE_LOCKED', 'error.guide_locked', true);
      return;
    }
    if (player.role === 'explorer' && !puzzle.fieldUnlocked) {
      this.sendError(client, 'FIELD_LOCKED', 'error.field_locked', true);
      return;
    }

    const result = validatePuzzleAction(puzzle, payload.action, player.role);
    puzzle.phase = result.newPhase;
    puzzle.attemptCount = result.attemptCount;

    if (result.feedback.correct && !this.game.solvedPuzzleIds.includes(puzzle.puzzleId)) {
      if (puzzle.attemptCount === 1) this.game.firstTryPuzzles += 1;
      this.game.solvedPuzzleIds.push(puzzle.puzzleId);
      const nextDoor = this.game.doors[this.game.solvedPuzzleIds.length];
      if (nextDoor) {
        nextDoor.locked = false;
        nextDoor.open = true;
      }
      const snapshot = this.createSnapshot();
      this.game.snapshots.push(snapshot);
      this.broadcastEvent({ event: 'checkpoint.saved', payload: { snapshot } });
    } else if (!result.feedback.correct) {
      this.game.mistakeCount += 1;
      if (result.feedback.timePenaltyMs > 0 && this.game.startedAt) {
        this.game.startedAt -= result.feedback.timePenaltyMs;
      }
    }

    this.broadcastEvent({
      event: 'puzzle.feedback',
      payload: {
        puzzleId: puzzle.puzzleId,
        feedback: result.feedback,
        clientActionId: payload.clientActionId,
      },
    });
    this.broadcastPuzzle(puzzle);

    if (puzzle.phase === 'failed') {
      this.failGame('max_attempts_exceeded');
      return;
    }

    if (result.feedback.correct) {
      if (this.game.solvedPuzzleIds.length === this.game.puzzles.length) {
        // The final escape still requires the Adventurer to activate the
        // key-card reader on the map before opening the escape door.
        this.broadcastWorld();
      } else {
        for (const target of this.clients as unknown as EscapeClient[]) this.sendCurrentPuzzle(target);
      }
    }
  }

  private requestHint(client: EscapeClient, puzzleId: string): void {
    const puzzle = this.game.puzzles.find((item) => item.puzzleId === puzzleId);
    if (!puzzle || !this.game.startedAt) return;
    const nextHint = puzzle.hints[puzzle.hintsRevealed];
    if (!nextHint || Date.now() - this.game.startedAt < nextHint.revealAfterMs) {
      this.sendError(client, 'HINT_COOLDOWN', 'error.hint_cooldown', true);
      return;
    }
    puzzle.hintsRevealed += 1;
    this.game.hintsUsed += 1;
    this.broadcastPuzzle(puzzle);
  }

  private sendPing(
    client: EscapeClient,
    payload: Extract<ClientEvent, { event: 'ping.send' }>['payload'],
  ): void {
    const player = this.findPlayer(client);
    if (!player) return;
    const now = Date.now();
    if ((this.pingCooldowns.get(player.id) ?? 0) > now) return;
    this.pingCooldowns.set(player.id, now + 2000);
    this.game.pingCount += 1;
    this.broadcastEvent({
      event: 'ping.received',
      payload: {
        ping: {
          id: `ping_${now}_${player.id}`,
          playerId: player.id,
          type: payload.pingType,
          position: payload.position,
          createdAt: now,
          expiresAt: now + 3000,
        },
      },
    });
  }

  private sendChat(client: EscapeClient, rawText: string): void {
    const player = this.findPlayer(client);
    const text = rawText.trim().slice(0, 240);
    if (!player || !text || this.game.status !== 'playing') return;
    const sentAt = Date.now();
    this.broadcastEvent({
      event: 'chat.received',
      payload: {
        message: {
          id: `chat_${sentAt}_${player.id}`,
          playerId: player.id,
          displayName: player.displayName,
          text,
          sentAt,
        },
      },
    });
  }

  private voteRematch(client: EscapeClient, vote: boolean): void {
    const player = this.findPlayer(client);
    if (!player || (this.game.status !== 'completed' && this.game.status !== 'failed')) return;
    if (vote) this.game.rematchVotes.add(player.id);
    else this.game.rematchVotes.delete(player.id);
    this.broadcastEvent({ event: 'rematch.prompt', payload: { playerId: player.id, vote } });
    if (this.game.rematchVotes.size !== 2) return;

    const difficulty = this.game.difficulty;
    const matchDurationMinutes = this.game.matchDurationMinutes;
    const authenticatedPlayerIds = new Set(this.game.authenticatedPlayerIds);
    const players = this.game.players.map((item) => ({
      ...item,
      role: null,
      isReady: false,
    }));
    this.game = this.createInitialState(difficulty, matchDurationMinutes);
    this.game.players = players;
    this.game.authenticatedPlayerIds = authenticatedPlayerIds;
    for (const item of players) this.game.positions.set(item.id, { x: 50, y: 132, sequence: 0 });
    this.broadcastSnapshots(false);
  }

  private completeGame(): void {
    this.game.finishedAt = Date.now();
    this.game.status = 'completed';
    this.game.result = this.createResult(true, null, this.currentEnding());
    this.persistCurrentMatch();
    this.broadcastEvent({
      event: 'game.completed',
      payload: { result: this.game.result },
    });
  }

  private currentEnding(): NonNullable<GameResult['ending']> {
    return this.game.mistakeCount < 3
      ? 'restore'
      : this.game.mistakeCount < 6
        ? 'shutdown'
        : 'escape';
  }

  private failGame(reason: FailReason): void {
    if (this.game.status === 'failed' || this.game.status === 'completed') return;
    this.game.finishedAt = Date.now();
    this.game.status = 'failed';
    this.game.result = this.createResult(false, reason, null);
    this.persistCurrentMatch();
    this.broadcastEvent({
      event: 'game.failed',
      payload: { result: this.game.result },
    });
  }

  private createResult(
    success: boolean,
    failReason: FailReason | null,
    ending: GameResult['ending'],
  ): GameResult {
    const roles = Object.fromEntries(
      this.game.players.filter((player) => player.role).map((player) => [player.id, player.role!]),
    );
    const result = createGameResult({
      roomId: this.roomId,
      success,
      failReason,
      startTimeMs: this.game.startedAt ?? Date.now(),
      endTimeMs: this.game.finishedAt ?? Date.now(),
      remainingTimeMs: this.game.remainingTimeMs,
      mistakeCount: this.game.mistakeCount,
      puzzlesSolved: this.game.turnSession
        ? Math.min(this.game.turnSession.state.roundIndex + 1, this.game.turnSession.state.totalRounds)
        : this.game.solvedPuzzleIds.length,
      totalPuzzles: this.game.turnSession?.state.totalRounds ?? this.game.puzzles.length,
      hintsUsed: this.game.hintsUsed,
      pingCount: this.game.pingCount,
      firstTryPuzzles: this.game.firstTryPuzzles,
      roles,
      ending,
    });
    if (this.game.turnSession) {
      const { playerIds, scores, winnerIndex } = this.game.turnSession.state;
      return {
        ...result,
        winnerPlayerId: winnerIndex === null ? null : playerIds[winnerIndex],
        forfeitedPlayerId: this.game.forfeitedPlayerId,
        playerScores: {
          [playerIds[0]]: scores[0],
          [playerIds[1]]: scores[1],
        },
      };
    }
    return result;
  }

  private persistCurrentMatch(): void {
    if (
      this.game.matchPersisted
      || !this.game.result
      || !this.game.startedAt
      || !this.game.finishedAt
    ) return;
    this.game.matchPersisted = true;
    const id = `${this.roomId}:${this.game.startedAt}`;
    void persistMatch((this.constructor as typeof DuelcadeRoom).runtime, {
      id,
      roomId: this.roomId,
      startedAt: this.game.startedAt,
      finishedAt: this.game.finishedAt,
      difficulty: this.game.difficulty,
      totalRounds: this.game.turnSession?.state.totalRounds ?? this.game.puzzleCount,
      modeOrder: this.game.turnSession?.modeOrder ?? [],
      players: this.game.players.map((player) => ({ ...player })),
      authenticatedPlayerIds: new Set(this.game.authenticatedPlayerIds),
      result: this.game.result,
    });
  }

  private resumeTimerIfReady(): void {
    if (
      this.pausedAt !== null &&
      this.game.players.every((player) => player.connected) &&
      this.game.startedAt
    ) {
      this.game.startedAt += Date.now() - this.pausedAt;
      this.pausedAt = null;
      this.game.lastTurnTickAt = Date.now();
    }
  }

  private findPlayer(client: EscapeClient): Player | undefined {
    const auth = client.auth as RoomAuthData | undefined;
    const restoredData = this.clientDataBySessionId.get(client.sessionId) ?? (
      auth?.playerId
        ? {
            playerId: auth.playerId,
            registered: true,
            authenticated: auth.authenticated,
            authoritativeAvatarId: auth.avatarId,
          }
        : undefined
    );
    if (!client.userData?.registered) {
      if (!restoredData) return undefined;
      client.userData = { ...restoredData };
    }
    return this.game.players.find((player) => player.id === client.userData?.playerId);
  }

  private sendCurrentPuzzle(client: EscapeClient): void {
    const player = this.findPlayer(client);
    const puzzle = this.game.puzzles[this.game.solvedPuzzleIds.length];
    if (!player?.role || !puzzle) return;
    this.sendEvent(client, {
      event: 'puzzle.updated',
      payload: { puzzle: filterPuzzleForClient(puzzle, player.role) },
    });
  }

  private broadcastPuzzle(puzzle: PuzzleState): void {
    for (const client of this.clients as unknown as EscapeClient[]) {
      const player = this.findPlayer(client);
      if (!player?.role) continue;
      this.sendEvent(client, {
        event: 'puzzle.updated',
        payload: { puzzle: filterPuzzleForClient(puzzle, player.role) },
      });
    }
  }

  private broadcastWorld(): void {
    for (const client of this.clients as unknown as EscapeClient[]) {
      const player = this.findPlayer(client);
      if (!player?.role) continue;
      const objects = this.game.objects.filter((object) => object.allowedRoles.includes(player.role!));
      this.sendPatch(client, [
        {
          path: 'world',
          op: 'set',
          value: {
            width: 100,
            height: 140,
            objects,
            playerPosition: this.game.positions.get(player.id) ?? null,
          },
        },
      ]);
    }
  }

  private createSnapshot(): GameSnapshot {
    const explorer = this.game.players.find((player) => player.role === 'explorer');
    return {
      snapshotId: `snapshot_${Date.now()}_${this.game.snapshots.length}`,
      roomId: this.roomId,
      seed: this.game.seed,
      roles: Object.fromEntries(
        this.game.players.filter((player) => player.role).map((player) => [player.id, player.role!]),
      ),
      currentRoomId: this.roomId,
      solvedPuzzleIds: [...this.game.solvedPuzzleIds],
      remainingTimeMs: this.game.remainingTimeMs,
      doorStates: Object.fromEntries(this.game.doors.map((door) => [door.id, { ...door }])),
      powerStates: {},
      playerPosition: explorer ? this.game.positions.get(explorer.id) ?? null : null,
      createdAt: Date.now(),
      attemptCount: this.game.mistakeCount,
      mistakeCount: this.game.mistakeCount,
    };
  }

  private latestSnapshot(): GameSnapshot | null {
    return this.game.snapshots[this.game.snapshots.length - 1] ?? null;
  }

  private roomConfig() {
    return {
      code: this.roomId,
      hostId: this.game.players.find((player) => player.isHost)?.id ?? '',
      status: this.game.status,
      players: this.game.players.map((player) => ({ ...player })),
      seed: this.game.seed,
      createdAt: this.createdAt,
      startedAt: this.game.startedAt,
      finishedAt: this.game.finishedAt,
      maxPlayers: 2,
      difficulty: this.game.difficulty,
      puzzleCount: this.game.puzzleCount,
      matchDurationMinutes: this.game.matchDurationMinutes,
    };
  }

  private sendRoomSnapshot(client: EscapeClient, isReconnect: boolean): void {
    this.sendEvent(client, {
      event: 'room.snapshot',
      payload: { room: this.roomConfig(), isReconnect },
    });
  }

  private broadcastSnapshots(isReconnect: boolean): void {
    for (const client of this.clients as unknown as EscapeClient[]) {
      this.sendRoomSnapshot(client, isReconnect);
    }
  }

  private sendInteractionResult(
    client: EscapeClient,
    clientActionId: number,
    objectId: string,
    success: boolean,
    newState: InteractableObject['state'],
    userMessageKey?: string,
  ): void {
    this.sendEvent(client, {
      event: 'interaction.result',
      payload: {
        clientActionId,
        result: {
          success,
          objectId,
          newState,
          userMessageKey,
          errorCode: success ? undefined : 'INTERACTION_REJECTED',
          feedback: {
            animation: success ? 'success' : 'error',
            haptic: success ? 'success' : 'error',
            soundKey: success ? 'interaction_success' : 'interaction_error',
            messageKey: userMessageKey,
            messageDuration: 2500,
          },
        },
      },
    });
  }

  private broadcastStatePatches(
    patches: Extract<ServerEvent, { event: 'state.patch' }>['payload']['patches'],
  ): void {
    for (const client of this.clients as unknown as EscapeClient[]) this.sendPatch(client, patches);
  }

  private sendPatch(
    client: EscapeClient,
    patches: Extract<ServerEvent, { event: 'state.patch' }>['payload']['patches'],
  ): void {
    this.sendEvent(client, {
      event: 'state.patch',
      payload: { patches, sequence: Date.now() },
    });
  }

  private sendError(
    client: EscapeClient,
    errorCode: string,
    userMessageKey: string,
    retryable: boolean,
  ): void {
    this.sendEvent(client, {
      event: 'error',
      payload: { errorCode, userMessageKey, retryable, details: null },
    });
  }

  private rejectRegistration(
    client: EscapeClient,
    errorCode: string,
    userMessageKey: string,
  ): void {
    this.sendError(client, errorCode, userMessageKey, false);
    this.clock.setTimeout(() => {
      if (!client.userData?.registered) {
        this.evictClient(
          client,
          SERVER_CLOSE_CODE.REGISTRATION_REJECTED,
          userMessageKey,
        );
      }
    }, 50);
  }

  private evictClient(client: EscapeClient, code: number, reason: string): void {
    client.leave(code, reason);
    this.clock.setTimeout(() => {
      const connection = client.ref as typeof client.ref & {
        readyState?: number;
        terminate?: () => void;
      };
      if (connection.readyState !== 3) connection.terminate?.();
    }, 500);
  }

  private broadcastEvent(event: ServerEvent): void {
    for (const client of this.clients as unknown as EscapeClient[]) this.sendEvent(client, event);
  }

  private sendEvent(client: EscapeClient, payload: ServerEvent): void {
    const message: ServerMessage = {
      protocolVersion: PROTOCOL_VERSION,
      roomId: this.roomId,
      playerId: client.userData?.playerId ?? '',
      messageId: `server_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      sentAt: Date.now(),
      payload,
    };
    client.send('event', message);
  }
}
