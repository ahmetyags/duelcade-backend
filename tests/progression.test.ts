import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COSMETIC_CATALOG,
  levelFromXp,
  levelProgress,
  xpFloorForLevel,
} from '../server/progression';

test('level thresholds grow predictably and report current-level progress', () => {
  assert.equal(xpFloorForLevel(1), 0);
  assert.equal(xpFloorForLevel(2), 100);
  assert.equal(xpFloorForLevel(3), 225);
  assert.equal(levelFromXp(99), 1);
  assert.equal(levelFromXp(100), 2);
  assert.deepEqual(levelProgress(150), {
    level: 2,
    currentLevelXp: 50,
    nextLevelXp: 125,
  });
});

test('cosmetic catalog identifiers are unique inside each cosmetic type', () => {
  const identifiers = COSMETIC_CATALOG.map((item) => `${item.type}:${item.itemId}`);
  assert.equal(new Set(identifiers).size, identifiers.length);
  assert.ok(COSMETIC_CATALOG.every((item) => item.unlockLevel >= 1));
});
