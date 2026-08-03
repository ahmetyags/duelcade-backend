import { SeededRandom } from './SeededRandom';
import type { Difficulty } from '../types/game';
import type {
  TurnGameMode,
  TurnMatchSession,
  TurnMatchState,
  TurnMoveResult,
} from '../types/turnGame';

export const CORE_TURN_GAME_MODES = [
  'rune_grid',
  'memory_pairs',
  'circuit_claim',
  'neon_trail',
] as const satisfies readonly TurnGameMode[];

const MODES: TurnGameMode[] = [...CORE_TURN_GAME_MODES];

interface BoardConfig {
  rows: number;
  columns: number;
  winLength: number;
}

const DIFFICULTY_INDEX: Record<Difficulty, number> = {
  easy: 0,
  medium: 1,
  hard: 2,
  final: 3,
};

export function normalizeMatchDurationMinutes(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.max(2, Math.min(5, Math.round(value)));
}

export function roundCountForDuration(minutes: number): number {
  return Math.max(3, normalizeMatchDurationMinutes(minutes));
}

/** Convert a resonance dial step into the public frequency shown to both players. */
export function resonanceFrequency(dial: number, value: number | null): number {
  return 120 + dial * 35 + (value ?? 0) * 20;
}

function boardConfig(mode: TurnGameMode, difficulty: Difficulty): BoardConfig {
  const level = DIFFICULTY_INDEX[difficulty];
  if (mode === 'rune_grid') {
    return [
      { rows: 3, columns: 3, winLength: 3 },
      { rows: 4, columns: 5, winLength: 4 },
      { rows: 5, columns: 6, winLength: 5 },
      { rows: 6, columns: 7, winLength: 5 },
    ][level];
  }
  if (mode === 'connect_four') {
    return [
      { rows: 5, columns: 6, winLength: 4 },
      { rows: 6, columns: 7, winLength: 4 },
      { rows: 7, columns: 8, winLength: 5 },
      { rows: 8, columns: 9, winLength: 5 },
    ][level];
  }
  if (mode === 'memory_pairs') {
    return [
      { rows: 3, columns: 4, winLength: 0 },
      { rows: 4, columns: 5, winLength: 0 },
      { rows: 5, columns: 6, winLength: 0 },
      { rows: 6, columns: 7, winLength: 0 },
    ][level];
  }
  if (mode === 'pipe_circuit') {
    return [
      { rows: 3, columns: 3, winLength: 0 },
      { rows: 4, columns: 4, winLength: 0 },
      { rows: 5, columns: 5, winLength: 0 },
      { rows: 5, columns: 6, winLength: 0 },
    ][level];
  }
  if (mode === 'cipher_clash') {
    return [
      { rows: 4, columns: 6, winLength: 0 },
      { rows: 5, columns: 7, winLength: 0 },
      { rows: 6, columns: 8, winLength: 0 },
      { rows: 6, columns: 8, winLength: 0 },
    ][level];
  }
  if (mode === 'circuit_claim') {
    return [
      { rows: 2, columns: 3, winLength: 0 },
      { rows: 3, columns: 4, winLength: 0 },
      { rows: 5, columns: 5, winLength: 0 },
      { rows: 5, columns: 6, winLength: 0 },
    ][level];
  }
  if (mode === 'neon_trail') {
    const size = [5, 6, 7, 8][level];
    return { rows: size, columns: size, winLength: 0 };
  }
  if (mode === 'gateway_race') {
    const size = [5, 7, 9, 9][level];
    return { rows: size, columns: size, winLength: 0 };
  }
  if (mode === 'polarity_war') {
    const size = [4, 6, 8, 8][level];
    return { rows: size, columns: size, winLength: 0 };
  }
  const dialCount = [3, 4, 5, 6][level];
  return { rows: dialCount, columns: 1, winLength: 0 };
}

