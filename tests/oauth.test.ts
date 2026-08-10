import assert from 'node:assert/strict';
import test from 'node:test';

import { oauthAuthorizationUrl } from '../server/auth/OAuth';

test('OAuth authorization URLs keep provider secrets on the backend', () => {
  const previousId = process.env.GITHUB_CLIENT_ID;
  const previousSecret = process.env.GITHUB_CLIENT_SECRET;
  process.env.GITHUB_CLIENT_ID = 'public-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'server-only-secret';
  try {
    const value = oauthAuthorizationUrl(
      'github',
      'https://duelcade-game-server.onrender.com/v1/auth/oauth/github/callback',
      'csrf-state',
    );
    assert.ok(value);
    const url = new URL(value);
    assert.equal(url.searchParams.get('client_id'), 'public-client-id');
    assert.equal(url.searchParams.get('state'), 'csrf-state');
    assert.equal(url.toString().includes('server-only-secret'), false);
  } finally {
    if (previousId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = previousSecret;
  }
});
