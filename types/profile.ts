export const PLAYER_AVATAR_IDS = [
  'bolt',
  'bot',
  'cat',
  'crown',
  'flame',
  'gamepad',
  'gem',
  'rocket',
  'shield',
  'sparkles',
  'swords',
  'trophy',
] as const;

export type PlayerAvatarId = typeof PLAYER_AVATAR_IDS[number];

export function isPlayerAvatarId(value: unknown): value is PlayerAvatarId {
  return typeof value === 'string'
    && (PLAYER_AVATAR_IDS as readonly string[]).includes(value);
}
