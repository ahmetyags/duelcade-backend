import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';

import { hashRefreshToken } from './auth/Tokens';
import {
  utcDateKey,
  type CosmeticType,
  type QuestKey,
} from './progression';
import type { BackendRuntime } from './runtime';
import { AnalyticsBatchSchema } from './analytics';

const DisplayNameSchema = z.string().trim().min(1).max(24);
const GuestSchema = z.object({
  displayName: DisplayNameSchema,
});
const RefreshSchema = z.object({
  refreshToken: z.string().min(50).max(256),
});
const UpdateProfileSchema = z.object({
  displayName: DisplayNameSchema,
});
const QuestKeySchema = z.enum(['play_duel', 'win_duel', 'win_rounds']);
const EquipCosmeticSchema = z.object({
  type: z.enum(['avatar', 'frame', 'table_theme']),
  itemId: z.string().trim().min(1).max(40),
});

function bearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

function sendUnavailable(response: Response): void {
  response.status(503).json({
    error: 'PERSISTENCE_UNAVAILABLE',
    message: 'Player persistence is not configured.',
  });
}

function rateLimit(
  windowMs: number,
  maximum: number,
): (request: Request, response: Response, next: NextFunction) => void {
  const attempts = new Map<string, { count: number; resetsAt: number }>();
  return (request, response, next) => {
    const now = Date.now();
    if (attempts.size > 1_000) {
      for (const [candidate, bucket] of attempts) {
        if (bucket.resetsAt <= now) attempts.delete(candidate);
      }
    }
    const key = request.ip || request.socket.remoteAddress || 'unknown';
    const current = attempts.get(key);
    const bucket = !current || current.resetsAt <= now
      ? { count: 0, resetsAt: now + windowMs }
      : current;
    bucket.count += 1;
    attempts.set(key, bucket);
    if (bucket.count > maximum) {
      response.setHeader('Retry-After', Math.ceil((bucket.resetsAt - now) / 1000));
      response.status(429).json({ error: 'RATE_LIMITED' });
      return;
    }
    next();
  };
}

function requirePlayer(
  runtime: BackendRuntime,
  request: Request,
  response: Response,
): string | null {
  if (!runtime.tokens) {
    sendUnavailable(response);
    return null;
  }
  const raw = bearerToken(request);
  const claims = raw ? runtime.tokens.verify(raw) : null;
  if (!claims) {
    response.status(401).json({ error: 'INVALID_ACCESS_TOKEN' });
    return null;
  }
  return claims.sub;
}

