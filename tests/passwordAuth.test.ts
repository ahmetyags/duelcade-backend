import assert from 'node:assert/strict';
import test from 'node:test';

import { hashPassword, verifyPassword } from '../server/auth/Password';

test('email passwords are salted and verified without storing plaintext', async () => {
  const first = await hashPassword('correct horse battery staple');
  const second = await hashPassword('correct horse battery staple');
  assert.notEqual(first, second);
  assert.equal(first.includes('correct horse'), false);
  assert.equal(await verifyPassword('correct horse battery staple', first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
  assert.equal(await verifyPassword('anything', 'malformed'), false);
});
