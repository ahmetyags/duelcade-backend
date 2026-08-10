import type { AuthContext } from 'colyseus';

import { TokenService } from './auth/Tokens';
import { createFirebaseTokenVerifier, type FirebaseTokenVerifier } from './auth/Firebase';
import { PostgresStore } from './persistence/PostgresStore';
import type { MatchRecord, PersistenceStore } from './persistence/types';
import type { PlayerAvatarId } from '../types/profile';

export interface RoomAuthData {
  playerId: string;
  authenticated: boolean;
  avatarId?: PlayerAvatarId;
}

export interface BackendRuntime {
  readonly store: PersistenceStore | null;
  readonly tokens: TokenService | null;
  readonly allowLegacyPlayerIds: boolean;
  readonly firebaseAuth?: FirebaseTokenVerifier | null;
}

export function createDisabledRuntime(): BackendRuntime {
  return {
    store: null,
    tokens: null,
    allowLegacyPlayerIds: true,
    firebaseAuth: null,
  };
}

export async function createRuntimeFromEnvironment(): Promise<BackendRuntime> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const tokenSecret = process.env.AUTH_TOKEN_SECRET?.trim();
  const allowLegacyPlayerIds = process.env.ALLOW_LEGACY_PLAYER_IDS !== 'false';
  if (!databaseUrl && !tokenSecret) {
    return { ...createDisabledRuntime(), allowLegacyPlayerIds };
  }
  if (!databaseUrl || !tokenSecret) {
    throw new Error('DATABASE_URL and AUTH_TOKEN_SECRET must be configured together');
  }
  const store = new PostgresStore(databaseUrl);
  await store.initialize();
  return {
    store,
    tokens: new TokenService(tokenSecret),
    allowLegacyPlayerIds,
    firebaseAuth: process.env.FIREBASE_PROJECT_ID?.trim()
      ? createFirebaseTokenVerifier(process.env.FIREBASE_PROJECT_ID.trim())
      : null,
  };
}

export function authenticateRoomClient(
  runtime: BackendRuntime,
  context: Pick<AuthContext, 'token'>,
  fallbackPlayerId: string,
): RoomAuthData | false {
  if (context.token && runtime.tokens) {
    const claims = runtime.tokens.verify(context.token);
    if (!claims) return false;
    return { playerId: claims.sub, authenticated: true };
  }
  if (
    !runtime.allowLegacyPlayerIds
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(fallbackPlayerId)
  ) return false;
  return { playerId: fallbackPlayerId, authenticated: false };
}

export async function persistMatch(
  runtime: BackendRuntime,
  record: MatchRecord,
): Promise<void> {
  const store = runtime.store;
  if (!store || record.authenticatedPlayerIds.size === 0) return;
  try {
    await store.recordMatch(record);
  } catch (error) {
    console.error('[persistence] Failed to record match', {
      matchId: record.id,
      error,
    });
  }
}
