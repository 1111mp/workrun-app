import { z } from '@/lib/zod';

const providerCredentialSchema = z.object({
  provider: z.enum([
    'gemini',
    'open_ai',
    'open_ai_strict',
    'anthropic',
    'deep_seek',
    'groq',
    'ollama',
  ]),
  baseUrl: z.string().trim().optional(),
  apiKey: z.string().optional(),
});

export const formSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']),
  locale: z.enum(['zh-CN', 'en']),
  // general
  auto_check_update: z.boolean(),
  enable_auto_launch: z.boolean(),
  enable_silent_start: z.boolean(),
  // log
  app_log_level: z.enum(['silent', 'error', 'warn', 'info', 'debug', 'trace']),
  auto_log_clean: z.enum(['0', '1', '2', '3', '4']),
  app_log_max_size: z.number().min(1),
  app_log_max_count: z.number().min(1),
  // model
  provider_credentials: z.array(providerCredentialSchema),
});

export type SettingsForm = z.infer<typeof formSchema>;
