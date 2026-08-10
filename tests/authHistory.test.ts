import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, type Room } from '@colyseus/sdk';

import { createGameServer } from '../server/app';
import { TokenService } from '../server/auth/Tokens';
import {
  CORE_MODES,
  COSMETIC_CATALOG,
  DAILY_QUESTS,
  levelFromXp,
  levelProgress,
  matchXpForPlayer,
  type CosmeticType,
  type QuestKey,
} from '../server/progression';
import type {
  CreateGuestSessionInput,
  CreateAccountSessionInput,
  EquipCosmeticResult,
  MatchHistoryItem,
  MatchRecord,
  PersistenceStore,
  PlayerProgression,
  QuestClaimResult,
  RotateSessionInput,
  StoredPlayer,
} from '../server/persistence/types';
import type { AnalyticsEvent } from '../server/analytics';
import type { FeedbackSubmission } from '../server/feedback';
import type { BackendRuntime } from '../server/runtime';
import { authenticateRoomClient } from '../server/runtime';
import { PROTOCOL_VERSION, type ServerMessage } from '../types/network';

class MemoryStore implements PersistenceStore {
  readonly available = true;
  readonly players = new Map<string, StoredPlayer>();
  readonly identities = new Map<string, string>();
  readonly sessions = new Map<string, {
    playerId: string;
    sessionId: string;
    expiresAt: number;
  }>();
  readonly matches: MatchRecord[] = [];
  readonly totalXp = new Map<string, number>();
  readonly inventory = new Map<string, Set<string>>();
  readonly equipped = new Map<string, {
    avatar: string;
    frame: string;
    tableTheme: string;
  }>();
  readonly quests = new Map<string, Map<QuestKey, {
    progress: number;
    claimed: boolean;
  }>>();
  readonly analyticsEvents: { playerId: string; event: AnalyticsEvent }[] = [];
  readonly feedbackSubmissions: {
    playerId: string;
    submission: FeedbackSubmission;
  }[] = [];

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async createGuestSession(input: CreateGuestSessionInput): Promise<StoredPlayer> {
    const player = {
      id: input.playerId,
      displayName: input.displayName,
      createdAt: Date.now(),
    };
    this.players.set(player.id, player);
    this.totalXp.set(player.id, 0);
    this.inventory.set(player.id, new Set(
      COSMETIC_CATALOG
        .filter((item) => item.unlockLevel === 1)
        .map((item) => `${item.type}:${item.itemId}`),
    ));
    this.equipped.set(player.id, {
      avatar: 'sparkles',
      frame: 'default',
      tableTheme: 'classic',
    });
    this.sessions.set(input.refreshTokenHash, {
      playerId: player.id,
      sessionId: input.sessionId,
      expiresAt: input.refreshTokenExpiresAt,
    });
    return player;
  }

  async upsertOAuthAccount(input: CreateAccountSessionInput): Promise<StoredPlayer> {
    const identityKey = `${input.provider}:${input.providerSubject}`;
    const existingId = this.identities.get(identityKey);
    const existing = existingId ? this.players.get(existingId) : null;
    if (existing) {
      this.sessions.set(input.refreshTokenHash, {
        playerId: existing.id,
        sessionId: input.sessionId,
        expiresAt: input.refreshTokenExpiresAt,
      });
      return existing;
    }
    const player = await this.createGuestSession({
      playerId: input.playerId,
      displayName: input.displayName,
      sessionId: input.sessionId,
      refreshTokenHash: input.refreshTokenHash,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt,
    });
    this.identities.set(identityKey, player.id);
    return player;
  }

  async rotateSession(input: RotateSessionInput): Promise<{
    player: StoredPlayer;
    sessionId: string;
  } | null> {
    const current = this.sessions.get(input.currentRefreshTokenHash);
    if (!current || current.expiresAt <= input.now) return null;
    const player = this.players.get(current.playerId);
    if (!player) return null;
    this.sessions.delete(input.currentRefreshTokenHash);
    this.sessions.set(input.nextRefreshTokenHash, {
      ...current,
      expiresAt: input.nextRefreshTokenExpiresAt,
    });
    return { player, sessionId: current.sessionId };
  }

  async revokeSession(refreshTokenHash: string): Promise<void> {
    this.sessions.delete(refreshTokenHash);
  }

  async updatePlayerName(playerId: string, displayName: string): Promise<StoredPlayer | null> {
    const current = this.players.get(playerId);
    if (!current) return null;
    const player = { ...current, displayName };
    this.players.set(playerId, player);
    return player;
  }

