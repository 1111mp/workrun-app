import { z } from './lib/zod';
import {
  normalizeLiteLlmUrl,
  parseModelCatalog,
} from './modules/llm/llm.config';

export const envValidationSchema = z
  .object({
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

    LITELLM_BASE_URL: z
      .string()
      .trim()
      .optional()
      .refine((value) => {
        if (!value) return true;
        try {
          normalizeLiteLlmUrl(value);
          return true;
        } catch {
          return false;
        }
      }, 'Invalid LiteLLM API base URL'),
    LITELLM_TEAM_KEY: z.string().trim().optional(),
    LITELLM_TEAM_ID: z.string().trim().optional(),
    LITELLM_DEPLOYMENT_ID: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    LITELLM_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3_600_000)
      .default(300_000),
    LITELLM_MODEL_CATALOG_JSON: z
      .string()
      .default('{}')
      .refine((value) => {
        try {
          parseModelCatalog(value);
          return true;
        } catch {
          return false;
        }
      }, 'Invalid LiteLLM model capability catalog'),

    LOG_LEVEL: z.string().default('debug'),
    LOG_DIR: z.string().default('./logs'),
  })
  .superRefine((env, ctx) => {
    const keys = [
      'LITELLM_BASE_URL',
      'LITELLM_TEAM_KEY',
      'LITELLM_TEAM_ID',
      'LITELLM_DEPLOYMENT_ID',
    ] as const;
    if (keys.some((key) => Boolean(env[key]))) {
      for (const key of keys) {
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message:
              'All LiteLLM connection and identity settings are required when enabling team models',
          });
      }
    }
  });
