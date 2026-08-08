import { z } from '@/lib/zod';

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
});

export type SettingsForm = z.infer<typeof formSchema>;
