import { z } from './lib/zod';

export const envValidationSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SERVER_BASE_URL: z.url().default('http://localhost:3000'),

  MONGODB_URI: z.string().min(1),

  BETTER_AUTH_SECRET: z
    .string()
    .min(1)
    .default('example-only-secret-do-not-use-in-production-32'),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),

  LOG_LEVEL: z.string().default('debug'),
  LOG_DIR: z.string().default('./logs'),
});
