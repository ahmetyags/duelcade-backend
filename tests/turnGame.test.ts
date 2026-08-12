import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TURN_GAME_MODES,
  advanceTurnRound,
  applyTurnMove,
  createTurnMatchSession,
  createTurnMatchSessionFromOrder,
  createTurnModeOrder,
  encodeCipherGuess,
  findWinningLineCells,
  legalTurnMoves,
  normalizeMatchDurationMinutes,
  resolveMemoryTurn,
  resonanceFrequency,
  roundCountForDuration,
  skipTurnRound,
} from '../engine/TurnGameEngine';
import type { Difficulty } from '../types/game';
import type { TurnGameMode, TurnMatchSession } from '../types/turnGame';

function sessionForMode(
  mode: TurnGameMode,
  difficulty: Difficulty = 'easy',
): TurnMatchSession {
  return createTurnMatchSession(
    `mode-${mode}-${difficulty}`,
    ['a', 'b'],
    1,
    difficulty,
    5 * 60 * 1000,
    [mode],
  );
}

test('free duration slider values are normalized and scale the round count', () => {
  assert.equal(normalizeMatchDurationMinutes(1), 2);
  assert.equal(normalizeMatchDurationMinutes(3.6), 4);
  assert.equal(normalizeMatchDurationMinutes(20), 20);
  assert.equal(normalizeMatchDurationMinutes(25), 20);
  assert.equal(normalizeMatchDurationMinutes(Number.NaN), 3);
  assert.equal(roundCountForDuration(2), 3);
  assert.equal(roundCountForDuration(20), 20);
});

test('rune grid rejects duplicate/out-of-turn moves and detects a win', () => {
  const session = createTurnMatchSession('rune-test', ['a', 'b'], 3);
  session.state.mode = 'rune_grid';
  session.state.cells = Array(9).fill(null);
  session.state.boardRows = 3;
  session.state.boardColumns = 3;
  session.state.winLength = 3;
  assert.equal(applyTurnMove(session, 'b', 0, 0).reason, 'not_your_turn');
  assert.equal(applyTurnMove(session, 'a', 0, 0).accepted, true);
  assert.equal(applyTurnMove(session, 'a', 1, 1).reason, 'not_your_turn');
  assert.equal(applyTurnMove(session, 'b', 3, 1).accepted, true);
  assert.equal(applyTurnMove(session, 'a', 1, 2).accepted, true);
  assert.equal(applyTurnMove(session, 'b', 4, 3).accepted, true);
  const winning = applyTurnMove(session, 'a', 2, 4);
  assert.equal(winning.roundEnded, true);
  assert.equal(session.state.winnerIndex, 0);
  assert.deepEqual(session.state.scores, [1, 0]);
  assert.deepEqual(findWinningLineCells(session.state, 0), [0, 1, 2]);
});

test('round order is seeded, shuffled and preserves match score', () => {
  const session = createTurnMatchSession('rotation-test', ['a', 'b'], 5);
  const sameSeed = createTurnMatchSession('rotation-test', ['a', 'b'], 5);
  assert.deepEqual(session.modeOrder, sameSeed.modeOrder);
  assert.equal(TURN_GAME_MODES.length, 10);
  assert.equal(session.modeOrder.every((mode) => TURN_GAME_MODES.includes(mode)), true);
  assert.equal(new Set(session.modeOrder).size, session.modeOrder.length);
  session.state.status = 'round_complete';
  session.state.scores = [1, 0];
  assert.equal(advanceTurnRound(session), true);
  assert.equal(session.state.mode, session.modeOrder[1]);
  assert.equal(session.state.activePlayerIndex, 1);
  assert.deepEqual(session.state.scores, [1, 0]);
});

test('room mode orders use all ten games without replacement and stay immutable', () => {
  const first = createTurnModeOrder('room-alpha', 10);
  const sameRoom = createTurnModeOrder('room-alpha', 10);
  const nextRoom = createTurnModeOrder('room-bravo', 10);

  assert.deepEqual(new Set(first), new Set(TURN_GAME_MODES));
  assert.equal(new Set(first).size, 10);
  assert.deepEqual(first, sameRoom);
  assert.notDeepEqual(first, nextRoom);

  const session = createTurnMatchSessionFromOrder(
    'room-alpha',
    ['a', 'b'],
    first.slice(0, 5),
  );
  assert.deepEqual(session.modeOrder, first.slice(0, 5));
  first.reverse();
  assert.notDeepEqual(session.modeOrder, first.slice(0, 5));
});

test('difficulty changes boards without changing the requested game count', () => {
  for (const difficulty of ['easy', 'medium', 'hard', 'final'] as const) {
    const session = createTurnMatchSession(`count-${difficulty}`, ['a', 'b'], 5, difficulty);
    assert.equal(session.state.totalRounds, 5);
    assert.equal(session.modeOrder.length, 5);
    assert.equal(new Set(session.modeOrder).size, 5);
  }
});

