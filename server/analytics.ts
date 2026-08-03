import { z } from 'zod';

export const ANALYTICS_RETENTION_DAYS = 90;
export const ANALYTICS_CONTRACT_VERSION = 1;

export const AnalyticsEventNameSchema = z.enum([
  'app_session_started',
  'tutorial_started',
  'tutorial_completed',
  'match_started',
  'first_move',
  'match_completed',
  'match_abandoned',
  'rematch_requested',
  'progression_viewed',
  'quest_claimed',
]);

export type AnalyticsEventName = z.infer<typeof AnalyticsEventNameSchema>;

const AnalyticsPropertiesSchema = z.object({
  playMode: z.enum(['online', 'solo', 'tutorial']).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  result: z.enum(['win', 'loss', 'draw', 'abandoned']).optional(),
  durationBucket: z.enum(['under_2m', '2_to_5m', 'over_5m']).optional(),
  roundCount: z.number().int().min(1).max(20).optional(),
  questKey: z.enum(['play_duel', 'win_duel', 'win_rounds']).optional(),
  mode: z.enum([
    'rune_grid',
    'memory_pairs',
    'circuit_claim',
    'neon_trail',
  ]).optional(),
}).strict();

export const AnalyticsEventSchema = z.object({
  id: z.string().uuid(),
  name: AnalyticsEventNameSchema,
  sessionId: z.string().uuid(),
  occurredAt: z.number().int().nonnegative(),
  platform: z.enum(['android', 'ios', 'web']),
  appVersion: z.string().trim().min(1).max(32),
  properties: AnalyticsPropertiesSchema.default({}),
}).strict();

export const AnalyticsBatchSchema = z.object({
  contractVersion: z.literal(ANALYTICS_CONTRACT_VERSION),
  events: z.array(AnalyticsEventSchema).min(1).max(25),
}).strict();

export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;

export function clampAnalyticsTimestamp(
  occurredAt: number,
  now = Date.now(),
): number {
  const earliest = now - 7 * 24 * 60 * 60 * 1_000;
  const latest = now + 5 * 60 * 1_000;
  return Math.min(latest, Math.max(earliest, occurredAt));
}
