import { SeededRandom } from './SeededRandom';
import type {
  ColorPathPair,
  ColorPathSubmission,
  GuideChallengeState,
} from '@/types/puzzle';

const PALETTE = [
  { id: 'ruby', label: '◆', color: '#F26D78' },
  { id: 'sapphire', label: '●', color: '#59BFE6' },
  { id: 'emerald', label: '▲', color: '#50D890' },
  { id: 'amethyst', label: '■', color: '#A76CF0' },
];

export interface GeneratedColorPathChallenge {
  challenge: Extract<GuideChallengeState, { kind: 'color_paths' }>;
  solution: ColorPathSubmission[];
}

function serpentineOrder(size: number): number[] {
  const order: number[] = [];
  for (let row = 0; row < size; row += 1) {
    const columns = Array.from({ length: size }, (_, column) => column);
    if (row % 2 === 1) columns.reverse();
    columns.forEach((column) => order.push(row * size + column));
  }
  return order;
}

function transformCell(index: number, size: number, rotation: number, flip: boolean): number {
  let row = Math.floor(index / size);
  let column = index % size;
  if (flip) column = size - 1 - column;
  for (let turn = 0; turn < rotation; turn += 1) {
    [row, column] = [column, size - 1 - row];
  }
  return row * size + column;
}

/**
 * Creates a guaranteed-solvable Numberlink-style board. A transformed
 * Hamiltonian path is split into contiguous colored routes, so every cell has
 * exactly one valid owner in the generated solution.
 */
export function generateColorPathChallenge(
  seed: string,
  size: 5 | 6,
  pairCount: 3 | 4,
  maxAttempts: number,
): GeneratedColorPathChallenge {
  const rng = new SeededRandom(`${seed}_color_paths`);
  const rotation = rng.nextInt(0, 3);
  const flip = rng.chance(0.5);
  const transformedOrder = serpentineOrder(size).map((index) =>
    transformCell(index, size, rotation, flip));

  const total = size * size;
  const minimum = 4;
  const lengths: number[] = [];
  let remaining = total;
  for (let index = 0; index < pairCount - 1; index += 1) {
    const pairsLeft = pairCount - index - 1;
    const ideal = Math.floor(remaining / (pairsLeft + 1));
    const low = Math.max(minimum, ideal - 2);
    const high = Math.min(remaining - pairsLeft * minimum, ideal + 2);
    const length = rng.nextInt(low, high);
    lengths.push(length);
    remaining -= length;
  }
  lengths.push(remaining);

  const palette = rng.shuffle(PALETTE).slice(0, pairCount);
  const pairs: ColorPathPair[] = [];
  const solution: ColorPathSubmission[] = [];
  let cursor = 0;
  lengths.forEach((length, index) => {
    const cells = transformedOrder.slice(cursor, cursor + length);
    const style = palette[index];
    pairs.push({
      id: style.id,
      label: style.label,
      color: style.color,
      start: cells[0],
      end: cells[cells.length - 1],
    });
    solution.push({ pairId: style.id, cells });
    cursor += length;
  });

  // Endpoint order should not expose the hidden route ordering.
  return {
    challenge: {
      kind: 'color_paths',
      gridSize: size,
      pairs: rng.shuffle(pairs),
      requireFullCoverage: true,
      maxAttempts,
    },
    solution,
  };
}

function areAdjacent(first: number, second: number, size: number): boolean {
  const firstRow = Math.floor(first / size);
  const firstColumn = first % size;
  const secondRow = Math.floor(second / size);
  const secondColumn = second % size;
  return Math.abs(firstRow - secondRow) + Math.abs(firstColumn - secondColumn) === 1;
}

/**
 * Validates the player's topology, rather than matching one secret route.
 * Alternate solutions are accepted when all matching endpoints are connected
 * orthogonally without crossings and the board is fully covered.
 */
export function validateColorPathSubmission(
  challenge: Extract<GuideChallengeState, { kind: 'color_paths' }>,
  submittedPaths: ColorPathSubmission[],
): boolean {
  if (submittedPaths.length !== challenge.pairs.length) return false;

  const endpointOwners = new Map<number, string>();
  challenge.pairs.forEach((pair) => {
    endpointOwners.set(pair.start, pair.id);
    endpointOwners.set(pair.end, pair.id);
  });

  const pathByPair = new Map(submittedPaths.map((path) => [path.pairId, path.cells]));
  if (pathByPair.size !== challenge.pairs.length) return false;

  const occupied = new Set<number>();
  for (const pair of challenge.pairs) {
    const cells = pathByPair.get(pair.id);
    if (!cells || cells.length < 2) return false;
    const forward = cells[0] === pair.start && cells[cells.length - 1] === pair.end;
    const reverse = cells[0] === pair.end && cells[cells.length - 1] === pair.start;
    if (!forward && !reverse) return false;

    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index];
      if (!Number.isInteger(cell) || cell < 0 || cell >= challenge.gridSize ** 2) return false;
      if (occupied.has(cell)) return false;
      if (index > 0 && !areAdjacent(cells[index - 1], cell, challenge.gridSize)) return false;
      const endpointOwner = endpointOwners.get(cell);
      if (endpointOwner && endpointOwner !== pair.id) return false;
      occupied.add(cell);
    }
  }

  return !challenge.requireFullCoverage || occupied.size === challenge.gridSize ** 2;
}
