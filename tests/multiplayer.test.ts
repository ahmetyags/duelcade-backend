import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, type Room } from '@colyseus/sdk';

import { createGameServer } from '../server/app';
import { PROTOCOL_VERSION, type ServerMessage } from '../types/network';
import type { TurnMatchState } from '../types/turnGame';

function waitForEvent(
  room: Room,
  eventName: ServerMessage['payload']['event'],
  predicate: (message: ServerMessage) => boolean = () => true,
  timeoutMs = 5000,
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

function turnState(message: ServerMessage): TurnMatchState | null {
  if (message.payload.event !== 'state.patch') return null;
  const patch = message.payload.payload.patches.find((item) => item.path === 'turnMatch');
  return patch?.value as TurnMatchState | null;
}

test('two clients share one authoritative board and can only play in turn', async () => {
  const server = createGameServer();
  const port = 31000 + Math.floor(Math.random() * 1000);
  await server.listen(port, '127.0.0.1');

  const endpoint = `http://127.0.0.1:${port}`;
  const hostClient = new Client(endpoint);
  const guestClient = new Client(endpoint);
  let hostRoom: Room | null = null;
  let guestRoom: Room | null = null;

  try {
    hostRoom = await hostClient.create('duelcade', {
      playerId: 'turn-host',
      protocolVersion: PROTOCOL_VERSION,
    });
    const createdPromise = waitForEvent(hostRoom, 'room.snapshot');
    hostRoom.send('event', {
      event: 'room.create',
      payload: {
        displayName: 'Ada',
        avatarId: 'sparkles',
        rolePreference: 'no_preference',
        difficulty: 'easy',
        matchDurationMinutes: 3,
      },
    });
    const created = await createdPromise;
    if (created.payload.event !== 'room.snapshot') throw new Error('Unexpected snapshot');

    guestRoom = await guestClient.joinById(created.roomId, {
      playerId: 'turn-guest',
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

    const hostBoardPromise = waitForEvent(hostRoom, 'state.patch', (message) => !!turnState(message));
    const guestBoardPromise = waitForEvent(guestRoom, 'state.patch', (message) => !!turnState(message));
    hostRoom.send('event', { event: 'player.ready', payload: { ready: true } });
    guestRoom.send('event', { event: 'player.ready', payload: { ready: true } });
    const [hostBoard, guestBoard] = await Promise.all([hostBoardPromise, guestBoardPromise]);
    const initial = turnState(hostBoard);
    assert.ok(initial);
    assert.deepEqual(initial, turnState(guestBoard));
    assert.ok([
      'rune_grid',
      'pipe_circuit',
      'connect_four',
      'resonance_dials',
      'memory_pairs',
      'cipher_clash',
      'circuit_claim',
      'neon_trail',
      'gateway_race',
      'polarity_war',
    ].includes(initial.mode));
    assert.deepEqual(initial.playerIds, ['turn-host', 'turn-guest']);
    assert.equal(initial.activePlayerIndex, 0);
    assert.ok(initial.cells.length >= 3);

    const rejectedPromise = waitForEvent(guestRoom, 'error');
    guestRoom.send('event', {
      event: 'turn.move',
      payload: { cell: 0, expectedMove: initial.moveNumber },
    });
    const rejected = await rejectedPromise;
    if (rejected.payload.event !== 'error') throw new Error('Expected turn error');
    assert.equal(rejected.payload.payload.userMessageKey, 'error.not_your_turn');

    const hostMovePromise = waitForEvent(hostRoom, 'state.patch', (message) => {
      const state = turnState(message);
      return state?.moveNumber === 1;
    });
    const guestMovePromise = waitForEvent(guestRoom, 'state.patch', (message) => {
      const state = turnState(message);
      return state?.moveNumber === 1;
    });
    const hostCell = initial.mode === 'neon_trail'
      ? 1
      : initial.mode === 'gateway_race'
        ? initial.playerPositions![0] - initial.boardColumns
        : initial.mode === 'polarity_war'
          ? (initial.boardRows / 2 - 1) * initial.boardColumns
            + initial.boardColumns / 2 - 1
            - initial.boardColumns
            + 1
          : 0;
    hostRoom.send('event', {
      event: 'turn.move',
      payload: { cell: hostCell, expectedMove: initial.moveNumber },
    });
    const [hostMove, guestMove] = await Promise.all([hostMovePromise, guestMovePromise]);
    const next = turnState(hostMove);
    assert.ok(next);
    assert.deepEqual(next, turnState(guestMove));
    assert.equal(next.activePlayerIndex, initial.mode === 'memory_pairs' ? 0 : 1);


    const chatPromise = waitForEvent(guestRoom, 'chat.received');
    hostRoom.send('event', { event: 'chat.send', payload: { text: 'İyi hamle!' } });
    const chat = await chatPromise;
    if (chat.payload.event !== 'chat.received') throw new Error('Unexpected chat event');
    assert.equal(chat.payload.payload.message.text, 'İyi hamle!');

    const skipNotificationPromise = waitForEvent(guestRoom, 'round.skip.updated');
    const skipRequestedPromise = waitForEvent(hostRoom, 'state.patch', (message) => {
      const state = turnState(message);
      return state?.roundId === next.roundId && state.skipVotes[0] === true;
    });
    hostRoom.send('event', { event: 'round.skip.vote', payload: { vote: true } });
    const skipNotification = await skipNotificationPromise;
    assert.equal(skipNotification.payload.event, 'round.skip.updated');
    if (skipNotification.payload.event === 'round.skip.updated') {
      assert.equal(skipNotification.payload.payload.requestedByPlayerId, initial.playerIds[0]);
      assert.deepEqual(skipNotification.payload.payload.skipVotes, [true, false]);
    }
    const skipRequested = turnState(await skipRequestedPromise);
    assert.deepEqual(skipRequested?.skipVotes, [true, false]);

    const skippedHostPromise = waitForEvent(hostRoom, 'state.patch', (message) => {
      const state = turnState(message);
      return !!state && state.roundId !== next.roundId;
    });
    const skippedGuestPromise = waitForEvent(guestRoom, 'state.patch', (message) => {
      const state = turnState(message);
      return !!state && state.roundId !== next.roundId;
    });
    guestRoom.send('event', { event: 'round.skip.vote', payload: { vote: true } });
    const [skippedHost, skippedGuest] = await Promise.all([skippedHostPromise, skippedGuestPromise]);
    const skippedState = turnState(skippedHost);
    assert.deepEqual(skippedState, turnState(skippedGuest));
    assert.notEqual(skippedState?.mode, initial.mode);
    assert.deepEqual(skippedState?.scores, [0, 0]);
    assert.deepEqual(skippedState?.skipVotes, [false, false]);

    const hostResultPromise = waitForEvent(hostRoom, 'game.completed');
    const guestResultPromise = waitForEvent(guestRoom, 'game.completed');
    guestRoom.send('event', {
      event: 'match.forfeit',
      payload: { reason: 'player_confirmed_exit' },
    });
    const [hostResult, guestResult] = await Promise.all([hostResultPromise, guestResultPromise]);
    if (
      hostResult.payload.event !== 'game.completed'
      || guestResult.payload.event !== 'game.completed'
    ) throw new Error('Expected shared forfeit result');
    assert.equal(hostResult.payload.payload.result.forfeitedPlayerId, 'turn-guest');
    assert.equal(hostResult.payload.payload.result.winnerPlayerId, 'turn-host');
    assert.deepEqual(hostResult.payload.payload.result, guestResult.payload.payload.result);

    const rematchLobbyPromise = waitForEvent(hostRoom, 'room.snapshot', (message) =>
      message.payload.event === 'room.snapshot'
      && message.payload.payload.room.status === 'waiting',
    );
    hostRoom.send('event', { event: 'rematch.vote', payload: { vote: true } });
    guestRoom.send('event', { event: 'rematch.vote', payload: { vote: true } });
    const rematchLobby = await rematchLobbyPromise;
    if (rematchLobby.payload.event !== 'room.snapshot') {
      throw new Error('Expected rematch lobby');
    }
    assert.equal(rematchLobby.payload.payload.room.players.length, 2);
    assert.ok(rematchLobby.payload.payload.room.players.every((player) => !player.isReady));
  } finally {
    await hostRoom?.leave();
    await guestRoom?.leave();
    await server.gracefullyShutdown(false);
  }
});

test('manual reconnect replays the room snapshot after a full client reload', async () => {
  const server = createGameServer();
  const port = 32000 + Math.floor(Math.random() * 1000);
  await server.listen(port, '127.0.0.1');

  const endpoint = `http://127.0.0.1:${port}`;
  const client = new Client(endpoint);
  let room: Room | null = null;
  let restored: Room | null = null;

  try {
    room = await client.create('duelcade', {
      playerId: 'reload-host',
      protocolVersion: PROTOCOL_VERSION,
    });
    const createdPromise = waitForEvent(room, 'room.snapshot');
    room.send('event', {
      event: 'room.create',
      payload: {
        displayName: 'Reload Host',
        avatarId: 'sparkles',
        rolePreference: 'no_preference',
        difficulty: 'easy',
        matchDurationMinutes: 2,
      },
    });
    await createdPromise;
    const reconnectionToken = room.reconnectionToken;
    room.reconnection.maxRetries = 0;
    (room as unknown as {
      connection: { transport: { ws: { close: () => void } } };
    }).connection.transport.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    restored = await new Client(endpoint).reconnect(reconnectionToken);
    const snapshotPromise = waitForEvent(
      restored,
      'room.snapshot',
      (message) => message.payload.event === 'room.snapshot'
        && message.payload.payload.isReconnect,
    );
    restored.send('event', { event: 'room.sync', payload: {} });
    const snapshot = await snapshotPromise;

    assert.equal(snapshot.payload.event, 'room.snapshot');
    if (snapshot.payload.event === 'room.snapshot') {
      assert.equal(snapshot.payload.payload.isReconnect, true);
      assert.equal(snapshot.payload.payload.room.players[0]?.id, 'reload-host');
    }
  } finally {
    await restored?.leave();
    await server.gracefullyShutdown(false);
  }
});
