import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';

import { hashRefreshToken, type IssuedTokens } from './auth/Tokens';
import { hashPassword, verifyPassword } from './auth/Password';
import {
  exchangeOAuthCode,
  oauthAvailable,
  oauthAuthorizationUrl,
  randomOAuthCode,
  type OAuthProvider,
} from './auth/OAuth';
import type { StoredPlayer } from './persistence/types';
import {
  utcDateKey,
  type CosmeticType,
  type QuestKey,
} from './progression';
import type { BackendRuntime } from './runtime';
import { AnalyticsBatchSchema } from './analytics';
import { FeedbackSubmissionSchema } from './feedback';

const DisplayNameSchema = z.string().trim().min(1).max(24);
const GuestSchema = z.object({
  displayName: DisplayNameSchema,
});
const RefreshSchema = z.object({
  refreshToken: z.string().min(50).max(256),
});
const EmailLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(8).max(128),
});
const EmailRegisterSchema = EmailLoginSchema.extend({
  displayName: DisplayNameSchema,
  password: z.string().min(8).max(128)
    .regex(/[a-z]/, 'PASSWORD_LOWERCASE_REQUIRED')
    .regex(/[A-Z]/, 'PASSWORD_UPPERCASE_REQUIRED')
    .regex(/[0-9]/, 'PASSWORD_NUMBER_REQUIRED'),
});
const OAuthProviderSchema = z.enum(['google', 'facebook', 'github']);
const OAuthStartSchema = z.object({ redirectUri: z.string().url().max(500) });
const OAuthExchangeSchema = z.object({ code: z.string().min(40).max(100) });
const FirebaseExchangeSchema = z.object({
  idToken: z.string().min(100).max(10_000),
  displayName: DisplayNameSchema.optional(),
});
const UpdateProfileSchema = z.object({
  displayName: DisplayNameSchema,
});
const QuestKeySchema = z.enum(['play_duel', 'win_duel', 'win_rounds']);
const EquipCosmeticSchema = z.object({
  type: z.enum(['avatar', 'frame', 'table_theme']),
  itemId: z.string().trim().min(1).max(40),
});

type LeaderboardSummary = {
  globalRank: number | null;
  totalScore: number;
  wins: number;
  losses: number;
  winRate: number;
};

type CompetitiveSummary = {
  seasonRating: number;
  league: 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond' | 'Master' | 'Grandmaster';
  season: string;
  results: {
    wins: number;
    losses: number;
    draws: number;
  };
  winRate: number;
};

function winRate(wins: number, losses: number, draws = 0): number {
  const played = wins + losses + draws;
  return played === 0 ? 0 : Math.round((wins / played) * 100);
}

function leagueForRating(rating: number): CompetitiveSummary['league'] {
  if (rating >= 2400) return 'Grandmaster';
  if (rating >= 2100) return 'Master';
  if (rating >= 1850) return 'Diamond';
  if (rating >= 1650) return 'Platinum';
  if (rating >= 1450) return 'Gold';
  if (rating >= 1250) return 'Silver';
  return 'Bronze';
}

function currentSeason(now = Date.now()) {
  const start = new Date(now);
  start.setUTCMonth(0, 1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCFullYear(start.getUTCFullYear() + 1);
  return {
    id: `${start.getUTCFullYear()}-s1`,
    name: 'Season 1',
    startsAt: start.getTime(),
    endsAt: end.getTime(),
  };
}

function summarizeLeaderboard(
  playerId: string,
  matches: Awaited<ReturnType<NonNullable<BackendRuntime['store']>['listMatches']>>,
): LeaderboardSummary {
  const wins = matches.filter((match) => match.winnerPlayerId === playerId).length;
  const losses = matches.filter((match) =>
    match.winnerPlayerId !== null && match.winnerPlayerId !== playerId
  ).length;
  return {
    globalRank: matches.length > 0 ? 1 : null,
    totalScore: matches.reduce((total, match) => total + match.score, 0),
    wins,
    losses,
    winRate: winRate(wins, losses),
  };
}

function sessionResponse(player: StoredPlayer, issued: IssuedTokens) {
  return {
    player,
    accessToken: issued.accessToken,
    accessTokenExpiresAt: issued.accessTokenExpiresAt,
    refreshToken: issued.refreshToken,
    refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
  };
}

function publicBaseUrl(request: Request): string {
  return process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '')
    ?? `${request.protocol}://${request.get('host')}`;
}

