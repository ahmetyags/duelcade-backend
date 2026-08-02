/**
 * Deterministic seed-based pseudo-random number generator.
 *
 * Uses a mulberry32 algorithm — fast, well-distributed, and deterministic
 * given the same seed. This ensures reproducible procedural generation
 * while remaining unpredictable to players.
 *
 * The server generates the seed; clients never see it. This module is
 * used both by the "server" game engine and the procedural generator.
 */

/** A seeded random number generator with utility methods. */
export class SeededRandom {
  private state: number;

  /**
   * @param seed - Hex string or number seed for the RNG.
   */
  constructor(seed: string | number) {
    this.state = typeof seed === 'string' ? this.hashStringToSeed(seed) : seed >>> 0;
  }

  /** Hash a string into a 32-bit unsigned integer seed. */
  private hashStringToSeed(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /** Core mulberry32 step — returns a float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Random integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Random float in [min, max). */
  nextFloat(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  /** Pick a random element from an array. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Pick n distinct elements from an array (shuffle-based). */
  pickMany<T>(arr: readonly T[], n: number): T[] {
    const copy = [...arr];
    const result: T[] = [];
    for (let i = 0; i < n && copy.length > 0; i++) {
      const idx = Math.floor(this.next() * copy.length);
      result.push(copy[idx]);
      copy.splice(idx, 1);
    }
    return result;
  }

  /** Shuffle an array in-place (Fisher-Yates). */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Return a boolean with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Generate a room code — 6 chars, no ambiguous characters (0/O, 1/I). */
  static generateRoomCode(rng: SeededRandom): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(rng.next() * chars.length)];
    }
    return code;
  }

  /** Generate a fresh seed string. */
  static generateSeed(): string {
    const timestamp = Date.now().toString(16);
    const random = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    return `${timestamp}-${random}`;
  }
}
