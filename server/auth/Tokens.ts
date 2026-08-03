import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

export interface AccessClaims {
  sub: string;
  sid: string;
  iat: number;
  exp: number;
  ver: 1;
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshTokenHash: string;
  sessionId: string;
}

export interface IssuedAccessToken {
  accessToken: string;
  accessTokenExpiresAt: number;
}

export interface IssuedRefreshToken {
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshTokenHash: string;
}

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class TokenService {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) {
      throw new Error('AUTH_TOKEN_SECRET must contain at least 32 bytes');
    }
  }

  issue(playerId: string, sessionId = randomUUID(), now = Date.now()): IssuedTokens {
    return {
      ...this.issueAccess(playerId, sessionId, now),
      ...this.issueRefresh(sessionId, now),
      sessionId,
    };
  }

  issueAccess(playerId: string, sessionId: string, now = Date.now()): IssuedAccessToken {
    const issuedAt = Math.floor(now / 1000);
    const accessTokenExpiresAt = (issuedAt + ACCESS_TOKEN_TTL_SECONDS) * 1000;
    const claims: AccessClaims = {
      sub: playerId,
      sid: sessionId,
      iat: issuedAt,
      exp: Math.floor(accessTokenExpiresAt / 1000),
      ver: 1,
    };
    const payload = encodeJson(claims);
    const signature = this.sign(payload);
    return {
      accessToken: `${payload}.${signature}`,
      accessTokenExpiresAt,
    };
  }

  issueRefresh(sessionId: string, now = Date.now()): IssuedRefreshToken {
    const refreshToken = `${sessionId}.${randomBytes(32).toString('base64url')}`;
    return {
      refreshToken,
      refreshTokenExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      refreshTokenHash: hashRefreshToken(refreshToken),
    };
  }

  refreshSessionId(refreshToken: string): string | null {
    const [sessionId, secret, extra] = refreshToken.split('.');
    if (
      !sessionId
      || !secret
      || extra
      || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId)
      || secret.length < 40
    ) return null;
    return sessionId;
  }

  verify(accessToken: string, now = Date.now()): AccessClaims | null {
    const [payload, providedSignature, extra] = accessToken.split('.');
    if (!payload || !providedSignature || extra) return null;
    const expected = Buffer.from(this.sign(payload), 'base64url');
    const provided = Buffer.from(providedSignature, 'base64url');
    if (
      expected.length !== provided.length
      || !timingSafeEqual(expected, provided)
    ) return null;
    try {
      const claims = decodeJson<AccessClaims>(payload);
      if (
        claims.ver !== 1
        || typeof claims.sub !== 'string'
        || typeof claims.sid !== 'string'
        || !Number.isInteger(claims.iat)
        || !Number.isInteger(claims.exp)
        || claims.exp <= Math.floor(now / 1000)
      ) return null;
      return claims;
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}
