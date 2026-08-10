import { randomBytes } from 'node:crypto';

import type { AccountProvider } from '../persistence/types';

export type OAuthProvider = Exclude<AccountProvider, 'email'>;

export interface OAuthProfile {
  provider: OAuthProvider;
  subject: string;
  email: string | null;
  displayName: string;
}

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
}

function envKey(provider: OAuthProvider, suffix: 'CLIENT_ID' | 'CLIENT_SECRET'): string {
  return `${provider.toUpperCase()}_${suffix}`;
}

function providerConfig(provider: OAuthProvider): ProviderConfig | null {
  const clientId = process.env[envKey(provider, 'CLIENT_ID')]?.trim();
  const clientSecret = process.env[envKey(provider, 'CLIENT_SECRET')]?.trim();
  if (!clientId || !clientSecret) return null;
  if (provider === 'google') return {
    clientId, clientSecret,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: 'openid email profile',
  };
  if (provider === 'facebook') return {
    clientId, clientSecret,
    authorizeUrl: 'https://www.facebook.com/v23.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v23.0/oauth/access_token',
    scopes: 'public_profile,email',
  };
  return {
    clientId, clientSecret,
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: 'read:user user:email',
  };
}

export function oauthAvailable(provider: OAuthProvider): boolean {
  return providerConfig(provider) !== null;
}

export function oauthAuthorizationUrl(
  provider: OAuthProvider,
  callbackUrl: string,
  state: string,
): string | null {
  const config = providerConfig(provider);
  if (!config) return null;
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('state', state);
  if (provider === 'google') {
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
  }
  return url.toString();
}

async function jsonRequest<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Duelcade-Auth',
    },
  });
  if (!response.ok) throw new Error(`OAUTH_PROFILE_${response.status}`);
  return response.json() as Promise<T>;
}

export async function exchangeOAuthCode(
  provider: OAuthProvider,
  code: string,
  callbackUrl: string,
): Promise<OAuthProfile> {
  const config = providerConfig(provider);
  if (!config) throw new Error('OAUTH_NOT_CONFIGURED');
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: callbackUrl,
    grant_type: 'authorization_code',
  });
  const tokenResponse = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const token = await tokenResponse.json() as { access_token?: string; error?: string };
  if (!tokenResponse.ok || !token.access_token) throw new Error(token.error ?? 'OAUTH_TOKEN_FAILED');

  if (provider === 'google') {
    const user = await jsonRequest<{ sub: string; email?: string; email_verified?: boolean; name?: string }>(
      'https://openidconnect.googleapis.com/v1/userinfo', token.access_token,
    );
    return {
      provider,
      subject: user.sub,
      email: user.email_verified ? user.email ?? null : null,
      displayName: user.name ?? 'Google Player',
    };
  }
  if (provider === 'facebook') {
    const user = await jsonRequest<{ id: string; email?: string; name?: string }>(
      'https://graph.facebook.com/v23.0/me?fields=id,name,email', token.access_token,
    );
    return {
      provider, subject: user.id, email: user.email ?? null,
      displayName: user.name ?? 'Facebook Player',
    };
  }
  const user = await jsonRequest<{ id: number; email?: string; name?: string; login: string }>(
    'https://api.github.com/user', token.access_token,
  );
  let email = user.email ?? null;
  if (!email) {
    const emails = await jsonRequest<{ email: string; primary: boolean; verified: boolean }[]>(
      'https://api.github.com/user/emails', token.access_token,
    ).catch(() => []);
    email = emails.find((item) => item.primary && item.verified)?.email ?? null;
  }
  return { provider, subject: String(user.id), email, displayName: user.name ?? user.login };
}

export function randomOAuthCode(): string {
  return randomBytes(32).toString('base64url');
}
