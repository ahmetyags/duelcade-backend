import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterPuzzleForClient,
  generateLevel,
  validatePuzzleAction,
} from '../engine/PuzzleRegistry';
import {
  generateColorPathChallenge,
  validateColorPathSubmission,
} from '../engine/ColorPathPuzzle';

test('all selectable difficulties generate at least three asymmetric puzzles', () => {
  const expectedCounts = { easy: 3, medium: 4, hard: 5 } as const;
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    const level = generateLevel(`test_seed_${difficulty}`, difficulty);
    assert.equal(level.puzzles.length, expectedCounts[difficulty]);
    assert.equal(level.puzzleOrder.length, level.puzzles.length);
  }
});

test('host-selected adventure length is honored and repeated mechanics get unique instances', () => {
  for (const puzzleCount of [3, 5, 7, 10]) {
    const level = generateLevel(`selected_count_${puzzleCount}`, 'easy', puzzleCount);
    assert.equal(level.puzzles.length, puzzleCount);
    assert.equal(new Set(level.puzzleOrder).size, puzzleCount);
    for (let index = 1; index < level.puzzles.length; index++) {
      assert.notEqual(level.puzzles[index].templateId, level.puzzles[index - 1].templateId);
    }
  }
});

test('difficulty increases puzzle complexity instead of only changing the label', () => {
  const easy = generateLevel('difficulty_easy', 'easy', 7).puzzles;
  const hard = generateLevel('difficulty_hard', 'hard', 10).puzzles;
  const easyCode = easy.find((puzzle) => puzzle.category === 'code');
  const hardCode = hard.find((puzzle) => puzzle.category === 'code');
  const easySymbols = easy.find((puzzle) => puzzle.category === 'symbol');
  const hardSymbols = hard.find((puzzle) => puzzle.category === 'symbol');

  assert.equal(easyCode?.publicState.maxDigits, 4);
  assert.equal(hardCode?.publicState.maxDigits, 6);
  assert.equal(easySymbols?.publicState.sequenceLength, 4);
  assert.equal(hardSymbols?.publicState.sequenceLength, 6);
  assert.ok((hardCode?.maxAttempts ?? 99) < (easyCode?.maxAttempts ?? 0));
});

test('client puzzle payload never includes the solution', () => {
  const [puzzle] = generateLevel('private_payload_test', 'easy').puzzles;
  const operator = filterPuzzleForClient(puzzle, 'operator');
  const explorer = filterPuzzleForClient(puzzle, 'explorer');

  assert.equal('solution' in operator, false);
  assert.equal('solution' in explorer, false);
  assert.notDeepEqual(operator.privateState, explorer.privateState);
  assert.equal(operator.guideSolved, false);
  assert.equal('correctCode' in operator.privateState, false);
  assert.deepEqual(operator.revealedHints, []);
  puzzle.hintsRevealed = 1;
  const hintedOperator = filterPuzzleForClient(puzzle, 'operator');
  assert.equal(hintedOperator.revealedHints.length, 1);
  assert.equal(hintedOperator.revealedHints[0]?.textKey, puzzle.hints[0]?.textKey);
  assert.equal(hintedOperator.revealedHints[1], undefined);
  puzzle.guideSolved = true;
  const unlockedOperator = filterPuzzleForClient(puzzle, 'operator');
  assert.equal(unlockedOperator.privateState.clueUnlocked, true);
});

test('only Explorer can submit and keypad accepts the UI string format', () => {
  const puzzle = generateLevel('pin_validation_test', 'easy').puzzles.find(
    (item) => item.category === 'code',
  );
  assert.ok(puzzle);

  const code = (puzzle.solution.answer as number[]).join('');
  const operatorResult = validatePuzzleAction(puzzle, { type: 'submit_code', code }, 'operator');
  assert.equal(operatorResult.success, false);
  assert.equal(operatorResult.feedback.messageKey, 'puzzle.role_not_allowed');

  const explorerResult = validatePuzzleAction(puzzle, { type: 'submit_code', code }, 'explorer');
  assert.equal(explorerResult.success, true);
});

