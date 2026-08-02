/**
 * Puzzle template registry and procedural generator.
 *
 * Implements the modular puzzle architecture from the Puzzle System Bible (Bölüm 4).
 * Each puzzle module is registered with a generator and validator function.
 * The procedural generator selects and configures puzzles based on seed and difficulty.
 */

import { SeededRandom } from './SeededRandom';
import { generateColorPathChallenge } from './ColorPathPuzzle';
import type {
  PuzzleTemplate,
  PuzzleTemplateId,
  PuzzleState,
  PuzzleGenerationConfig,
  PuzzleCategory,
  PuzzleAction,
  PuzzleActionResult,
  ClientPuzzleState,
  GuideChallengeState,
} from '@/types/puzzle';
import type { PlayerRole, Difficulty } from '@/types/game';

// ─── Puzzle Template Registry ──────────────────────────────────────

const registry = new Map<PuzzleTemplateId, PuzzleTemplate>();

/** Register a puzzle template in the registry. */
export function registerPuzzleTemplate(template: PuzzleTemplate): void {
  registry.set(template.id, template);
}

/** Get a template by ID. */
export function getTemplate(id: PuzzleTemplateId): PuzzleTemplate | undefined {
  return registry.get(id);
}

/** Get all registered templates. */
export function getAllTemplates(): PuzzleTemplate[] {
  return Array.from(registry.values());
}

/** Get templates suitable for a difficulty level. */
export function getTemplatesForDifficulty(difficulty: Difficulty): PuzzleTemplate[] {
  return getAllTemplates().filter((t) => t.difficultyRange.includes(difficulty));
}

/**
 * Filter a puzzle state for a specific client role.
 * The solution is NEVER included. Only the relevant private state is sent.
 */
export function filterPuzzleForClient(
  state: PuzzleState,
  role: PlayerRole,
): ClientPuzzleState {
  const guideSolved = state.guideSolved ?? false;
  const privateState = role === 'operator'
    ? guideSolved
      ? { ...state.operatorPrivateState, clueUnlocked: true }
      : { clueUnlocked: false }
    : state.explorerPrivateState;

  return {
    puzzleId: state.puzzleId,
    templateId: state.templateId,
    category: state.category,
    phase: state.phase,
    attemptCount: state.attemptCount,
    maxAttempts: state.maxAttempts,
    startedAt: state.startedAt,
    deadlineAt: state.deadlineAt,
    publicState: state.publicState,
    privateState,
    hintsRevealed: state.hintsRevealed,
    availableHints: state.hints.length,
    revealedHints: state.hints.slice(0, state.hintsRevealed),
    guideChallenge: role === 'operator' ? state.guideChallenge ?? null : null,
    guideSolved,
    guideAttemptCount: state.guideAttemptCount ?? 0,
    fieldUnlocked: state.fieldUnlocked ?? false,
  };
}

function createGuideChallenge(seed: string, difficulty: Difficulty): {
  challenge: GuideChallengeState;
  answer: string;
  solution?: import('@/types/puzzle').ColorPathSubmission[];
} {
  const rng = new SeededRandom(`${seed}_guide_challenge`);
  const advanced = difficulty === 'medium' || difficulty === 'hard' || difficulty === 'final';
  const hard = difficulty === 'hard' || difficulty === 'final';
  if (advanced && rng.chance(hard ? 0.72 : 0.6)) {
    const generated = generateColorPathChallenge(
      seed,
      hard ? 6 : 5,
      hard ? 4 : 3,
      hard ? 3 : 4,
    );
    return {
      challenge: generated.challenge,
      answer: '',
      solution: generated.solution,
    };
  }

  if (advanced) {
    const runes = rng.shuffle(['◆', '●', '✦']);
    const values = [
      rng.nextInt(2, 6),
      rng.nextInt(3, 8),
      rng.nextInt(2, 7),
    ];
    const answer = values[0] + values[1] * values[2];
    const options = new Set<number>([answer]);
    while (options.size < 4) {
      const offset = rng.nextInt(2, 10) * (rng.chance(0.5) ? 1 : -1);
      if (answer + offset > 0) options.add(answer + offset);
    }
    return {
      challenge: {
        kind: 'rune_equation',
        equations: [
          { runes: [runes[0], runes[0]], total: values[0] * 2 },
          { runes: [runes[0], runes[1]], total: values[0] + values[1] },
          { runes: [runes[1], runes[2], runes[2]], total: values[1] + values[2] * 2 },
        ],
        question: `${runes[0]} + ${runes[1]} × ${runes[2]}`,
        options: rng.shuffle([...options]),
        maxAttempts: hard ? 2 : 3,
      },
      answer: String(answer),
    };
  }

  let sequence: number[];
  let answer: number;

  const start = rng.nextInt(2, 15);
  const step = rng.nextInt(3, 8);
  sequence = Array.from({ length: 5 }, (_, index) => start + index * step);
  answer = start + 5 * step;

  const distractors = new Set<number>([answer]);
  while (distractors.size < 4) {
    const offset = rng.nextInt(1, 9) * (rng.chance(0.5) ? 1 : -1);
    if (answer + offset > 0) distractors.add(answer + offset);
  }

  return {
    challenge: {
      kind: 'number_sequence',
      sequence,
      options: rng.shuffle([...distractors]),
      maxAttempts: 3,
    },
    answer: String(answer),
  };
}