export function configureApi(
  router: Router,
  runtime: BackendRuntime,
  allowedOrigins: ReadonlySet<string>,
): void {
  router.use('/v1', (request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.sendStatus(origin && allowedOrigins.has(origin) ? 204 : 403);
      return;
    }
    next();
  });

  router.post(
    '/v1/auth/guest',
    rateLimit(60 * 60 * 1000, 10),
    async (request: Request, response: Response) => {
    if (!runtime.store || !runtime.tokens) {
      sendUnavailable(response);
      return;
    }
    const parsed = GuestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    const playerId = randomUUID();
    const issued = runtime.tokens.issue(playerId);
    const player = await runtime.store.createGuestSession({
      playerId,
      displayName: parsed.data.displayName,
      sessionId: issued.sessionId,
      refreshTokenHash: issued.refreshTokenHash,
      refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
    });
    response.status(201).json({
      player,
      accessToken: issued.accessToken,
      accessTokenExpiresAt: issued.accessTokenExpiresAt,
      refreshToken: issued.refreshToken,
      refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
    });
    },
  );

  router.post(
    '/v1/auth/refresh',
    rateLimit(15 * 60 * 1000, 60),
    async (request: Request, response: Response) => {
    if (!runtime.store || !runtime.tokens) {
      sendUnavailable(response);
      return;
    }
    const parsed = RefreshSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    const now = Date.now();
    const sessionId = runtime.tokens.refreshSessionId(parsed.data.refreshToken);
    if (!sessionId) {
      response.status(401).json({ error: 'INVALID_REFRESH_TOKEN' });
      return;
    }
    const nextRefresh = runtime.tokens.issueRefresh(sessionId, now);
    const rotated = await runtime.store.rotateSession({
      currentRefreshTokenHash: hashRefreshToken(parsed.data.refreshToken),
      nextRefreshTokenHash: nextRefresh.refreshTokenHash,
      nextRefreshTokenExpiresAt: nextRefresh.refreshTokenExpiresAt,
      now,
    });
    if (!rotated || rotated.sessionId !== sessionId) {
      response.status(401).json({ error: 'INVALID_REFRESH_TOKEN' });
      return;
    }
    const access = runtime.tokens.issueAccess(rotated.player.id, sessionId, now);
    response.json({
      player: rotated.player,
      ...access,
      refreshToken: nextRefresh.refreshToken,
      refreshTokenExpiresAt: nextRefresh.refreshTokenExpiresAt,
    });
    },
  );

  router.post('/v1/auth/logout', async (request: Request, response: Response) => {
    if (!runtime.store) {
      sendUnavailable(response);
      return;
    }
    const parsed = RefreshSchema.safeParse(request.body);
    if (parsed.success) {
      await runtime.store.revokeSession(hashRefreshToken(parsed.data.refreshToken));
    }
    response.sendStatus(204);
  });

  router.get('/v1/me', async (request: Request, response: Response) => {
    if (!runtime.store) {
      sendUnavailable(response);
      return;
    }
    const playerId = requirePlayer(runtime, request, response);
    if (!playerId) return;
    const player = await runtime.store.getPlayer(playerId);
    if (!player) {
      response.status(404).json({ error: 'PLAYER_NOT_FOUND' });
      return;
    }
    response.json({ player });
  });

  router.patch('/v1/me', async (request: Request, response: Response) => {
    if (!runtime.store) {
      sendUnavailable(response);
      return;
    }
    const playerId = requirePlayer(runtime, request, response);
    if (!playerId) return;
    const parsed = UpdateProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    const player = await runtime.store.updatePlayerName(playerId, parsed.data.displayName);
    if (!player) {
      response.status(404).json({ error: 'PLAYER_NOT_FOUND' });
      return;
    }
    response.json({ player });
  });

  router.get('/v1/matches', async (request: Request, response: Response) => {
    if (!runtime.store) {
      sendUnavailable(response);
      return;
    }
    const playerId = requirePlayer(runtime, request, response);
    if (!playerId) return;
    const requestedLimit = Number(request.query.limit ?? 20);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(50, Math.max(1, requestedLimit))
      : 20;
    const matches = await runtime.store.listMatches(playerId, limit);
    response.json({ matches });
  });

  router.get('/v1/progression', async (
    request: Request,
    response: Response,
  ) => {
    if (!runtime.store) {
      sendUnavailable(response);
      return;
    }
    const playerId = requirePlayer(runtime, request, response);
    if (!playerId) return;
    const progression = await runtime.store.getProgression(
      playerId,
      utcDateKey(),
    );
    if (!progression) {
      response.status(404).json({ error: 'PLAYER_NOT_FOUND' });
      return;
    }
    response.json({ progression });
  });

  router.post('/v1/quests/:questKey/claim', async (
    request: Request,
    response: Response,
  ) => {
    if (!runtime.store) {
      sendUnavailable(response);
      return;
    }
    const playerId = requirePlayer(runtime, request, response);
    if (!playerId) return;
    const parsedKey = QuestKeySchema.safeParse(request.params.questKey);
    if (!parsedKey.success) {
      response.status(400).json({ error: 'INVALID_QUEST' });
      return;
    }
    const result = await runtime.store.claimDailyQuest(
      playerId,
      utcDateKey(),
      parsedKey.data as QuestKey,
    );
    if (result.status === 'claimed') {
      response.json({ progression: result.progression });
      return;
    }
    const status = result.status === 'not_found'
      ? 404
      : result.status === 'not_complete'
        ? 409
        : 409;
    response.status(status).json({ error: result.status.toUpperCase() });
  });

  router.patch('/v1/me/cosmetics', async (
    request: Request,
    response: Response,
  ) => {
    if (!runtime.store) {
      sendUnavailable(response);
      return;
    }
    const playerId = requirePlayer(runtime, request, response);
    if (!playerId) return;
    const parsed = EquipCosmeticSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    const result = await runtime.store.equipCosmetic(
      playerId,
      parsed.data.type as CosmeticType,
      parsed.data.itemId,
      utcDateKey(),
    );
    if (result.status === 'equipped') {
      response.json({ progression: result.progression });
      return;
    }
    response.status(result.status === 'invalid_item' ? 400 : 403).json({
      error: result.status === 'invalid_item'
        ? 'INVALID_COSMETIC'
        : 'COSMETIC_NOT_OWNED',
    });
  });

  router.post(
    '/v1/analytics/events',
    rateLimit(60 * 1000, 30),
    async (request: Request, response: Response) => {
      if (!runtime.store) {
        sendUnavailable(response);
        return;
      }
      const playerId = requirePlayer(runtime, request, response);
      if (!playerId) return;
      const parsed = AnalyticsBatchSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'INVALID_ANALYTICS_BATCH' });
        return;
      }
      const accepted = await runtime.store.recordAnalyticsEvents(
        playerId,
        parsed.data.events,
      );
      response.status(202).json({ accepted });
    },
  );

  router.use((
    error: unknown,
    _request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    console.error('[api] Request failed', error);
    if (!response.headersSent) {
      response.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });
}