  async getPlayer(playerId: string): Promise<StoredPlayer | null> {
    return this.players.get(playerId) ?? null;
  }

  async recordMatch(record: MatchRecord): Promise<void> {
    if (this.matches.some((match) => match.id === record.id)) return;
    this.matches.push(record);
    for (const playerId of record.authenticatedPlayerIds) {
      this.addXp(playerId, matchXpForPlayer(record, playerId));
      const quests = this.ensureQuests(playerId);
      quests.get('play_duel')!.progress = 1;
      if (record.result.winnerPlayerId === playerId) {
        quests.get('win_duel')!.progress = 1;
      }
      quests.get('win_rounds')!.progress = Math.min(
        3,
        record.result.playerScores?.[playerId] ?? 0,
      );
    }
  }

  async listMatches(playerId: string, limit: number): Promise<MatchHistoryItem[]> {
    return this.matches
      .filter((match) => match.authenticatedPlayerIds.has(playerId))
      .slice(-limit)
      .reverse()
      .map((match) => {
        const opponent = match.players.find((player) => player.id !== playerId);
        return {
          id: match.id,
          roomId: match.roomId,
          startedAt: match.startedAt,
          finishedAt: match.finishedAt,
          difficulty: match.difficulty,
          totalRounds: match.totalRounds,
          modeOrder: match.modeOrder,
          winnerPlayerId: match.result.winnerPlayerId ?? null,
          forfeitedPlayerId: match.result.forfeitedPlayerId ?? null,
          score: match.result.playerScores?.[playerId] ?? 0,
          opponentDisplayName: opponent?.displayName ?? 'DuelBot',
          opponentScore: opponent
            ? match.result.playerScores?.[opponent.id] ?? 0
            : 0,
          xpEarned: matchXpForPlayer(match, playerId),
        };
      });
  }

  async getProgression(
    playerId: string,
    date: string,
  ): Promise<PlayerProgression | null> {
    if (!this.players.has(playerId)) return null;
    const totalXp = this.totalXp.get(playerId) ?? 0;
    const equipped = this.equipped.get(playerId)!;
    const quests = this.ensureQuests(playerId);
    return {
      totalXp,
      ...levelProgress(totalXp),
      equipped,
      mastery: CORE_MODES.map((mode) => ({
        mode,
        xp: 0,
        matchesPlayed: this.matches.filter(
          (match) => match.authenticatedPlayerIds.has(playerId)
            && match.modeOrder.includes(mode),
        ).length,
      })),
      inventory: [...(this.inventory.get(playerId) ?? [])].map((key) => {
        const [type, itemId] = key.split(':') as [CosmeticType, string];
        return {
          type,
          itemId,
          unlockedAt: Date.now(),
          source: 'test',
        };
      }),
      catalog: COSMETIC_CATALOG,
      dailyQuests: DAILY_QUESTS.map((definition) => ({
        key: definition.key,
        date,
        progress: quests.get(definition.key)!.progress,
        target: definition.target,
        rewardXp: definition.rewardXp,
        claimed: quests.get(definition.key)!.claimed,
      })),
    };
  }

  async claimDailyQuest(
    playerId: string,
    date: string,
    questKey: QuestKey,
  ): Promise<QuestClaimResult> {
    const definition = DAILY_QUESTS.find((quest) => quest.key === questKey);
    const state = this.ensureQuests(playerId).get(questKey);
    if (!definition || !state) return { status: 'not_found' };
    if (state.claimed) return { status: 'already_claimed' };
    if (state.progress < definition.target) return { status: 'not_complete' };
    state.claimed = true;
    this.addXp(playerId, definition.rewardXp);
    const progression = await this.getProgression(playerId, date);
    return progression
      ? { status: 'claimed', progression }
      : { status: 'not_found' };
  }

  async equipCosmetic(
    playerId: string,
    type: CosmeticType,
    itemId: string,
    date: string,
  ): Promise<EquipCosmeticResult> {
    if (!COSMETIC_CATALOG.some((item) => item.type === type && item.itemId === itemId)) {
      return { status: 'invalid_item' };
    }
    if (!this.inventory.get(playerId)?.has(`${type}:${itemId}`)) {
      return { status: 'not_owned' };
    }
    const current = this.equipped.get(playerId)!;
    this.equipped.set(playerId, {
      ...current,
      ...(type === 'avatar'
        ? { avatar: itemId }
        : type === 'frame'
          ? { frame: itemId }
          : { tableTheme: itemId }),
    });
    const progression = await this.getProgression(playerId, date);
    return progression
      ? { status: 'equipped', progression }
      : { status: 'not_owned' };
  }

