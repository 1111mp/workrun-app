import { z } from '@/lib/zod';

const reservedHeaders = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'host',
  'content-length',
  'content-type',
  'accept',
  'connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
]);

export const providerCredentialSchema = z
  .object({
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
    headers: z.array(
      z.object({
        name: z
          .string()
          .regex(
            /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/,
            'settings.models.headerNameInvalid',
          )
          .refine(
            (name) => !reservedHeaders.has(name.toLowerCase()),
            'settings.models.headerReserved',
          ),
        value: z.string().refine(
          (value) =>
            Array.from(value).every((character) => {
              const code = character.charCodeAt(0);
              return code === 9 || (code >= 32 && code !== 127);
            }),
          'settings.models.headerValueInvalid',
        ),
      }),
    ),
  })
  .superRefine((credential, ctx) => {
    if (
      credential.headers.length &&
      !['open_ai', 'open_ai_strict', 'anthropic'].includes(credential.provider)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message: 'settings.models.headersUnsupported',
      });
    }
    const names = new Set<string>();
    credential.headers.forEach((header, index) => {
      const name = header.name.toLowerCase();
      if (names.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['headers', index, 'name'],
          message: 'settings.models.headerDuplicate',
        });
      }
      names.add(name);
    });
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
  otlp_endpoint: z.string().trim(),
  // model
  provider_credentials: z.array(providerCredentialSchema),
  summary_model_profile_id: z.string(),
});

export type SettingsForm = z.infer<typeof formSchema>;