function createModeOrder(
  seed: string,
  totalRounds: number,
  modePool: readonly TurnGameMode[],
): TurnGameMode[] {
  const result: TurnGameMode[] = [];
  let cycle = 0;
  while (result.length < totalRounds) {
    const shuffled = new SeededRandom(`${seed}_mode_cycle_${cycle}`).shuffle([...modePool]);
    if (
      shuffled.length > 1
      && result.length > 0
      && shuffled[0] === result[result.length - 1]
    ) {
      [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
    }
    result.push(...shuffled);
    cycle += 1;
  }
  return result.slice(0, totalRounds);
}

function memoryDeck(seed: string, cellCount: number): number[] {
  const values = Array.from({ length: cellCount / 2 }, (_, index) => index);
  return new SeededRandom(seed).shuffle([...values, ...values]);
}

function cipherCode(
  rng: SeededRandom,
  length: number,
  symbolCount: number,
  allowRepeats: boolean,
): number[] {
  if (allowRepeats) {
    return Array.from({ length }, () => rng.nextInt(0, symbolCount - 1));
  }
  return rng.shuffle(Array.from({ length: symbolCount }, (_, index) => index)).slice(0, length);
}

export function encodeCipherGuess(guess: readonly number[], symbolCount: number): number {
  return guess.reduce((encoded, symbol) => encoded * symbolCount + symbol, 0);
}

export function decodeCipherGuess(encoded: number, length: number, symbolCount: number): number[] {
  if (!Number.isSafeInteger(encoded) || encoded < 0) return [];
  const guess = Array<number>(length);
  let remaining = encoded;
  for (let index = length - 1; index >= 0; index -= 1) {
    guess[index] = remaining % symbolCount;
    remaining = Math.floor(remaining / symbolCount);
  }
  return remaining === 0 ? guess : [];
}

function cipherFeedback(secret: readonly number[], guess: readonly number[]) {
  let exact = 0;
  const exactPositions: number[] = [];
  const secretCounts = new Map<number, number>();
  const guessCounts = new Map<number, number>();
  for (let index = 0; index < secret.length; index += 1) {
    if (secret[index] === guess[index]) {
      exact += 1;
      exactPositions.push(index);
    } else {
      secretCounts.set(secret[index], (secretCounts.get(secret[index]) ?? 0) + 1);
      guessCounts.set(guess[index], (guessCounts.get(guess[index]) ?? 0) + 1);
    }
  }
  let misplaced = 0;
  for (const [symbol, count] of guessCounts) {
    misplaced += Math.min(count, secretCounts.get(symbol) ?? 0);
  }
  return { exact, misplaced, exactPositions };
}

function circuitEdgeCount(rows: number, columns: number): number {
  return (rows + 1) * columns + rows * (columns + 1);
}

function circuitBoxEdges(rows: number, columns: number, box: number): number[] {
  const row = Math.floor(box / columns);
  const column = box % columns;
  const horizontalCount = (rows + 1) * columns;
  return [
    row * columns + column,
    (row + 1) * columns + column,
    horizontalCount + row * (columns + 1) + column,
    horizontalCount + row * (columns + 1) + column + 1,
  ];
}

function orthogonalNeighbors(index: number, rows: number, columns: number): number[] {
  const row = Math.floor(index / columns);
  const column = index % columns;
  return [
    row > 0 ? index - columns : -1,
    row + 1 < rows ? index + columns : -1,
    column > 0 ? index - 1 : -1,
    column + 1 < columns ? index + 1 : -1,
  ].filter((value) => value >= 0);
}

function gatewayHasPath(state: TurnMatchState, player: 0 | 1): boolean {
  const start = state.playerPositions?.[player];
  if (start === undefined) return false;
  const queue = [start];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const row = Math.floor(current / state.boardColumns);
    if ((player === 0 && row === 0) || (player === 1 && row === state.boardRows - 1)) {
      return true;
    }
    for (const next of orthogonalNeighbors(current, state.boardRows, state.boardColumns)) {
      if (visited.has(next) || state.cells[next] === 2) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return false;
}

function polarityFlips(state: TurnMatchState, cell: number, player: 0 | 1): number[] {
  if (cell < 0 || cell >= state.cells.length || state.cells[cell] !== null) return [];
  const row = Math.floor(cell / state.boardColumns);
  const column = cell % state.boardColumns;
  const opponent = 1 - player;
  const flips: number[] = [];
  for (const [dr, dc] of [
    [-1, -1], [-1, 0], [-1, 1], [0, -1],
    [0, 1], [1, -1], [1, 0], [1, 1],
  ]) {
    const line: number[] = [];
    let nextRow = row + dr;
    let nextColumn = column + dc;
    while (
      nextRow >= 0 && nextRow < state.boardRows
      && nextColumn >= 0 && nextColumn < state.boardColumns
    ) {
      const index = nextRow * state.boardColumns + nextColumn;
      if (state.cells[index] === opponent) {
        line.push(index);
      } else {
        if (state.cells[index] === player && line.length > 0) flips.push(...line);
        break;
      }
      nextRow += dr;
      nextColumn += dc;
    }
  }
  return flips;
}

function polarityMoves(state: TurnMatchState, player: 0 | 1): number[] {
  return state.cells
    .map((_, index) => polarityFlips(state, index, player).length > 0 ? index : -1)
    .filter((index) => index >= 0);
}

function newRound(
  seed: string,
  playerIds: [string, string],
  modeOrder: TurnGameMode[],
  difficulty: Difficulty,
  playerTimeLimitMs: number,
  roundIndex: number,
  scores: [number, number],
  playerTimeMs: [number, number],
): TurnMatchSession {
  const mode = modeOrder[roundIndex];
  const roundSeed = `${seed}_round_${roundIndex}`;
  const rng = new SeededRandom(roundSeed);
  const config = boardConfig(mode, difficulty);
  const cellCount = config.rows * config.columns;
  const pipeKinds = Array.from(
    { length: cellCount },
    () => rng.chance(0.48) ? 'straight' as const : 'corner' as const,
  );
  const pipeSolution = pipeKinds.map(() => rng.nextInt(0, 3));
  const pipeInitial = pipeSolution.map((rotation, index) => {
    return (rotation + rng.nextInt(1, 3)) % 4;
  });
  const resonanceTargets = Array.from({ length: config.rows }, () => rng.nextInt(0, 4));
  const resonanceInitial = resonanceTargets.map((target) => (target + rng.nextInt(1, 4)) % 5);
  const memory = mode === 'memory_pairs' ? memoryDeck(roundSeed, cellCount) : [];
  const cipherAllowRepeats = difficulty === 'hard' || difficulty === 'final';
  const sharedCipher = mode === 'cipher_clash'
    ? cipherCode(rng, config.rows, config.columns, cipherAllowRepeats)
    : [];
  const cipherSolutions: [number[], number[]] = [
    [...sharedCipher],
    [...sharedCipher],
  ];
  const circuitEdges = circuitEdgeCount(config.rows, config.columns);
  const movementPositions: [number, number] = mode === 'gateway_race'
    ? [
        (config.rows - 1) * config.columns + Math.floor(config.columns / 2),
        Math.floor(config.columns / 2),
      ]
    : [0, cellCount - 1];
  const initialCells = mode === 'pipe_circuit'
    ? pipeInitial
    : mode === 'resonance_dials'
      ? resonanceInitial
      : mode === 'circuit_claim'
        ? Array(circuitEdges).fill(null)
        : Array(cellCount).fill(null);
  if (mode === 'neon_trail') {
    initialCells[movementPositions[0]] = 0;
    initialCells[movementPositions[1]] = 1;
  }
  if (mode === 'polarity_war') {
    const upperLeft = (config.rows / 2 - 1) * config.columns + config.columns / 2 - 1;
    initialCells[upperLeft] = 0;
    initialCells[upperLeft + 1] = 1;
    initialCells[upperLeft + config.columns] = 1;
    initialCells[upperLeft + config.columns + 1] = 0;
  }

  return {
    seed,
    modeOrder,
    difficulty,
    playerTimeLimitMs,
    memoryDeck: memory,
    cipherSolutions,
    solution: mode === 'pipe_circuit'
      ? pipeSolution
      : mode === 'resonance_dials' ? resonanceTargets : [],
    state: {
      roundId: roundSeed,
      mode,
      roundIndex,
      totalRounds: modeOrder.length,
      playerIds,
      activePlayerIndex: (roundIndex % 2) as 0 | 1,
      scores,
      roundPoints: [0, 0],
      skipVotes: [false, false],
      cells: initialCells,
      cellOwners: Array(
        mode === 'circuit_claim' ? config.rows * config.columns : initialCells.length,
      ).fill(null),
      selectedCells: [],
      matchedCells: [],
      status: 'playing',
      winnerIndex: null,
      moveNumber: 0,
      playerTimeMs,
      boardRows: config.rows,
      boardColumns: config.columns,
      winLength: config.winLength,
      difficulty,
      ...(mode === 'pipe_circuit'
        ? {
            tileKinds: pipeKinds,
            targets: pipeSolution,
          }
        : {}),
      ...(mode === 'resonance_dials' ? { targets: resonanceTargets } : {}),
      ...(mode === 'cipher_clash'
        ? {
            cipherSymbolCount: config.columns,
            cipherCodeLength: config.rows,
            cipherHistory: [],
          }
        : {}),
      ...(mode === 'neon_trail' || mode === 'gateway_race'
        ? { playerPositions: movementPositions }
        : {}),
      ...(mode === 'gateway_race'
        ? {
            wallsRemaining: [
              [2, 4, 6, 7][DIFFICULTY_INDEX[difficulty]],
              [2, 4, 6, 7][DIFFICULTY_INDEX[difficulty]],
            ] as [number, number],
          }
        : {}),
    },
  };
}

export function createTurnMatchSession(
  seed: string,
  playerIds: [string, string],
  totalRounds = 5,
  difficulty: Difficulty = 'easy',
  playerTimeLimitMs = 5 * 60 * 1000,
  modePool: readonly TurnGameMode[] = MODES,
): TurnMatchSession {
  const normalizedRounds = Math.max(1, totalRounds);
  const selectedModes = modePool.length > 0 ? modePool : MODES;
  const modeOrder = createModeOrder(seed, normalizedRounds, selectedModes);
  return newRound(
    seed,
    playerIds,
    modeOrder,
    difficulty,
    playerTimeLimitMs,
    0,
    [0, 0],
    [playerTimeLimitMs, playerTimeLimitMs],
  );
}

export function findWinningLineCells(state: TurnMatchState, player: number): number[] {
  const { boardRows: rows, boardColumns: columns, winLength, cells } = state;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const line = Array.from({ length: winLength }, (_, offset) => {
          const x = column + dx * offset;
          const y = row + dy * offset;
          return x >= 0 && x < columns && y >= 0 && y < rows
            ? y * columns + x
            : -1;
        });
        if (line.every((index) => index >= 0 && cells[index] === player)) return line;
      }
    }
  }
  return [];
}