// ─── Validation Helpers ────────────────────────────────────────────

function createFeedback(
  correct: boolean,
  messageKey: string,
  alarm: boolean = false,
  penalty: number = 0,
): import('@/types/puzzle').PuzzleFeedback {
  return {
    correct,
    messageKey,
    alarmTriggered: alarm,
    timePenaltyMs: penalty,
  };
}

function createActionResult(
  puzzleId: string,
  success: boolean,
  phase: PuzzleState['phase'],
  attemptCount: number,
  maxAttempts: number | null,
  feedback: import('@/types/puzzle').PuzzleFeedback,
  unlocked: string[] = [],
  unlockedDoors: string[] = [],
): PuzzleActionResult {
  return {
    puzzleId,
    success,
    newPhase: phase,
    attemptCount,
    remainingAttempts: maxAttempts !== null ? Math.max(0, maxAttempts - attemptCount) : null,
    feedback,
    updatedPublicState: null,
    updatedPrivateState: null,
    unlockedPuzzleIds: unlocked,
    unlockedDoorIds: unlockedDoors,
  };
}

// ─── Built-in Puzzle Templates ─────────────────────────────────────

/**
 * Puzzle 1: PIN Code (Code category)
 * Operator sees the correct 4-digit code on their monitors.
 * Explorer finds the keypad and must enter the code relayed by Operator.
 */
registerPuzzleTemplate({
  id: 'pin_code_basic',
  category: 'code',
  displayName: 'Access Code',
  description: 'Enter the 4-digit access code to unlock the door.',
  difficultyRange: ['easy', 'medium', 'hard', 'final'],
  maxAttemptsDefault: 5,
  timeLimitMs: null,
  generator: (config: PuzzleGenerationConfig) => {
    const rng = new SeededRandom(config.seed + config.templateId);
    const codeLength = config.difficulty === 'hard' || config.difficulty === 'final'
      ? 6
      : config.difficulty === 'medium'
        ? 5
        : 4;
    const code = Array.from({ length: codeLength }, () => rng.nextInt(0, 9));
    const maxAttempts = config.maxAttempts ?? (config.difficulty === 'easy' ? 5 : config.difficulty === 'medium' ? 4 : 3);

    // Generate a misleading decoy code
    const decoy = code.map((d) => (d + rng.nextInt(1, 5)) % 10);

    return {
      templateId: config.templateId,
      category: 'code',
      phase: 'active',
      attemptCount: 0,
      maxAttempts,
      startedAt: Date.now(),
      deadlineAt: null,
      publicState: {
        keypadLabel: 'SECURITY PANEL',
        maxDigits: codeLength,
      },
      operatorPrivateState: {
        monitorLabel: 'AUTHORIZED CODE',
        correctCode: code.join(''),
        decoyCode: decoy.join(''),
        decoyLabel: 'OUTDATED PROTOCOL',
      },
      explorerPrivateState: {
        keypadInstruction: `Enter ${codeLength}-digit code`,
        nearbyNote: 'The code was updated in the last system log.',
      },
      solution: {
        answer: code,
        validationRule: 'exact_match',
      },
      hints: [
        {
          id: 'hint_1',
          textKey: 'puzzle.pin.hint1',
          revealAfterMs: 300000,
          guidanceLevel: 1,
        },
        {
          id: 'hint_2',
          textKey: 'puzzle.pin.hint2',
          revealAfterMs: 600000,
          guidanceLevel: 2,
        },
      ],
      hintsRevealed: 0,
      hintCooldownMs: 300000,
    };
  },
  validator: (state: PuzzleState, action: PuzzleAction, role: PlayerRole): PuzzleActionResult => {
    if (role !== 'explorer') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.role_not_allowed'),
      );
    }
    if (state.phase !== 'active') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.inactive'),
      );
    }

    if (action.type !== 'submit_code') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.wrong_action'),
      );
    }

    const submitted = Array.isArray(action.code)
      ? action.code.map(String)
      : String(action.code).split('');
    const answer = state.solution.answer as (string | number)[];
    const normalizedAnswer = Array.isArray(answer) ? answer.map(String) : [String(answer)];
    const correct =
      submitted.length === normalizedAnswer.length &&
      submitted.every((value, index) => value === normalizedAnswer[index]);

    const newAttemptCount = state.attemptCount + 1;
    const maxAttempts = state.maxAttempts;

    if (correct) {
      return createActionResult(
        state.puzzleId, true, 'solved', newAttemptCount, maxAttempts,
        createFeedback(true, 'puzzle.code.correct'),
        ['puzzle_color_wires', 'puzzle_symbol_match'],
        ['door_lab_01'],
      );
    }

    const attemptsLeft = maxAttempts !== null ? maxAttempts - newAttemptCount : null;
    const exhausted = attemptsLeft !== null && attemptsLeft <= 0;
    const alarm = newAttemptCount % 3 === 0;

    return createActionResult(
      state.puzzleId, false, exhausted ? 'failed' : 'active', newAttemptCount, maxAttempts,
      createFeedback(false, alarm ? 'puzzle.code.wrong_alarm' : 'puzzle.code.wrong', alarm, alarm ? 30000 : 0),
    );
  },
});