  async recordAnalyticsEvents(
    playerId: string,
    events: readonly AnalyticsEvent[],
  ): Promise<number> {
    for (const event of events) this.analyticsEvents.push({ playerId, event });
    return events.length;
  }

  async recordFeedback(
    playerId: string,
    submission: FeedbackSubmission,
  ): Promise<boolean> {
    if (this.feedbackSubmissions.some((entry) => entry.submission.id === submission.id)) {
      return false;
    }
    this.feedbackSubmissions.push({ playerId, submission });
    return true;
  }

  private ensureQuests(playerId: string): Map<QuestKey, {
    progress: number;
    claimed: boolean;
  }> {
    let quests = this.quests.get(playerId);
    if (!quests) {
      quests = new Map(DAILY_QUESTS.map((quest) => [
        quest.key,
        { progress: 0, claimed: false },
      ]));
      this.quests.set(playerId, quests);
    }
    return quests;
  }

  private addXp(playerId: string, amount: number): void {
    const totalXp = (this.totalXp.get(playerId) ?? 0) + amount;
    this.totalXp.set(playerId, totalXp);
    const inventory = this.inventory.get(playerId);
    const level = levelFromXp(totalXp);
    for (const item of COSMETIC_CATALOG) {
      if (item.unlockLevel <= level) inventory?.add(`${item.type}:${item.itemId}`);
    }
  }
}

interface AuthResponse {
  player: StoredPlayer;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

function waitForEvent(
  room: Room,
  eventName: ServerMessage['payload']['event'],
  predicate: (message: ServerMessage) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);
    const unsubscribe = room.onMessage<ServerMessage>('event', (message) => {
      if (message.payload.event !== eventName || !predicate(message)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(message);
    });
  });
}

