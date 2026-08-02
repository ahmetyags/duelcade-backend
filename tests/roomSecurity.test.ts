import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, type Room } from '@colyseus/sdk';

import { createGameServer } from '../server/app';
import { ROOM_REGISTRATION_TIMEOUT_MS } from '../server/DuelcadeRoom';
import {
  PROTOCOL_VERSION,
  SERVER_CLOSE_CODE,
  type ServerMessage,
} from '../types/network';

function waitForEvent(
  room: Room,
  eventName: ServerMessage['payload']['event'],
  timeoutMs = 5_000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);
    const unsubscribe = room.onMessage<ServerMessage>('event', (message) => {
      if (message.payload.event !== eventName) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(message);
    });
  });
}

function waitForLeave(room: Room, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for room leave'));
    }, timeoutMs);
    room.onLeave.once((code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function registrationOptions(playerId: string) {
  return { playerId, protocolVersion: PROTOCOL_VERSION };
}

function waitForSeatRelease(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

function joinPayload(roomCode: string, displayName: string) {
  return {
    event: 'room.join' as const,
    payload: {
      roomCode,
      displayName,
      avatarId: 'bolt' as const,
      rolePreference: 'no_preference' as const,
    },
  };
}

test('room registration rejects duplicate identities and evicts idle seat reservations', async () => {
  const server = createGameServer();
  const port = 32_000 + Math.floor(Math.random() * 1_000);
  await server.listen(port, '127.0.0.1');

  const endpoint = `http://127.0.0.1:${port}`;
  const hostClient = new Client(endpoint);
  const duplicateClient = new Client(endpoint);
  const idleClient = new Client(endpoint);
  const guestClient = new Client(endpoint);
  let hostRoom: Room | null = null;
  let duplicateRoom: Room | null = null;
  let idleRoom: Room | null = null;
  let guestRoom: Room | null = null;

  try {
    hostRoom = await hostClient.create('duelcade', registrationOptions('secure-host'));
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

    duplicateRoom = await duplicateClient.joinById(
      created.roomId,
      registrationOptions('secure-host'),
    );
    const conflictPromise = waitForEvent(duplicateRoom, 'error');
    const duplicateLeavePromise = waitForLeave(duplicateRoom);
    duplicateRoom.send('event', joinPayload(created.roomId, 'Copy'));
    const conflict = await conflictPromise;
    assert.equal(conflict.payload.event, 'error');
    if (conflict.payload.event === 'error') {
      assert.equal(conflict.payload.payload.errorCode, 'PLAYER_ID_CONFLICT');
    }
    assert.equal(
      await duplicateLeavePromise,
      SERVER_CLOSE_CODE.REGISTRATION_REJECTED,
    );
    duplicateRoom = null;
    await waitForSeatRelease();

    idleRoom = await idleClient.joinById(
      created.roomId,
      registrationOptions('idle-seat'),
    );
    assert.equal(
      await waitForLeave(idleRoom, ROOM_REGISTRATION_TIMEOUT_MS + 1_000),
      SERVER_CLOSE_CODE.REGISTRATION_TIMEOUT,
    );
    idleRoom = null;
    await waitForSeatRelease();

    guestRoom = await guestClient.joinById(
      created.roomId,
      registrationOptions('secure-guest'),
    );
    const joinedPromise = waitForEvent(guestRoom, 'room.snapshot');
    guestRoom.send('event', joinPayload(created.roomId, 'Mert'));
    const joined = await joinedPromise;
    assert.equal(joined.payload.event, 'room.snapshot');
    if (joined.payload.event === 'room.snapshot') {
      assert.deepEqual(
        joined.payload.payload.room.players.map((player) => player.id),
        ['secure-host', 'secure-guest'],
      );
    }
  } finally {
    await hostRoom?.leave();
    await duplicateRoom?.leave();
    await idleRoom?.leave();
    await guestRoom?.leave();
    await server.gracefullyShutdown(false);
  }
});
