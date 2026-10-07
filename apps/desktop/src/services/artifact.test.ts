import { describe, expect, it } from 'vitest';

import { artifactReferences } from './artifact';

describe('artifactReferences', () => {
  it('finds nested files and deduplicates a shared snapshot', () => {
    const file = {
      $type: 'artifact',
      id: 'one',
      version: 1,
      name: 'report.pdf',
      mimeType: 'application/pdf',
      size: 42,
    };
    expect(
      artifactReferences({
        global: { file },
        nodes: { process: { files: [file] } },
      }),
    ).toEqual([file]);
  });
  it('does not turn malformed or redacted State into download links', () => {
    expect(
      artifactReferences({
        file: { $type: 'artifact', id: 'one' },
        sensitive: '[SENSITIVE REDACTED]',
      }),
    ).toEqual([]);
  });
});