test('hard difficulty scales compact games to roughly thirty cells', () => {
  const session = createTurnMatchSession('hard-scale', ['a', 'b'], 10, 'hard');
  for (let index = 0; index < session.modeOrder.length; index += 1) {
    if (session.state.mode === 'rune_grid' || session.state.mode === 'memory_pairs') {
      assert.equal(session.state.cells.length, 30);
    }
    if (index === session.modeOrder.length - 1) break;
    session.state.status = 'round_complete';
    advanceTurnRound(session);
  }
});

test('the player completing the old pipe puzzle wins the round', () => {
  const session = createTurnMatchSession('pipe-test', ['a', 'b'], 5);
  session.state.mode = 'pipe_circuit';
  session.state.activePlayerIndex = 0;
  session.solution = [0, 0, 1, 0, 0, 2, 3, 0, 0];
  session.state.cells = [...session.solution];
  session.state.cells[4] = 3;
  const result = applyTurnMove(session, 'a', 4, 0);
  assert.equal(result.roundEnded, true);
  assert.equal(session.state.winnerIndex, 0);
  assert.equal(session.state.cellOwners[4], 0);
});

test('all arrow pipe tiles use four visually distinct directions', () => {
  const session = sessionForMode('pipe_circuit', 'hard');
  session.state.tileKinds?.forEach((_, index) => {
    assert.ok((session.solution[index] ?? 0) < 4);
    assert.ok((session.state.cells[index] ?? 0) < 4);
    assert.notEqual(session.solution[index], session.state.cells[index]);
  });

  session.state.activePlayerIndex = 0;
  session.state.cells = [3];
  session.state.cellOwners = [null];
  session.state.tileKinds = ['straight'];
  session.state.targets = [0];
  session.solution = [0];
  const result = applyTurnMove(session, 'a', 0, session.state.moveNumber);
  assert.equal(result.roundEnded, true);
  assert.equal(session.state.cells[0], 0);
});

test('resonance dials rotate both ways and award the finishing move', () => {
  const session = createTurnMatchSession('resonance-test', ['a', 'b'], 5);
  session.state.mode = 'resonance_dials';
  session.state.activePlayerIndex = 0;
  session.solution = [2, 1, 4, 0];
  session.state.targets = [...session.solution];
  session.state.cells = [1, 1, 4, 0];
  const result = applyTurnMove(session, 'a', 1, 0);
  assert.equal(result.roundEnded, true);
  assert.equal(session.state.cells[0], 2);
  assert.equal(session.state.winnerIndex, 0);
  assert.equal(session.state.cellOwners[0], 0);
});

test('every resonance target is reachable, labelled and locks exactly once', () => {
  for (const difficulty of ['easy', 'medium', 'hard', 'final'] as const) {
    const session = sessionForMode('resonance_dials', difficulty);
    assert.equal(session.state.targets?.length, session.state.cells.length);
    session.state.cells.forEach((value, dial) => {
      assert.notEqual(value, session.solution[dial]);
      assert.ok(resonanceFrequency(dial, value) >= 120);
    });

    session.state.cells.forEach((_, dial) => {
      let attempts = 0;
      while (session.state.cells[dial] !== session.solution[dial]) {
        const player = session.state.playerIds[session.state.activePlayerIndex];
        const result = applyTurnMove(
          session,
          player,
          dial * 2 + 1,
          session.state.moveNumber,
        );
        assert.equal(result.accepted, true);
        attempts += 1;
        assert.ok(attempts <= 4);
      }
      assert.notEqual(session.state.cellOwners[dial], null);
    });

    assert.equal(session.state.status, 'round_complete');
  }
});

test('a memory pair keeps the color of the player who found it', () => {
  const session = createTurnMatchSession('memory-owner', ['a', 'b'], 3);
  session.state.mode = 'memory_pairs';
  session.state.cells = Array(12).fill(null);
  session.state.cellOwners = Array(12).fill(null);
  session.memoryDeck = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
  applyTurnMove(session, 'a', 0, 0);
  applyTurnMove(session, 'a', 1, 1);
  assert.equal(session.state.cellOwners[0], 0);
  assert.equal(session.state.cellOwners[1], 0);
});

test('memory mismatch is hidden before the turn changes', () => {
  const session = createTurnMatchSession('memory-test', ['a', 'b'], 3);
  session.state.roundIndex = 2;
  session.state.mode = 'memory_pairs';
  session.state.cells = Array(16).fill(null);
  session.memoryDeck = [0, 1, 0, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7];
  applyTurnMove(session, 'a', 0, 0);
  const mismatch = applyTurnMove(session, 'a', 1, 1);
  assert.equal(mismatch.needsResolve, true);
  assert.equal(session.state.status, 'resolving');
  resolveMemoryTurn(session);
  assert.equal(session.state.status, 'playing');
  assert.equal(session.state.activePlayerIndex, 1);
  assert.equal(session.state.cells[0], null);
  assert.equal(session.state.cells[1], null);
});