/**
 * Puzzle 2: Cable Connection (Circuit category)
 * Explorer sees red, blue, and yellow cables.
 * Operator sees the correct wiring diagram.
 * Explorer connects cables; Operator confirms correctness.
 */
registerPuzzleTemplate({
  id: 'cable_connection',
  category: 'circuit',
  displayName: 'Cable Matrix',
  description: 'Connect the cables according to the wiring diagram.',
  difficultyRange: ['easy', 'medium', 'hard', 'final'],
  maxAttemptsDefault: 4,
  timeLimitMs: null,
  generator: (config: PuzzleGenerationConfig) => {
    const rng = new SeededRandom(config.seed + config.templateId);
    const cableCount = config.difficulty === 'easy' ? 3 : config.difficulty === 'medium' ? 4 : 5;
    const cableColors = ['red', 'blue', 'yellow', 'green', 'purple'].slice(0, cableCount);
    const terminals = Array.from({ length: cableCount }, (_, index) => `T${index + 1}`);
    const shuffled = rng.shuffle([...terminals]);
    const correctConnections = cableColors.map((color, i) => ({
      from: color,
      to: shuffled[i],
    }));

    // Generate a wrong diagram for the explorer's misleading note
    const wrongShuffled = rng.shuffle([...terminals]);
    const wrongConnections = cableColors.map((color, i) => ({
      from: color,
      to: wrongShuffled[i],
    }));

    return {
      templateId: config.templateId,
      category: 'circuit',
      phase: 'active',
      attemptCount: 0,
      maxAttempts: config.maxAttempts ?? (config.difficulty === 'easy' ? 5 : config.difficulty === 'medium' ? 4 : 3),
      startedAt: Date.now(),
      deadlineAt: null,
      publicState: {
        cables: cableColors,
        terminals: terminals,
        panelLabel: 'POWER DISTRIBUTION',
      },
      operatorPrivateState: {
        diagramTitle: 'CORRECT WIRING SCHEMA',
        correctConnections,
        warning: 'A previous repair used incorrect routing.',
      },
      explorerPrivateState: {
        cablePanelInstruction: 'Connect each cable to a terminal',
        misleadingNote: wrongConnections,
        noteLabel: 'REPAIR LOG (OUTDATED)',
      },
      solution: {
        answer: correctConnections,
        validationRule: 'circuit_topology',
      },
      hints: [
        {
          id: 'hint_1',
          textKey: 'puzzle.cable.hint1',
          revealAfterMs: 300000,
          guidanceLevel: 1,
        },
      ],
      hintsRevealed: 0,
      hintCooldownMs: 300000,
    };
  },
  validator: (state: PuzzleState, action: PuzzleAction, role: PlayerRole): PuzzleActionResult => {
    if (role !== 'explorer') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.role_not_allowed'),
      );
    }
    if (state.phase !== 'active') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.inactive'),
      );
    }

    if (action.type !== 'connect_circuit') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.wrong_action'),
      );
    }

    const submitted = action.connections;
    const answer = state.solution.answer as { from: string; to: string }[];
    const correct = Array.isArray(answer) &&
      submitted.length === answer.length &&
      submitted.every((conn) =>
        answer.some(
          (sc) => sc.from === conn.fromNode && sc.to === conn.toNode,
        ),
      );

    const newAttemptCount = state.attemptCount + 1;
    const maxAttempts = state.maxAttempts;

    if (correct) {
      return createActionResult(
        state.puzzleId, true, 'solved', newAttemptCount, maxAttempts,
        createFeedback(true, 'puzzle.circuit.correct'),
        ['puzzle_timing_valve'],
        ['door_generator_01'],
      );
    }

    const attemptsLeft = maxAttempts !== null ? maxAttempts - newAttemptCount : null;
    const exhausted = attemptsLeft !== null && attemptsLeft <= 0;

    return createActionResult(
      state.puzzleId, false, exhausted ? 'failed' : 'active', newAttemptCount, maxAttempts,
      createFeedback(false, 'puzzle.circuit.wrong', false, 15000),
    );
  },
});