function hasLine(state: TurnMatchState, player: number): boolean {
  return findWinningLineCells(state, player).length > 0;
}

function finishRound(state: TurnMatchState, winnerIndex: 0 | 1 | null): void {
  state.status = 'round_complete';
  state.winnerIndex = winnerIndex;
  if (winnerIndex !== null) state.scores[winnerIndex] += 1;
}

export function applyTurnMove(
  session: TurnMatchSession,
  playerId: string,
  cell: number,
  expectedMove: number,
): TurnMoveResult {
  const state = session.state;
  if (state.status !== 'playing') return { accepted: false, reason: 'not_playing' };
  if (state.playerIds[state.activePlayerIndex] !== playerId) {
    return { accepted: false, reason: 'not_your_turn' };
  }
  if (expectedMove !== state.moveNumber) return { accepted: false, reason: 'stale_move' };
  if (!Number.isInteger(cell)) return { accepted: false, reason: 'invalid_cell' };

  const player = state.activePlayerIndex;
  if (state.mode === 'cipher_clash') {
    const codeLength = state.cipherCodeLength ?? 0;
    const symbolCount = state.cipherSymbolCount ?? 0;
    const guess = decodeCipherGuess(cell, codeLength, symbolCount);
    if (
      guess.length !== codeLength
      || guess.some((symbol) => symbol < 0 || symbol >= symbolCount)
    ) return { accepted: false, reason: 'invalid_cell' };
    const feedback = cipherFeedback(session.cipherSolutions[player], guess);
    state.cipherHistory = [
      ...(state.cipherHistory ?? []),
      { playerIndex: player, guess, ...feedback },
    ];
    state.roundPoints[player] = Math.max(state.roundPoints[player], feedback.exact);
    state.moveNumber += 1;
    if (feedback.exact === codeLength) {
      finishRound(state, player);
      return { accepted: true, roundEnded: true };
    }
    state.activePlayerIndex = (1 - player) as 0 | 1;
    return { accepted: true };
  }

  if (state.mode === 'circuit_claim') {
    if (cell < 0 || cell >= state.cells.length || state.cells[cell] !== null) {
      return { accepted: false, reason: 'invalid_cell' };
    }
    state.cells[cell] = player;
    let captured = 0;
    for (let box = 0; box < state.cellOwners.length; box += 1) {
      if (
        state.cellOwners[box] === null
        && circuitBoxEdges(state.boardRows, state.boardColumns, box)
          .every((edge) => state.cells[edge] !== null)
      ) {
        state.cellOwners[box] = player;
        state.roundPoints[player] += 1;
        captured += 1;
      }
    }
    state.moveNumber += 1;
    if (state.cells.every((value) => value !== null)) {
      const winner = state.roundPoints[0] === state.roundPoints[1]
        ? null
        : state.roundPoints[0] > state.roundPoints[1] ? 0 : 1;
      finishRound(state, winner);
      return { accepted: true, roundEnded: true };
    }
    if (captured === 0) state.activePlayerIndex = (1 - player) as 0 | 1;
    return { accepted: true };
  }

  if (state.mode === 'neon_trail') {
    const current = state.playerPositions?.[player];
    if (
      current === undefined
      || !orthogonalNeighbors(current, state.boardRows, state.boardColumns).includes(cell)
      || state.cells[cell] !== null
    ) return { accepted: false, reason: 'invalid_cell' };
    state.cells[cell] = player;
    state.cellOwners[cell] = player;
    state.playerPositions![player] = cell;
    state.moveNumber += 1;
    const opponent = (1 - player) as 0 | 1;
    const opponentPosition = state.playerPositions![opponent];
    const opponentCanMove = orthogonalNeighbors(
      opponentPosition,
      state.boardRows,
      state.boardColumns,
    ).some((next) => state.cells[next] === null);
    if (!opponentCanMove) {
      finishRound(state, player);
      return { accepted: true, roundEnded: true };
    }
    state.activePlayerIndex = opponent;
    return { accepted: true };
  }

  if (state.mode === 'gateway_race') {
    const cellCount = state.boardRows * state.boardColumns;
    const current = state.playerPositions?.[player];
    if (current === undefined) return { accepted: false, reason: 'invalid_cell' };
    if (cell < cellCount) {
      if (
        !orthogonalNeighbors(current, state.boardRows, state.boardColumns).includes(cell)
        || state.cells[cell] === 2
        || state.playerPositions!.includes(cell)
      ) return { accepted: false, reason: 'invalid_cell' };
      state.playerPositions![player] = cell;
      state.moveNumber += 1;
      const row = Math.floor(cell / state.boardColumns);
      if ((player === 0 && row === 0) || (player === 1 && row === state.boardRows - 1)) {
        finishRound(state, player);
        return { accepted: true, roundEnded: true };
      }
    } else {
      const barrier = cell - cellCount;
      if (
        barrier < 0
        || barrier >= cellCount
        || state.cells[barrier] !== null
        || state.playerPositions!.includes(barrier)
        || (state.wallsRemaining?.[player] ?? 0) <= 0
      ) return { accepted: false, reason: 'invalid_cell' };
      state.cells[barrier] = 2;
      state.cellOwners[barrier] = player;
      if (!gatewayHasPath(state, 0) || !gatewayHasPath(state, 1)) {
        state.cells[barrier] = null;
        state.cellOwners[barrier] = null;
        return { accepted: false, reason: 'invalid_cell' };
      }
      state.wallsRemaining![player] -= 1;
      state.moveNumber += 1;
    }
    state.activePlayerIndex = (1 - player) as 0 | 1;
    return { accepted: true };
  }

  if (state.mode === 'polarity_war') {
    const flips = polarityFlips(state, cell, player);
    if (flips.length === 0) return { accepted: false, reason: 'invalid_cell' };
    state.cells[cell] = player;
    state.cellOwners[cell] = player;
    for (const index of flips) {
      state.cells[index] = player;
      state.cellOwners[index] = player;
    }
    state.roundPoints = [
      state.cells.filter((value) => value === 0).length,
      state.cells.filter((value) => value === 1).length,
    ];
    state.moveNumber += 1;
    const opponent = (1 - player) as 0 | 1;
    const opponentMoves = polarityMoves(state, opponent);
    const currentMoves = polarityMoves(state, player);
    if (opponentMoves.length === 0 && currentMoves.length === 0) {
      const winner = state.roundPoints[0] === state.roundPoints[1]
        ? null
        : state.roundPoints[0] > state.roundPoints[1] ? 0 : 1;
      finishRound(state, winner);
      return { accepted: true, roundEnded: true };
    }
    state.activePlayerIndex = opponentMoves.length > 0 ? opponent : player;
    return { accepted: true };
  }

  if (state.mode === 'pipe_circuit') {
    if (cell < 0 || cell >= state.cells.length) {
      return { accepted: false, reason: 'invalid_cell' };
    }
    if (state.cells[cell] === session.solution[cell]) {
      return { accepted: false, reason: 'invalid_cell' };
    }
    state.cells[cell] = ((state.cells[cell] ?? 0) + 1) % 4;
    state.cellOwners[cell] = state.cells[cell] === session.solution[cell] ? player : null;
    state.moveNumber += 1;
    if (state.cells.every((value, index) => value === session.solution[index])) {
      finishRound(state, player);
      return { accepted: true, roundEnded: true };
    }
    state.activePlayerIndex = (1 - player) as 0 | 1;
    return { accepted: true };
  }

  if (state.mode === 'resonance_dials') {
    if (cell < 0 || cell >= state.cells.length * 2) {
      return { accepted: false, reason: 'invalid_cell' };
    }
    const dial = Math.floor(cell / 2);
    const direction = cell % 2 === 0 ? -1 : 1;
    if (state.cells[dial] === session.solution[dial]) {
      return { accepted: false, reason: 'invalid_cell' };
    }
    state.cells[dial] = ((state.cells[dial] ?? 0) + direction + 5) % 5;
    state.cellOwners[dial] = state.cells[dial] === session.solution[dial] ? player : null;
    state.moveNumber += 1;
    if (state.cells.every((value, index) => value === session.solution[index])) {
      finishRound(state, player);
      return { accepted: true, roundEnded: true };
    }
    state.activePlayerIndex = (1 - player) as 0 | 1;
    return { accepted: true };
  }

  if (state.mode === 'rune_grid') {
    if (cell < 0 || cell >= state.cells.length || state.cells[cell] !== null) {
      return { accepted: false, reason: 'invalid_cell' };
    }
    state.cells[cell] = player;
    state.cellOwners[cell] = player;
    state.moveNumber += 1;
    if (hasLine(state, player)) {
      finishRound(state, player);
      return { accepted: true, roundEnded: true };
    }
    if (state.cells.every((value) => value !== null)) {
      finishRound(state, null);
      return { accepted: true, roundEnded: true };
    }
    state.activePlayerIndex = (1 - player) as 0 | 1;
    return { accepted: true };
  }

  if (state.mode === 'connect_four') {
    if (cell < 0 || cell >= state.boardColumns) {
      return { accepted: false, reason: 'invalid_cell' };
    }
    let target = -1;
    for (let row = state.boardRows - 1; row >= 0; row -= 1) {
      const index = row * state.boardColumns + cell;
      if (state.cells[index] === null) {
        target = index;
        break;
      }
    }
    if (target < 0) return { accepted: false, reason: 'invalid_cell' };
    state.cells[target] = player;
    state.cellOwners[target] = player;
    state.moveNumber += 1;
    if (hasLine(state, player)) {
      finishRound(state, player);
      return { accepted: true, roundEnded: true };
    }
    if (state.cells.every((value) => value !== null)) {
      finishRound(state, null);
      return { accepted: true, roundEnded: true };
    }
    state.activePlayerIndex = (1 - player) as 0 | 1;
    return { accepted: true };
  }

  if (
    cell < 0 ||
    cell >= state.cells.length ||
    state.selectedCells.includes(cell) ||
    state.matchedCells.includes(cell)
  ) return { accepted: false, reason: 'invalid_cell' };

  state.cells[cell] = session.memoryDeck[cell];
  state.selectedCells.push(cell);
  state.moveNumber += 1;
  if (state.selectedCells.length === 1) return { accepted: true };

  const [first, second] = state.selectedCells;
  if (session.memoryDeck[first] === session.memoryDeck[second]) {
    state.matchedCells.push(first, second);
    state.cellOwners[first] = player;
    state.cellOwners[second] = player;
    state.selectedCells = [];
    state.roundPoints[player] += 1;
    if (state.matchedCells.length === state.cells.length) {
      const winner = state.roundPoints[0] === state.roundPoints[1]
        ? null
        : state.roundPoints[0] > state.roundPoints[1] ? 0 : 1;
      finishRound(state, winner);
      return { accepted: true, roundEnded: true };
    }
    return { accepted: true };
  }
  state.status = 'resolving';
  return { accepted: true, needsResolve: true };
}