function safeAppRedirect(value: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'duelcade:' && url.hostname === 'auth' && url.pathname === '/callback') {
      return true;
    }
    return (url.protocol === 'https:' || url.hostname === 'localhost')
      && allowedOrigins.has(url.origin)
      && url.pathname === '/auth/callback';
  } catch {
    return false;
  }
}

function summarizeCompetitive(
  playerId: string,
  matches: Awaited<ReturnType<NonNullable<BackendRuntime['store']>['listMatches']>>,
): CompetitiveSummary {
  const wins = matches.filter((match) => match.winnerPlayerId === playerId).length;
  const losses = matches.filter((match) =>
    match.winnerPlayerId !== null && match.winnerPlayerId !== playerId
  ).length;
  const draws = matches.filter((match) => match.winnerPlayerId === null).length;
  const rating = Math.max(800, 1200 + wins * 28 + draws * 6 - losses * 18);
  return {
    seasonRating: rating,
    league: leagueForRating(rating),
    season: currentSeason().name,
    results: { wins, losses, draws },
    winRate: winRate(wins, losses, draws),
  };
}

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
  const oauthStates = new Map<string, {
    provider: OAuthProvider;
    redirectUri: string;
    expiresAt: number;
  }>();
  const oauthTransfers = new Map<string, {
    session: ReturnType<typeof sessionResponse>;
    expiresAt: number;
  }>();
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

  router.get('/v1/auth/providers', (_request: Request, response: Response) => {
    const firebaseProviders = new Set(
      (process.env.FIREBASE_AUTH_PROVIDERS ?? 'email,google,facebook,github')
        .split(',')
        .map((provider) => provider.trim().toLowerCase()),
    );
    const firebase = Boolean(runtime.firebaseAuth);
    response.json({
      providers: {
        firebase,
        email: firebase
          ? firebaseProviders.has('email')
          : Boolean(runtime.store?.createEmailAccount && runtime.store.findEmailAccount),
        google: firebase ? firebaseProviders.has('google') : oauthAvailable('google'),
        facebook: firebase ? firebaseProviders.has('facebook') : oauthAvailable('facebook'),
        github: firebase ? firebaseProviders.has('github') : oauthAvailable('github'),
      },
    });
  });

  router.post(
    '/v1/auth/firebase/exchange',
    rateLimit(15 * 60 * 1000, 30),
    async (request: Request, response: Response) => {
      if (!runtime.store?.upsertOAuthAccount || !runtime.tokens || !runtime.firebaseAuth) {
        response.status(503).json({ error: 'FIREBASE_AUTH_NOT_CONFIGURED' });
        return;
      }
      const parsed = FirebaseExchangeSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'INVALID_REQUEST' });
        return;
      }
      try {
        const identity = await runtime.firebaseAuth.verify(parsed.data.idToken);
        const playerId = randomUUID();
        const issued = runtime.tokens.issue(playerId);
        const displayName = (
          identity.displayName
          ?? parsed.data.displayName
          ?? identity.email?.split('@')[0]
          ?? 'Duelcade Player'
        ).trim().slice(0, 24) || 'Duelcade Player';
        const player = await runtime.store.upsertOAuthAccount({
          playerId,
          displayName,
          provider: 'firebase',
          providerSubject: identity.uid,
          email: identity.emailVerified ? identity.email : null,
          passwordHash: null,
          sessionId: issued.sessionId,
          refreshTokenHash: issued.refreshTokenHash,
          refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
        });
        const finalIssued = player.id === playerId
          ? issued
          : { ...issued, ...runtime.tokens.issueAccess(player.id, issued.sessionId) };
        response.json(sessionResponse(player, finalIssued));
      } catch (error) {
        console.warn('[firebase-auth] ID token verification failed', {
          error: error instanceof Error ? error.message : 'unknown',
        });
        response.status(401).json({ error: 'INVALID_FIREBASE_TOKEN' });
      }
    },
  );

  router.post(
    '/v1/auth/email/register',
    rateLimit(60 * 60 * 1000, 10),
    async (request: Request, response: Response) => {
      if (!runtime.store?.createEmailAccount || !runtime.tokens) {
        sendUnavailable(response);
        return;
      }
      const parsed = EmailRegisterSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'INVALID_REQUEST' });
        return;
      }
      const playerId = randomUUID();
      const issued = runtime.tokens.issue(playerId);
      const player = await runtime.store.createEmailAccount({
        playerId,
        displayName: parsed.data.displayName,
        provider: 'email',
        providerSubject: parsed.data.email,
        email: parsed.data.email,
        passwordHash: await hashPassword(parsed.data.password),
        sessionId: issued.sessionId,
        refreshTokenHash: issued.refreshTokenHash,
        refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
      });
      if (!player) {
        response.status(409).json({ error: 'EMAIL_ALREADY_REGISTERED' });
        return;
      }
      response.status(201).json(sessionResponse(player, issued));
    },
  );

  router.post(
    '/v1/auth/email/login',
    rateLimit(15 * 60 * 1000, 20),
    async (request: Request, response: Response) => {
      if (!runtime.store?.findEmailAccount || !runtime.store.createSessionForPlayer || !runtime.tokens) {
        sendUnavailable(response);
        return;
      }
      const parsed = EmailLoginSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'INVALID_REQUEST' });
        return;
      }
      const credential = await runtime.store.findEmailAccount(parsed.data.email);
      if (!credential || !await verifyPassword(parsed.data.password, credential.passwordHash)) {
        response.status(401).json({ error: 'INVALID_EMAIL_OR_PASSWORD' });
        return;
      }
      const issued = runtime.tokens.issue(credential.player.id);
      const player = await runtime.store.createSessionForPlayer({
        playerId: credential.player.id,
        sessionId: issued.sessionId,
        refreshTokenHash: issued.refreshTokenHash,
        refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
      });
      if (!player) {
        response.status(401).json({ error: 'INVALID_EMAIL_OR_PASSWORD' });
        return;
      }
      response.json(sessionResponse(player, issued));
    },
  );

  router.get('/v1/auth/oauth/:provider/start', (request: Request, response: Response) => {
    const provider = OAuthProviderSchema.safeParse(request.params.provider);
    const query = OAuthStartSchema.safeParse(request.query);
    if (!provider.success || !query.success || !safeAppRedirect(query.data.redirectUri, allowedOrigins)) {
      response.status(400).json({ error: 'INVALID_OAUTH_REQUEST' });
      return;
    }
    const state = randomOAuthCode();
    const callbackUrl = `${publicBaseUrl(request)}/v1/auth/oauth/${provider.data}/callback`;
    const authorizationUrl = oauthAuthorizationUrl(provider.data, callbackUrl, state);
    if (!authorizationUrl) {
      response.status(503).json({ error: 'OAUTH_PROVIDER_NOT_CONFIGURED' });
      return;
    }
    oauthStates.set(state, {
      provider: provider.data,
      redirectUri: query.data.redirectUri,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    response.redirect(302, authorizationUrl);
  });

  router.get('/v1/auth/oauth/:provider/callback', async (request: Request, response: Response) => {
    const provider = OAuthProviderSchema.safeParse(request.params.provider);
    const code = typeof request.query.code === 'string' ? request.query.code : null;
    const stateKey = typeof request.query.state === 'string' ? request.query.state : '';
    const state = oauthStates.get(stateKey);
    oauthStates.delete(stateKey);
    if (!provider.success || !state || state.provider !== provider.data || state.expiresAt <= Date.now()) {
      response.status(400).send('OAuth request expired or invalid. Return to Duelcade and try again.');
      return;
    }
    if (!code || !runtime.store?.upsertOAuthAccount || !runtime.tokens) {
      const redirect = new URL(state.redirectUri);
      redirect.searchParams.set('error', typeof request.query.error === 'string'
        ? request.query.error.slice(0, 80)
        : 'OAUTH_FAILED');
      response.redirect(302, redirect.toString());
      return;
    }
    try {
      const profile = await exchangeOAuthCode(
        provider.data,
        code,
        `${publicBaseUrl(request)}/v1/auth/oauth/${provider.data}/callback`,
      );
      const playerId = randomUUID();
      const issued = runtime.tokens.issue(playerId);
      const player = await runtime.store.upsertOAuthAccount({
        playerId,
        displayName: profile.displayName.trim().slice(0, 24) || 'Duelcade Player',
        provider: profile.provider,
        providerSubject: profile.subject,
        email: profile.email,
        passwordHash: null,
        sessionId: issued.sessionId,
        refreshTokenHash: issued.refreshTokenHash,
        refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
      });
      // An existing identity keeps its original player id, so issue the access
      // token again for that authoritative id while preserving the stored session.
      const finalIssued = player.id === playerId
        ? issued
        : { ...issued, ...runtime.tokens.issueAccess(player.id, issued.sessionId) };
      const transferCode = randomOAuthCode();
      oauthTransfers.set(transferCode, {
        session: sessionResponse(player, finalIssued),
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      const redirect = new URL(state.redirectUri);
      redirect.searchParams.set('code', transferCode);
      response.redirect(302, redirect.toString());
    } catch (error) {
      console.error('[oauth] Callback failed', { provider: provider.data, error });
      const redirect = new URL(state.redirectUri);
      redirect.searchParams.set('error', 'OAUTH_FAILED');
      response.redirect(302, redirect.toString());
    }
  });

  router.post('/v1/auth/oauth/exchange', async (request: Request, response: Response) => {
    const parsed = OAuthExchangeSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    const transfer = oauthTransfers.get(parsed.data.code);
    oauthTransfers.delete(parsed.data.code);
    if (!transfer || transfer.expiresAt <= Date.now()) {
      response.status(401).json({ error: 'INVALID_OAUTH_CODE' });
      return;
    }
    response.json(transfer.session);
  });

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

  router.get('/v1/profile', async (request: Request, response: Response) => {
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
    const matches = await runtime.store.listMatches(playerId, 50);
    const entries = await runtime.store.listLeaderboard?.(100) ?? [];
    const ownEntry = entries.find((entry) => entry.playerId === playerId);
    response.json({
      player,
      leaderboard: ownEntry ? {
        globalRank: ownEntry.rank,
        totalScore: ownEntry.totalScore,
        wins: ownEntry.wins,
        losses: ownEntry.losses,
        winRate: ownEntry.winRate,
      } : summarizeLeaderboard(playerId, matches),
      competitive: summarizeCompetitive(playerId, matches),
      season: currentSeason(),
    });
  });

  router.patch('/v1/profile', async (request: Request, response: Response) => {
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

  router.get('/v1/leaderboard', async (request: Request, response: Response) => {
    if (!runtime.store) {
      sendUnavailable(response);
      return;
    }
    const playerId = requirePlayer(runtime, request, response);
    if (!playerId) return;
    const entries = await runtime.store.listLeaderboard?.(100) ?? [];
    const ownEntry = entries.find((entry) => entry.playerId === playerId);
    const matches = ownEntry ? [] : await runtime.store.listMatches(playerId, 50);
    response.json({
      leaderboard: ownEntry ? {
        globalRank: ownEntry.rank,
        totalScore: ownEntry.totalScore,
        wins: ownEntry.wins,
        losses: ownEntry.losses,
        winRate: ownEntry.winRate,
      } : summarizeLeaderboard(playerId, matches),
      entries,
    });
  });

  router.get('/v1/competitive', async (request: Request, response: Response) => {
    if (!runtime.store) {
      sendUnavailable(response);
      return;
    }
    const playerId = requirePlayer(runtime, request, response);
    if (!playerId) return;
    const matches = await runtime.store.listMatches(playerId, 50);
    response.json({ competitive: summarizeCompetitive(playerId, matches) });
  });

  router.get('/v1/season', (request: Request, response: Response) => {
    const playerId = requirePlayer(runtime, request, response);
    if (!playerId) return;
    response.json({ season: currentSeason() });
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

  router.post(
    '/v1/feedback',
    rateLimit(60 * 60 * 1000, 20),
    async (request: Request, response: Response) => {
      if (!runtime.store) {
        sendUnavailable(response);
        return;
      }
      const playerId = requirePlayer(runtime, request, response);
      if (!playerId) return;
      const parsed = FeedbackSubmissionSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'INVALID_FEEDBACK' });
        return;
      }
      const accepted = await runtime.store.recordFeedback(
        playerId,
        parsed.data,
      );
      response.status(202).json({ id: parsed.data.id, accepted });
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