/**
 * Puzzle 3: Symbol Matching (Symbol category)
 * Operator sees the target symbol sequence on monitors.
 * Explorer sees a wall of symbols and must select them in order.
 */
registerPuzzleTemplate({
  id: 'symbol_match',
  category: 'symbol',
  displayName: 'Symbol Sequence',
  description: 'Select symbols in the correct sequence shown on the monitor.',
  difficultyRange: ['easy', 'medium', 'hard', 'final'],
  maxAttemptsDefault: 3,
  timeLimitMs: null,
  generator: (config: PuzzleGenerationConfig) => {
    const rng = new SeededRandom(config.seed + config.templateId);
    const allSymbols = ['triangle', 'circle', 'square', 'diamond', 'hexagon', 'star', 'cross', 'wave'];
    const sequenceLength = config.difficulty === 'easy' ? 4 : config.difficulty === 'medium' ? 5 : 6;
    const availableCount = Math.min(allSymbols.length, sequenceLength + 2);
    const available = rng.pickMany(allSymbols, availableCount);
    const sequence = rng.pickMany(available, sequenceLength);
    const decoySequence = rng.pickMany(available, sequenceLength);

    return {
      templateId: config.templateId,
      category: 'symbol',
      phase: 'active',
      attemptCount: 0,
      maxAttempts: config.maxAttempts ?? (config.difficulty === 'easy' ? 4 : 3),
      startedAt: Date.now(),
      deadlineAt: null,
      publicState: {
        availableSymbols: available,
        panelLabel: 'ANCIENT GLYPH PANEL',
        sequenceLength,
      },
      operatorPrivateState: {
        monitorLabel: 'TARGET SEQUENCE',
        correctSequence: sequence,
        glyphOrigin: 'Recovered from terminal logs.',
      },
      explorerPrivateState: {
        wallInstruction: `Select ${sequenceLength} symbols in order`,
        misleadingGraffiti: decoySequence,
        graffitiLabel: 'SCRATCHED ON WALL',
      },
      solution: {
        answer: sequence,
        validationRule: 'sequence_match',
      },
      hints: [
        {
          id: 'hint_1',
          textKey: 'puzzle.symbol.hint1',
          revealAfterMs: 300000,
          guidanceLevel: 1,
        },
      ],
      hintsRevealed: 0,
      hintCooldownMs: 300000,
    };
  },
  validator: (state: PuzzleState, action: PuzzleAction, role: PlayerRole): PuzzleActionResult => {
    if (role !== 'explorer') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.role_not_allowed'),
      );
    }
    if (state.phase !== 'active') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.inactive'),
      );
    }

    if (action.type !== 'submit_sequence') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.wrong_action'),
      );
    }

    const submitted = action.sequence;
    const answer = state.solution.answer as string[];
    const correct = Array.isArray(answer) &&
      submitted.length === answer.length &&
      submitted.every((s, i) => s === answer[i]);

    const newAttemptCount = state.attemptCount + 1;
    const maxAttempts = state.maxAttempts;

    if (correct) {
      return createActionResult(
        state.puzzleId, true, 'solved', newAttemptCount, maxAttempts,
        createFeedback(true, 'puzzle.symbol.correct'),
        ['final_escape_puzzle'],
        ['door_escape_01'],
      );
    }

    const attemptsLeft = maxAttempts !== null ? maxAttempts - newAttemptCount : null;
    const exhausted = attemptsLeft !== null && attemptsLeft <= 0;
    const alarm = newAttemptCount >= 2;

    return createActionResult(
      state.puzzleId, false, exhausted ? 'failed' : 'active', newAttemptCount, maxAttempts,
      createFeedback(false, alarm ? 'puzzle.symbol.wrong_alarm' : 'puzzle.symbol.wrong', alarm, alarm ? 30000 : 10000),
    );
  },
});

