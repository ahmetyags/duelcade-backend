import { defineRoom, defineServer } from 'colyseus';

import { DuelcadeRoom } from './DuelcadeRoom';
import { PROTOCOL_VERSION } from '../types/network';

export function createGameServer() {
  return defineServer({
    rooms: {
      duelcade: defineRoom(DuelcadeRoom),
    },
    express: (app) => {
      app.get('/health', (
        _request: unknown,
        response: { json: (body: Record<string, unknown>) => void },
      ) => {
        response.json({
          ok: true,
          service: 'duelcade-server',
          protocolVersion: PROTOCOL_VERSION,
        });
      });
    },
  });
}
