import { defineRoom, defineServer } from 'colyseus';
import express from 'express';

import { DuelcadeRoom } from './DuelcadeRoom';
import { configureApi } from './api';
import {
  createDisabledRuntime,
  type BackendRuntime,
} from './runtime';
import { PROTOCOL_VERSION } from '../types/network';

function allowedOrigins(): ReadonlySet<string> {
  return new Set(
    (process.env.ALLOWED_ORIGINS ?? 'https://duelcade.expo.app')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function createGameServer(runtime: BackendRuntime = createDisabledRuntime()) {
  class RuntimeDuelcadeRoom extends DuelcadeRoom {
    static override runtime = runtime;
  }
  return defineServer({
    rooms: {
      duelcade: defineRoom(RuntimeDuelcadeRoom),
    },
    express: (app) => {
      app.set('trust proxy', 1);
      app.use(express.json({ limit: '16kb' }));
      configureApi(app, runtime, allowedOrigins());
      app.get('/health', (
        _request: unknown,
        response: { json: (body: Record<string, unknown>) => void },
      ) => {
        response.json({
          ok: true,
          service: 'duelcade-server',
          protocolVersion: PROTOCOL_VERSION,
          persistence: runtime.store?.available === true ? 'ready' : 'unavailable',
        });
      });
    },
  });
}