async function createGuest(baseUrl: string, displayName: string): Promise<AuthResponse> {
  const response = await fetch(`${baseUrl}/v1/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<AuthResponse>;
}

test('secure guest identity rotates tokens, owns the room seat and records match history', async () => {
  const store = new MemoryStore();
  const runtime: BackendRuntime = {
    store,
    tokens: new TokenService('test-secret-with-at-least-thirty-two-bytes-long'),
    allowLegacyPlayerIds: true,
  };
  const server = createGameServer(runtime);
  const port = 33_000 + Math.floor(Math.random() * 1_000);
  await server.listen(port, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  let hostRoom: Room | null = null;
  let guestRoom: Room | null = null;

  try {
    const hostAuth = await createGuest(baseUrl, 'Ada');
    const guestAuth = await createGuest(baseUrl, 'Mert');
    assert.match(hostAuth.player.id, /^[0-9a-f-]{36}$/);

    const meResponse = await fetch(`${baseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${hostAuth.accessToken}` },
    });
    assert.equal(meResponse.status, 200);

    const refreshResponse = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: hostAuth.refreshToken }),
    });
    assert.equal(refreshResponse.status, 200);
    const rotated = await refreshResponse.json() as AuthResponse;
    assert.notEqual(rotated.refreshToken, hostAuth.refreshToken);
    const reusedResponse = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: hostAuth.refreshToken }),
    });
    assert.equal(reusedResponse.status, 401);

    const hostClient = new Client(baseUrl);
    hostClient.auth.token = rotated.accessToken;
    hostRoom = await hostClient.create('duelcade', {
      playerId: 'spoofed-host-id',
      protocolVersion: PROTOCOL_VERSION,
    });
    const createdPromise = waitForEvent(hostRoom, 'room.snapshot');
    hostRoom.send('event', {
      event: 'room.create',
      payload: {
        displayName: 'Ada',
        avatarId: 'crown',
        rolePreference: 'no_preference',
        difficulty: 'easy',
        matchDurationMinutes: 2,
      },
    });
    const created = await createdPromise;
    assert.equal(created.playerId, hostAuth.player.id);
    assert.equal(
      created.payload.event === 'room.snapshot'
        ? created.payload.payload.room.hostId
        : null,
      hostAuth.player.id,
    );
    assert.equal(
      created.payload.event === 'room.snapshot'
        ? created.payload.payload.room.players[0]?.avatarId
        : null,
      'sparkles',
    );

    const guestClient = new Client(baseUrl);
    guestClient.auth.token = guestAuth.accessToken;
    guestRoom = await guestClient.joinById(created.roomId, {
      playerId: 'spoofed-guest-id',
      protocolVersion: PROTOCOL_VERSION,
    });
    const joinedPromise = waitForEvent(guestRoom, 'room.snapshot');
    guestRoom.send('event', {
      event: 'room.join',
      payload: {
        roomCode: created.roomId,
        displayName: 'Mert',
        avatarId: 'bolt',
        rolePreference: 'no_preference',
      },
    });
    await joinedPromise;

    const startedPromise = waitForEvent(hostRoom, 'state.patch', (message) =>
      message.payload.event === 'state.patch'
      && message.payload.payload.patches.some((patch) => patch.path === 'turnMatch'),
    );
    hostRoom.send('event', { event: 'player.ready', payload: { ready: true } });
    guestRoom.send('event', { event: 'player.ready', payload: { ready: true } });
    await startedPromise;

    const completedPromise = waitForEvent(hostRoom, 'game.completed');
    guestRoom.send('event', {
      event: 'match.forfeit',
      payload: { reason: 'player_confirmed_exit' },
    });
    await completedPromise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(store.matches.length, 1);
    assert.deepEqual(
      [...store.matches[0].authenticatedPlayerIds].sort(),
      [hostAuth.player.id, guestAuth.player.id].sort(),
    );

    const historyResponse = await fetch(`${baseUrl}/v1/matches?limit=10`, {
      headers: { authorization: `Bearer ${rotated.accessToken}` },
    });
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json() as { matches: MatchHistoryItem[] };
    assert.equal(history.matches.length, 1);
    assert.equal(history.matches[0].opponentDisplayName, 'Mert');
    assert.equal(history.matches[0].xpEarned, 55);

    const progressionResponse = await fetch(`${baseUrl}/v1/progression`, {
      headers: { authorization: `Bearer ${rotated.accessToken}` },
    });
    assert.equal(progressionResponse.status, 200);
    const initialProgression = await progressionResponse.json() as {
      progression: PlayerProgression;
    };
    assert.equal(initialProgression.progression.totalXp, 55);
    assert.equal(
      initialProgression.progression.dailyQuests
        .find((quest) => quest.key === 'play_duel')?.progress,
      1,
    );

    for (const questKey of ['play_duel', 'win_duel'] as const) {
      const claimResponse = await fetch(
        `${baseUrl}/v1/quests/${questKey}/claim`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${rotated.accessToken}` },
        },
      );
      assert.equal(claimResponse.status, 200);
    }
    const incompleteClaim = await fetch(
      `${baseUrl}/v1/quests/win_rounds/claim`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${rotated.accessToken}` },
      },
    );
    assert.equal(incompleteClaim.status, 409);

    const equipResponse = await fetch(`${baseUrl}/v1/me/cosmetics`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${rotated.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'avatar', itemId: 'bot' }),
    });
    assert.equal(equipResponse.status, 200);
    const equipped = await equipResponse.json() as {
      progression: PlayerProgression;
    };
    assert.equal(equipped.progression.totalXp, 155);
    assert.equal(equipped.progression.level, 2);
    assert.equal(equipped.progression.equipped.avatar, 'bot');

    const analyticsResponse = await fetch(`${baseUrl}/v1/analytics/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rotated.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contractVersion: 1,
        events: [{
          id: 'f4c6ddea-4dd4-43b7-b2d2-a41280cc92a0',
          name: 'match_completed',
          sessionId: '180ddca2-96ca-4f2d-8460-bf09edbd4ae0',
          occurredAt: Date.now(),
          platform: 'web',
          appVersion: '1.0.0',
          properties: {
            playMode: 'online',
            difficulty: 'easy',
            result: 'win',
            durationBucket: 'under_2m',
            roundCount: 2,
          },
        }],
      }),
    });
    assert.equal(analyticsResponse.status, 202);
    assert.deepEqual(await analyticsResponse.json(), { accepted: 1 });
    assert.equal(store.analyticsEvents[0].playerId, hostAuth.player.id);

    const unsafeAnalytics = await fetch(`${baseUrl}/v1/analytics/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rotated.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contractVersion: 1,
        events: [{
          id: '6ab8dbe7-7235-4db9-8d51-570b8050bb83',
          name: 'match_completed',
          sessionId: '180ddca2-96ca-4f2d-8460-bf09edbd4ae0',
          occurredAt: Date.now(),
          platform: 'web',
          appVersion: '1.0.0',
          properties: { roomCode: 'SECRET' },
        }],
      }),
    });
    assert.equal(unsafeAnalytics.status, 400);
    assert.equal(store.analyticsEvents.length, 1);

    const feedbackId = '9b00fc0c-88b9-44e7-93da-aef8ac355a89';
    const feedbackBody = {
      id: feedbackId,
      category: 'tutorial',
      rating: 4,
      message: 'The first round explained the controls clearly.',
      screen: 'results',
      platform: 'android',
      appVersion: '1.0.0',
      buildVersion: '3',
      locale: 'en',
    };
    const feedbackResponse = await fetch(`${baseUrl}/v1/feedback`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rotated.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(feedbackBody),
    });
    assert.equal(feedbackResponse.status, 202);
    assert.deepEqual(await feedbackResponse.json(), {
      id: feedbackId,
      accepted: true,
    });
    assert.equal(store.feedbackSubmissions[0].playerId, hostAuth.player.id);
    assert.equal(store.feedbackSubmissions[0].submission.message, feedbackBody.message);

    const duplicateFeedback = await fetch(`${baseUrl}/v1/feedback`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rotated.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(feedbackBody),
    });
    assert.equal(duplicateFeedback.status, 202);
    assert.deepEqual(await duplicateFeedback.json(), {
      id: feedbackId,
      accepted: false,
    });
    assert.equal(store.feedbackSubmissions.length, 1);

    const unsafeFeedback = await fetch(`${baseUrl}/v1/feedback`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rotated.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...feedbackBody,
        id: '57f2b54e-6caf-41b1-b889-a1285665fcad',
        message: 'bad\u0000message',
      }),
    });
    assert.equal(unsafeFeedback.status, 400);
    assert.equal(store.feedbackSubmissions.length, 1);
  } finally {
    await hostRoom?.leave();
    await guestRoom?.leave();
    await server.gracefullyShutdown(false);
  }
});

test('Firebase ID tokens create and restore one authoritative Duelcade account', async () => {
  const store = new MemoryStore();
  const runtime: BackendRuntime = {
    store,
    tokens: new TokenService('firebase-test-secret-with-thirty-two-bytes-minimum'),
    allowLegacyPlayerIds: true,
    firebaseAuth: {
      async verify(idToken) {
        if (idToken !== `valid-${'x'.repeat(110)}`) throw new Error('invalid token');
        return {
          uid: 'firebase-user-1',
          email: 'ada@example.com',
          emailVerified: true,
          displayName: 'Ada Firebase',
          signInProvider: 'google.com',
        };
      },
    },
  };
  const server = createGameServer(runtime);
  const port = 34_000 + Math.floor(Math.random() * 1_000);
  await server.listen(port, '127.0.0.1');
  const endpoint = `http://127.0.0.1:${port}/v1/auth/firebase/exchange`;
  const exchange = (idToken: string) => fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  try {
    const firstResponse = await exchange(`valid-${'x'.repeat(110)}`);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as AuthResponse;
    assert.equal(first.player.displayName, 'Ada Firebase');

    const secondResponse = await exchange(`valid-${'x'.repeat(110)}`);
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json() as AuthResponse;
    assert.equal(second.player.id, first.player.id);
    assert.notEqual(second.refreshToken, first.refreshToken);

    const rejected = await exchange(`invalid-${'x'.repeat(110)}`);
    assert.equal(rejected.status, 401);
  } finally {
    await server.gracefullyShutdown(false);
  }
});

test('access tokens reject tampering and expiration', () => {
  const tokens = new TokenService('another-test-secret-with-thirty-two-bytes-minimum');
  const issued = tokens.issue('player-id', undefined, 1_000_000);
  assert.equal(tokens.verify(issued.accessToken, 1_000_001)?.sub, 'player-id');
  assert.equal(tokens.verify(`${issued.accessToken}x`, 1_000_001), null);
  assert.equal(tokens.verify(issued.accessToken, issued.accessTokenExpiresAt), null);
  const runtime: BackendRuntime = {
    store: null,
    tokens,
    allowLegacyPlayerIds: true,
  };
  assert.equal(
    authenticateRoomClient(
      runtime,
      { token: '' },
      '30642da1-4468-4a4a-a343-c213f595f113',
    ),
    false,
  );
  assert.deepEqual(
    authenticateRoomClient(runtime, { token: '' }, 'legacy-player'),
    { playerId: 'legacy-player', authenticated: false },
  );
});