/**
 * Puzzle 4: Route Planning (Map category)
 * Operator sees the safe route; Explorer submits directions on the field panel.
 */
registerPuzzleTemplate({
  id: 'route_planner',
  category: 'map',
  displayName: 'Safe Route',
  description: 'Navigate the secured corridor using the Operator map.',
  difficultyRange: ['medium', 'hard', 'final'],
  maxAttemptsDefault: 3,
  timeLimitMs: null,
  generator: (config: PuzzleGenerationConfig) => {
    const rng = new SeededRandom(config.seed + config.templateId);
    const directions = ['UP', 'RIGHT', 'DOWN', 'LEFT'];
    const routeLength = config.difficulty === 'hard' || config.difficulty === 'final' ? 7 : 6;
    const route = Array.from({ length: routeLength }, () => rng.pick(directions));
    return {
      templateId: config.templateId,
      category: 'map',
      phase: 'active',
      attemptCount: 0,
      maxAttempts: config.maxAttempts ?? 3,
      startedAt: Date.now(),
      deadlineAt: null,
      publicState: {
        panelLabel: 'ROUTE CONSOLE',
        options: directions,
        sequenceLength: routeLength,
      },
      operatorPrivateState: {
        monitorLabel: 'SAFE CORRIDOR ROUTE',
        correctRoute: route,
        warning: 'Any wrong turn triggers a security sweep.',
      },
      explorerPrivateState: {
        instruction: 'Enter the route relayed by the Operator.',
      },
      solution: { answer: route, validationRule: 'sequence_match' },
      hints: [{
        id: 'route_hint_1',
        textKey: 'puzzle.route.hint1',
        revealAfterMs: 300000,
        guidanceLevel: 1,
      }],
      hintsRevealed: 0,
      hintCooldownMs: 300000,
    };
  },
  validator: (state: PuzzleState, action: PuzzleAction, role: PlayerRole): PuzzleActionResult => {
    if (role !== 'explorer') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.role_not_allowed'),
      );
    }
    if (state.phase !== 'active' || action.type !== 'submit_sequence') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, state.phase !== 'active' ? 'puzzle.inactive' : 'puzzle.wrong_action'),
      );
    }
    const answer = state.solution.answer as string[];
    const correct =
      action.sequence.length === answer.length &&
      action.sequence.every((value, index) => value === answer[index]);
    const attemptCount = state.attemptCount + 1;
    const exhausted = state.maxAttempts !== null && attemptCount >= state.maxAttempts;
    return createActionResult(
      state.puzzleId,
      correct,
      correct ? 'solved' : exhausted ? 'failed' : 'active',
      attemptCount,
      state.maxAttempts,
      createFeedback(correct, correct ? 'puzzle.route.correct' : 'puzzle.route.wrong', false, correct ? 0 : 10000),
      correct ? ['puzzle_memory_relay'] : [],
      correct ? ['door_archive_01'] : [],
    );
  },
});

/**
 * Puzzle 5: Memory Relay (Memory category)
 * Operator sees the hidden signal; Explorer replays it on a separate terminal.
 */
registerPuzzleTemplate({
  id: 'memory_relay',
  category: 'memory_sequence',
  displayName: 'Memory Relay',
  description: 'Replay the hidden signal sequence in the correct order.',
  difficultyRange: ['hard', 'final'],
  maxAttemptsDefault: 3,
  timeLimitMs: null,
  generator: (config: PuzzleGenerationConfig) => {
    const rng = new SeededRandom(config.seed + config.templateId);
    const options = ['ALPHA', 'BETA', 'GAMMA', 'DELTA'];
    const sequenceLength = config.difficulty === 'final' ? 9 : 8;
    const sequence = Array.from({ length: sequenceLength }, () => rng.pick(options));
    return {
      templateId: config.templateId,
      category: 'memory_sequence',
      phase: 'active',
      attemptCount: 0,
      maxAttempts: config.maxAttempts ?? 3,
      startedAt: Date.now(),
      deadlineAt: null,
      publicState: {
        panelLabel: 'SIGNAL REPLAY',
        options,
        sequenceLength: sequence.length,
      },
      operatorPrivateState: {
        monitorLabel: 'ENCRYPTED SIGNAL',
        correctSequence: sequence,
        warning: 'Read the signal slowly; repeated nodes are valid.',
      },
      explorerPrivateState: {
        instruction: 'Replay the signal exactly as relayed.',
      },
      solution: { answer: sequence, validationRule: 'memory_replay' },
      hints: [{
        id: 'memory_hint_1',
        textKey: 'puzzle.memory.hint1',
        revealAfterMs: 300000,
        guidanceLevel: 1,
      }],
      hintsRevealed: 0,
      hintCooldownMs: 300000,
    };
  },
  validator: (state: PuzzleState, action: PuzzleAction, role: PlayerRole): PuzzleActionResult => {
    if (role !== 'explorer') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.role_not_allowed'),
      );
    }
    if (state.phase !== 'active' || action.type !== 'memory_replay') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, state.phase !== 'active' ? 'puzzle.inactive' : 'puzzle.wrong_action'),
      );
    }
    const answer = state.solution.answer as string[];
    const correct =
      action.sequence.length === answer.length &&
      action.sequence.every((value, index) => value === answer[index]);
    const attemptCount = state.attemptCount + 1;
    const exhausted = state.maxAttempts !== null && attemptCount >= state.maxAttempts;
    return createActionResult(
      state.puzzleId,
      correct,
      correct ? 'solved' : exhausted ? 'failed' : 'active',
      attemptCount,
      state.maxAttempts,
      createFeedback(correct, correct ? 'puzzle.memory.correct' : 'puzzle.memory.wrong', !correct && exhausted, correct ? 0 : 15000),
      correct ? ['final_escape_puzzle'] : [],
      correct ? ['door_server_01'] : [],
    );
  },
});