export function resolveMemoryTurn(session: TurnMatchSession): void {
  const state = session.state;
  if (state.status !== 'resolving') return;
  for (const index of state.selectedCells) state.cells[index] = null;
  state.selectedCells = [];
  state.activePlayerIndex = (1 - state.activePlayerIndex) as 0 | 1;
  state.status = 'playing';
}

export function advanceTurnRound(session: TurnMatchSession): boolean {
  if (session.state.status !== 'round_complete') return false;
  const nextIndex = session.state.roundIndex + 1;
  if (nextIndex >= session.state.totalRounds) {
    session.state.status = 'match_complete';
    session.state.winnerIndex = session.state.scores[0] === session.state.scores[1]
      ? null
      : session.state.scores[0] > session.state.scores[1] ? 0 : 1;
    return false;
  }
  const next = newRound(
    session.seed,
    session.state.playerIds,
    session.modeOrder,
    session.difficulty,
    session.playerTimeLimitMs,
    nextIndex,
    [...session.state.scores] as [number, number],
    [...session.state.playerTimeMs] as [number, number],
  );
  session.state = next.state;
  session.memoryDeck = next.memoryDeck;
  session.solution = next.solution;
  session.cipherSolutions = next.cipherSolutions;
  return true;
}

/** Advance without awarding a point after both players approve a skip. */
export function skipTurnRound(session: TurnMatchSession): boolean {
  if (session.state.status !== 'playing' && session.state.status !== 'resolving') {
    return false;
  }
  session.state.status = 'round_complete';
  session.state.winnerIndex = null;
  session.state.skipVotes = [true, true];
  return advanceTurnRound(session);
}