test('medium and hard Spirit Locks use a real decoding challenge before revealing clues', () => {
  for (const difficulty of ['medium', 'hard'] as const) {
    const [puzzle] = generateLevel(`rune_lock_${difficulty}`, difficulty).puzzles;
    assert.ok(
      puzzle.guideChallenge?.kind === 'rune_equation' ||
      puzzle.guideChallenge?.kind === 'color_paths',
    );
    if (puzzle.guideChallenge?.kind === 'rune_equation') {
      assert.equal(puzzle.guideChallenge.equations.length, 3);
      assert.equal(puzzle.guideChallenge.options.includes(Number(puzzle.guideChallengeAnswer)), true);
    } else if (puzzle.guideChallenge?.kind === 'color_paths') {
      assert.equal(puzzle.guideChallenge.gridSize, difficulty === 'hard' ? 6 : 5);
      assert.ok(puzzle.guideChallengeSolution);
      assert.equal(
        validateColorPathSubmission(puzzle.guideChallenge, puzzle.guideChallengeSolution),
        true,
      );
    }
    assert.equal(puzzle.guideSolved, false);
  }
});

test('color path boards are procedural, fully covered and reject invalid topology', () => {
  for (let index = 0; index < 20; index += 1) {
    const generated = generateColorPathChallenge(`path_seed_${index}`, 6, 4, 3);
    assert.equal(
      validateColorPathSubmission(generated.challenge, generated.solution),
      true,
    );
    assert.equal(
      new Set(generated.solution.flatMap((path) => path.cells)).size,
      36,
    );

    const broken = generated.solution.map((path) => ({
      ...path,
      cells: [...path.cells],
    }));
    broken[0].cells[1] = broken[1].cells[0];
    assert.equal(validateColorPathSubmission(generated.challenge, broken), false);
  }
});

test('color path server solution is never included in either client payload', () => {
  let puzzle = generateLevel('private_color_path_0', 'hard').puzzles[0];
  for (let seed = 1; puzzle.guideChallenge?.kind !== 'color_paths' && seed < 20; seed += 1) {
    puzzle = generateLevel(`private_color_path_${seed}`, 'hard').puzzles[0];
  }
  assert.equal(puzzle.guideChallenge?.kind, 'color_paths');
  assert.ok(puzzle.guideChallengeSolution);
  assert.equal('guideChallengeSolution' in filterPuzzleForClient(puzzle, 'operator'), false);
  assert.equal('guideChallengeSolution' in filterPuzzleForClient(puzzle, 'explorer'), false);
});

test('arcane pipe flow is procedural, role-separated and server validated', () => {
  const level = generateLevel('pipe_flow_validation', 'hard', 10);
  const puzzle = level.puzzles.find((item) => item.templateId === 'arcane_pipe_flow');
  assert.ok(puzzle);

  const explorerView = filterPuzzleForClient(puzzle, 'explorer');
  const lockedGuideView = filterPuzzleForClient(puzzle, 'operator');
  assert.equal('correctRotations' in explorerView.privateState, false);
  assert.equal('correctRotations' in lockedGuideView.privateState, false);

  puzzle.guideSolved = true;
  const guideView = filterPuzzleForClient(puzzle, 'operator');
  const answer = guideView.privateState.correctRotations as number[];
  assert.equal(answer.length, 9);
  assert.equal(answer.every((rotation) => rotation >= 0 && rotation <= 3), true);

  const wrong = answer.map((rotation, index) => index === 0 ? (rotation + 1) % 4 : rotation);
  const wrongResult = validatePuzzleAction(
    puzzle,
    { type: 'rotate_pipes', rotations: wrong },
    'explorer',
  );
  assert.equal(wrongResult.success, false);

  const correctResult = validatePuzzleAction(
    puzzle,
    { type: 'rotate_pipes', rotations: answer },
    'explorer',
  );
  assert.equal(correctResult.success, true);
  assert.equal(correctResult.newPhase, 'solved');
});

test('resonance defusal varies its dials and only accepts the Guide frequencies', () => {
  const puzzle = generateLevel('frequency_validation', 'hard', 10).puzzles.find(
    (item) => item.templateId === 'resonance_defusal',
  );
  assert.ok(puzzle);
  puzzle.guideSolved = true;
  const guide = filterPuzzleForClient(puzzle, 'operator');
  const explorer = filterPuzzleForClient(puzzle, 'explorer');
  const answer = guide.privateState.targetFrequencies as number[];
  assert.equal(answer.length, 4);
  assert.equal('targetFrequencies' in explorer.privateState, false);

  const wrong = answer.map((value, index) => index === 0 ? value + 1 : value);
  assert.equal(
    validatePuzzleAction(
      puzzle,
      { type: 'tune_frequencies', frequencies: wrong },
      'explorer',
    ).success,
    false,
  );
  assert.equal(
    validatePuzzleAction(
      puzzle,
      { type: 'tune_frequencies', frequencies: answer },
      'explorer',
    ).success,
    true,
  );
});