/**
 * Puzzle 6: Arcane Pipe Flow (Logic category)
 * The Guide sees the calibrated pipe orientation after solving the Spirit
 * Lock. The Adventurer rotates the physical tiles to reproduce it.
 */
registerPuzzleTemplate({
  id: 'arcane_pipe_flow',
  category: 'logic',
  displayName: 'Arcane Pipe Flow',
  description: 'Rotate every pipe so the magic can flow from entrance to exit.',
  difficultyRange: ['medium', 'hard', 'final'],
  maxAttemptsDefault: 3,
  timeLimitMs: null,
  generator: (config: PuzzleGenerationConfig) => {
    const rng = new SeededRandom(config.seed + config.templateId);
    const horizontalTiles = [
      'straight', 'straight', 'corner',
      'corner', 'straight', 'corner',
      'corner', 'straight', 'straight',
    ];
    const horizontalRotations = [
      0, 0, 1,
      0, 0, 2,
      3, 0, 0,
    ];

    const vertical = rng.chance(0.5);
    const tiles = [...horizontalTiles];
    const correctRotations = [...horizontalRotations];
    if (vertical) {
      horizontalTiles.forEach((tile, oldIndex) => {
        const row = Math.floor(oldIndex / 3);
        const column = oldIndex % 3;
        const newIndex = column * 3 + row;
        tiles[newIndex] = tile;
        correctRotations[newIndex] = (horizontalRotations[oldIndex] + 1) % 4;
      });
    }

    const initialRotations = correctRotations.map((rotation, index) => {
      const turns = rng.nextInt(1, 3);
      return (rotation + turns + index % 2) % 4;
    });

    return {
      templateId: config.templateId,
      category: 'logic',
      phase: 'active',
      attemptCount: 0,
      maxAttempts: config.maxAttempts ?? (config.difficulty === 'medium' ? 4 : 3),
      startedAt: Date.now(),
      deadlineAt: null,
      publicState: {
        panelLabel: 'ARCANE FLOW MATRIX',
        gridSize: 3,
        pipeTiles: tiles,
        initialRotations,
        entrySide: vertical ? 'TOP' : 'LEFT',
        exitSide: vertical ? 'BOTTOM' : 'RIGHT',
      },
      operatorPrivateState: {
        monitorLabel: 'CALIBRATED PIPE SCHEMA',
        correctRotations,
        pipeTiles: tiles,
        entrySide: vertical ? 'TOP' : 'LEFT',
        exitSide: vertical ? 'BOTTOM' : 'RIGHT',
        warning: 'Describe each tile row by row. Every tap turns a tile clockwise.',
      },
      explorerPrivateState: {
        instruction: 'Rotate the nine pipes using the schema relayed by the Spirit Guide.',
      },
      solution: { answer: correctRotations, validationRule: 'custom' },
      hints: [{
        id: 'pipe_hint_1',
        textKey: 'puzzle.pipe.hint1',
        revealAfterMs: 300000,
        guidanceLevel: 1,
      }],
      hintsRevealed: 0,
      hintCooldownMs: 300000,
    };
  },
  validator: (state: PuzzleState, action: PuzzleAction, role: PlayerRole): PuzzleActionResult => {
    if (role !== 'explorer') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.role_not_allowed'),
      );
    }
    if (state.phase !== 'active' || action.type !== 'rotate_pipes') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, state.phase !== 'active' ? 'puzzle.inactive' : 'puzzle.wrong_action'),
      );
    }
    const answer = state.solution.answer as number[];
    const correct =
      action.rotations.length === answer.length &&
      action.rotations.every((value, index) => ((value % 4) + 4) % 4 === answer[index]);
    const attemptCount = state.attemptCount + 1;
    const exhausted = state.maxAttempts !== null && attemptCount >= state.maxAttempts;
    return createActionResult(
      state.puzzleId,
      correct,
      correct ? 'solved' : exhausted ? 'failed' : 'active',
      attemptCount,
      state.maxAttempts,
      createFeedback(
        correct,
        correct ? 'puzzle.pipe.correct' : 'puzzle.pipe.wrong',
        !correct && exhausted,
        correct ? 0 : 15000,
      ),
      correct ? ['puzzle_memory_relay'] : [],
      correct ? ['door_generator_02'] : [],
    );
  },
});

