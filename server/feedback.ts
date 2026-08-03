import { z } from 'zod';

export const FEEDBACK_RETENTION_DAYS = 180;

export const FeedbackSubmissionSchema = z.object({
  id: z.string().uuid(),
  category: z.enum([
    'bug',
    'gameplay',
    'balance',
    'tutorial',
    'performance',
    'other',
  ]),
  rating: z.number().int().min(1).max(5),
  message: z.string()
    .trim()
    .min(10)
    .max(1000)
    .refine(
      (value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value),
      'Feedback contains unsupported control characters',
    ),
  screen: z.enum([
    'home',
    'solo',
    'create',
    'join',
    'lobby',
    'game',
    'results',
    'history',
    'progression',
    'settings',
    'other',
  ]),
  platform: z.enum(['android', 'ios', 'web']),
  appVersion: z.string().trim().min(1).max(32),
  buildVersion: z.string().trim().min(1).max(32),
  locale: z.enum(['tr', 'en']),
}).strict();

export type FeedbackSubmission = z.infer<typeof FeedbackSubmissionSchema>;