export function legalTurnMoves(
  session: TurnMatchSession,
  playerIndex: 0 | 1 = session.state.activePlayerIndex,
): number[] {
  const state = session.state;
  if (state.mode === 'circuit_claim') {
    return state.cells.map((value, index) => value === null ? index : -1).filter((index) => index >= 0);
  }
  if (state.mode === 'neon_trail') {
    const position = state.playerPositions?.[playerIndex];
    return position === undefined
      ? []
      : orthogonalNeighbors(position, state.boardRows, state.boardColumns)
        .filter((index) => state.cells[index] === null);
  }
  if (state.mode === 'gateway_race') {
    const position = state.playerPositions?.[playerIndex];
    if (position === undefined) return [];
    const moves = orthogonalNeighbors(position, state.boardRows, state.boardColumns)
      .filter((index) => state.cells[index] !== 2 && !state.playerPositions!.includes(index));
    if ((state.wallsRemaining?.[playerIndex] ?? 0) <= 0) return moves;
    const cellCount = state.boardRows * state.boardColumns;
    const barriers = state.cells.map((value, index) => {
      if (value !== null || state.playerPositions!.includes(index)) return -1;
      const copy: TurnMatchState = {
        ...state,
        cells: [...state.cells],
        cellOwners: [...state.cellOwners],
        playerPositions: [...state.playerPositions!] as [number, number],
      };
      copy.cells[index] = 2;
      return gatewayHasPath(copy, 0) && gatewayHasPath(copy, 1) ? cellCount + index : -1;
    }).filter((index) => index >= 0);
    return [...moves, ...barriers];
  }
  if (state.mode === 'polarity_war') return polarityMoves(state, playerIndex);
  return [];
}

export function tickTurnClock(session: TurnMatchSession, elapsedMs: number): boolean {
  if (session.state.status !== 'playing' || elapsedMs <= 0) return false;
  const player = session.state.activePlayerIndex;
  session.state.playerTimeMs[player] = Math.max(
    0,
    session.state.playerTimeMs[player] - elapsedMs,
  );
  if (session.state.playerTimeMs[player] > 0) return false;
  const winner = (1 - player) as 0 | 1;
  session.state.scores[winner] += 1;
  session.state.winnerIndex = winner;
  session.state.status = 'match_complete';
  return true;
}