/**
 * Puzzle 7: Resonance Defusal (Timing category)
 * After defusing the Spirit Lock, the Guide receives calibrated frequencies.
 * The Adventurer must tune every physical dial to those values.
 */
registerPuzzleTemplate({
  id: 'resonance_defusal',
  category: 'timing',
  displayName: 'Resonance Defusal',
  description: 'Tune every resonance dial before the enchanted charge overloads.',
  difficultyRange: ['medium', 'hard', 'final'],
  maxAttemptsDefault: 3,
  timeLimitMs: null,
  generator: (config: PuzzleGenerationConfig) => {
    const rng = new SeededRandom(config.seed + config.templateId);
    const dialCount = config.difficulty === 'medium' ? 3 : 4;
    const labels = ['A', 'B', 'C', 'D'].slice(0, dialCount);
    const dialOptions = labels.map((_, index) => {
      const step = rng.pick([20, 25, 30, 40]);
      const base = 120 + index * 170 + rng.nextInt(0, 3) * 10;
      return Array.from({ length: config.difficulty === 'medium' ? 6 : 8 }, (__, option) =>
        base + option * step);
    });
    const targetIndices = dialOptions.map((options) => rng.nextInt(1, options.length - 2));
    const targetFrequencies = dialOptions.map((options, index) => options[targetIndices[index]]);
    const initialIndices = dialOptions.map((options, index) => {
      let candidate = rng.nextInt(0, options.length - 1);
      if (candidate === targetIndices[index]) candidate = (candidate + 1) % options.length;
      return candidate;
    });

    return {
      templateId: config.templateId,
      category: 'timing',
      phase: 'active',
      attemptCount: 0,
      maxAttempts: config.maxAttempts ?? (config.difficulty === 'medium' ? 4 : 3),
      startedAt: Date.now(),
      deadlineAt: null,
      publicState: {
        panelLabel: 'RESONANCE DEFUSAL UNIT',
        labels,
        dialOptions,
        initialIndices,
      },
      operatorPrivateState: {
        monitorLabel: 'SAFE RESONANCE SIGNATURE',
        labels,
        targetFrequencies,
        warning: 'Read every channel and frequency exactly. One wrong dial destabilizes the unit.',
      },
      explorerPrivateState: {
        instruction: 'Tune each channel to the frequencies relayed by the Spirit Guide.',
      },
      solution: { answer: targetFrequencies, validationRule: 'exact_match' },
      hints: [{
        id: 'frequency_hint_1',
        textKey: 'puzzle.frequency.hint1',
        revealAfterMs: 300000,
        guidanceLevel: 1,
      }],
      hintsRevealed: 0,
      hintCooldownMs: 300000,
    };
  },
  validator: (state: PuzzleState, action: PuzzleAction, role: PlayerRole): PuzzleActionResult => {
    if (role !== 'explorer') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, 'puzzle.role_not_allowed'),
      );
    }
    if (state.phase !== 'active' || action.type !== 'tune_frequencies') {
      return createActionResult(
        state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
        createFeedback(false, state.phase !== 'active' ? 'puzzle.inactive' : 'puzzle.wrong_action'),
      );
    }
    const answer = state.solution.answer as number[];
    const correct =
      action.frequencies.length === answer.length &&
      action.frequencies.every((value, index) => value === answer[index]);
    const attemptCount = state.attemptCount + 1;
    const exhausted = state.maxAttempts !== null && attemptCount >= state.maxAttempts;
    return createActionResult(
      state.puzzleId,
      correct,
      correct ? 'solved' : exhausted ? 'failed' : 'active',
      attemptCount,
      state.maxAttempts,
      createFeedback(
        correct,
        correct ? 'puzzle.frequency.correct' : 'puzzle.frequency.wrong',
        !correct && exhausted,
        correct ? 0 : 15000,
      ),
      correct ? ['puzzle_memory_relay'] : [],
      correct ? ['door_generator_02'] : [],
    );
  },
});