test('cipher clash keeps secrets server-side and awards an exact code', () => {
  const session = sessionForMode('cipher_clash', 'hard');
  const player = session.state.activePlayerIndex;
  const secret = session.cipherSolutions[player];
  assert.deepEqual(session.cipherSolutions[0], session.cipherSolutions[1]);
  assert.notStrictEqual(session.cipherSolutions[0], session.cipherSolutions[1]);
  assert.equal('cipherSolutions' in session.state, false);
  const result = applyTurnMove(
    session,
    session.state.playerIds[player],
    encodeCipherGuess(secret, session.state.cipherSymbolCount!),
    session.state.moveNumber,
  );
  assert.equal(result.roundEnded, true);
  assert.equal(session.state.winnerIndex, player);
  assert.deepEqual(session.state.cipherHistory?.at(-1), {
    playerIndex: player,
    guess: secret,
    exact: secret.length,
    misplaced: 0,
    exactPositions: Array.from({ length: secret.length }, (_, index) => index),
  });
});

test('a mutually skipped round advances without awarding a score', () => {
  const session = createTurnMatchSession('skip-round', ['a', 'b'], 3);
  const firstRound = session.state.roundId;
  session.state.skipVotes = [true, true];
  assert.equal(skipTurnRound(session), true);
  assert.notEqual(session.state.roundId, firstRound);
  assert.deepEqual(session.state.scores, [0, 0]);
  assert.deepEqual(session.state.skipVotes, [false, false]);
});

test('circuit claim captures completed cells and grants the scoring player another move', () => {
  const session = sessionForMode('circuit_claim');
  const player = session.state.activePlayerIndex;
  session.state.cells = session.state.cells.map(() => 0);
  session.state.cells[0] = null;
  session.state.cellOwners = session.state.cellOwners.map(() => null);
  const result = applyTurnMove(
    session,
    session.state.playerIds[player],
    0,
    session.state.moveNumber,
  );
  assert.equal(result.roundEnded, true);
  assert.equal(session.state.winnerIndex, player);
  assert.equal(session.state.roundPoints[player], session.state.cellOwners.length);
});

test('neon trail ends when the next player has no free neighboring cell', () => {
  const session = sessionForMode('neon_trail');
  session.state.boardRows = 3;
  session.state.boardColumns = 3;
  session.state.activePlayerIndex = 0;
  session.state.playerPositions = [0, 8];
  session.state.cells = [0, null, 0, 0, 0, 0, 0, 0, 1];
  session.state.cellOwners = Array(9).fill(null);
  const result = applyTurnMove(session, 'a', 1, session.state.moveNumber);
  assert.equal(result.roundEnded, true);
  assert.equal(session.state.winnerIndex, 0);
});

test('gateway race reaches the opposite gate and never permits a total blockade', () => {
  const session = sessionForMode('gateway_race');
  session.state.boardRows = 3;
  session.state.boardColumns = 3;
  session.state.activePlayerIndex = 0;
  session.state.playerPositions = [3, 8];
  session.state.cells = Array(9).fill(null);
  session.state.cellOwners = Array(9).fill(null);
  session.state.wallsRemaining = [2, 2];
  const win = applyTurnMove(session, 'a', 0, session.state.moveNumber);
  assert.equal(win.roundEnded, true);
  assert.equal(session.state.winnerIndex, 0);

  const blocked = sessionForMode('gateway_race');
  blocked.state.boardRows = 3;
  blocked.state.boardColumns = 3;
  blocked.state.activePlayerIndex = 0;
  blocked.state.playerPositions = [7, 1];
  blocked.state.cells = [2, null, 2, 2, null, 2, null, null, null];
  blocked.state.cellOwners = Array(9).fill(null);
  blocked.state.wallsRemaining = [2, 2];
  const rejected = applyTurnMove(blocked, 'a', 9 + 4, blocked.state.moveNumber);
  assert.equal(rejected.accepted, false);
  assert.equal(blocked.state.cells[4], null);
});

test('polarity war only allows enclosing moves and flips the captured line', () => {
  const session = sessionForMode('polarity_war');
  session.state.activePlayerIndex = 0;
  const legal = legalTurnMoves(session, 0);
  assert.ok(legal.length > 0);
  const move = legal[0];
  const before = session.state.cells.filter((cell) => cell === 0).length;
  const result = applyTurnMove(session, 'a', move, session.state.moveNumber);
  assert.equal(result.accepted, true);
  assert.ok(session.state.cells.filter((cell) => cell === 0).length > before);
  assert.equal(applyTurnMove(session, 'a', move, session.state.moveNumber).accepted, false);
});
