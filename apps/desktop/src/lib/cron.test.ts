import { describe, expect, it } from 'vitest';

import { previewCron } from './cron';

describe('previewCron', () => {
  it('describes and expands a five-field cron expression', () => {
    const preview = previewCron('0 9 * * 1-5', 'Asia/Shanghai', 'en');

    expect(preview.valid).toBe(true);
    if (preview.valid) {
      expect(preview.description).not.toBe('0 9 * * 1-5');
      expect(preview.occurrences).toHaveLength(3);
    }
  });

  it('returns an inline-safe error for an invalid expression', () => {
    expect(previewCron('not cron', 'UTC', 'en').valid).toBe(false);
  });
});