// ─── Level Generator ───────────────────────────────────────────────

/**
 * Generate a complete level with rooms and puzzles from a seed.
 * Follows the procedural generation pipeline from Bölüm 4:
 * 1. Create seed → 2. Select room templates → 3. Select puzzle modules →
 * 4. Distribute info across roles → 5. Generate codes →
 * 6. Place misleading hints → 7. Validate solvability → 8. Lock & send.
 */
export function generateLevel(
  seed: string,
  difficulty: Difficulty = 'easy',
  requestedPuzzleCount?: number,
): {
  levelId: string;
  seed: string;
  roomSequence: string[];
  puzzles: PuzzleState[];
  puzzleOrder: string[];
} {
  const rng = new SeededRandom(seed);

  // Select a fresh room order for every seed. Longer games cycle through a
  // reshuffled room pool instead of truncating at the number of templates.
  const roomPool = ['control_room', 'laboratory', 'archive', 'generator_room', 'server_room'];
  const defaultPuzzleCount = difficulty === 'easy' ? 3 : difficulty === 'medium' ? 4 : 5;
  const puzzleCount = Math.max(3, Math.min(10, requestedPuzzleCount ?? defaultPuzzleCount));
  const selectedRooms: string[] = [];
  let roomBag: string[] = [];
  for (let index = 0; index < puzzleCount; index++) {
    if (roomBag.length === 0) roomBag = rng.shuffle([...roomPool]);
    selectedRooms.push(roomBag.shift() ?? roomPool[0]);
  }
  const roomSequence = [...selectedRooms, 'escape_gate'];

  // Shuffle templates for every game. If the player requests more puzzles
  // than there are mechanics, refill and reshuffle the bag; each instance
  // still receives a unique seed and therefore different values/solutions.
  const availableTemplates = getTemplatesForDifficulty(difficulty);

  // Generate puzzle instances
  const puzzles: PuzzleState[] = [];
  let templateBag: PuzzleTemplate[] = [];
  let previousTemplateId: string | null = null;

  for (let i = 0; i < puzzleCount; i++) {
    if (templateBag.length === 0) {
      templateBag = rng.shuffle([...availableTemplates]);
      if (templateBag.length > 1 && templateBag[0].id === previousTemplateId) {
        [templateBag[0], templateBag[1]] = [templateBag[1], templateBag[0]];
      }
    }
    const template = templateBag.shift() ?? availableTemplates[0];
    previousTemplateId = template.id;

    const genConfig: PuzzleGenerationConfig = {
      templateId: template.id,
      category: template.category,
      difficulty,
      seed: `${seed}_puzzle_${i}_${rng.nextInt(1000, 9999)}`,
      roomId: selectedRooms[i] ?? selectedRooms[0],
      roomIndex: i,
      roleDistribution: {
        operatorInfo: ['monitor', 'diagram', 'schema'],
        explorerInfo: ['keypad', 'cables', 'symbols'],
      },
    };

    const generated = template.generator(genConfig);
    const guide = createGuideChallenge(genConfig.seed, difficulty);
    const puzzleState: PuzzleState = {
      ...generated,
      puzzleId: `puzzle_${i}_${template.id}_${seed.substring(0, 8)}`,
      maxAttempts: generated.maxAttempts ?? template.maxAttemptsDefault,
      guideChallenge: guide.challenge,
      guideChallengeAnswer: guide.answer,
      guideChallengeSolution: guide.solution,
      guideSolved: false,
      guideAttemptCount: 0,
      fieldUnlocked: false,
    };
    puzzles.push(puzzleState);
  }

  // Validate: ensure at least 3 puzzles, each requires both roles
  if (puzzles.length < 3) {
    throw new Error('Level generation failed: insufficient puzzles generated');
  }

  const puzzleOrder = puzzles.map((p) => p.puzzleId);

  return {
    levelId: `level_${seed.substring(0, 12)}`,
    seed,
    roomSequence,
    puzzles,
    puzzleOrder,
  };
}

/** Validate a puzzle action against its template. */
export function validatePuzzleAction(
  state: PuzzleState,
  action: PuzzleAction,
  role: PlayerRole,
): PuzzleActionResult {
  const template = getTemplate(state.templateId);
  if (!template) {
    return createActionResult(
      state.puzzleId, false, state.phase, state.attemptCount, state.maxAttempts,
      createFeedback(false, 'puzzle.template_not_found'),
    );
  }
  return template.validator(state, action, role);
}
