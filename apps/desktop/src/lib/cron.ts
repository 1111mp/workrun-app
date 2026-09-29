import { CronExpressionParser } from 'cron-parser';
import { toString as cronToString } from 'cronstrue';
import 'cronstrue/locales/zh_CN.js';

export type CronPreview =
  | { valid: true; description: string; occurrences: Date[] }
  | { valid: false; error: string };

/**
 * Rust remains authoritative at save time; this only powers immediate editor
 * feedback and previews in the renderer.
 */
export function previewCron(
  expression: string,
  timezone: string,
  language: string,
): CronPreview {
  try {
    const interval = CronExpressionParser.parse(expression, {
      tz: timezone,
      currentDate: new Date(),
    });
    return {
      valid: true,
      description: cronToString(expression, {
        // Workrun's five-field syntax follows crontab: 1 is Monday, not Sunday.
        dayOfWeekStartIndexZero: true,
        locale: language.startsWith('zh') ? 'zh_CN' : 'en',
        use24HourTimeFormat: true,
      }),
      occurrences: interval.take(3).map((occurrence) => occurrence.toDate()),
    };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}
