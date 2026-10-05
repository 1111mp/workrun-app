import { describe, expect, it } from 'vitest';

import { humanReviewAttachments } from './human-review';

const file = {
  $type: 'artifact',
  id: 'one',
  version: 1,
  name: 'report.pdf',
  mimeType: 'application/pdf',
  size: 42,
};

describe('humanReviewAttachments', () => {
  it('reads durable attachments and older content/context payloads without duplicates', () => {
    const legacy = { content: { file }, context: { outputs: [file] } };
    expect(humanReviewAttachments(legacy)).toEqual([file]);
    const reopened = JSON.parse(
      JSON.stringify({ ...legacy, attachments: [file] }),
    );
    expect(humanReviewAttachments(reopened)).toEqual([file]);
  });

  it('does not discover files in routing metadata or unrelated payload fields', () => {
    expect(
      humanReviewAttachments({
        workflowContext: { file },
        initialState: { file },
        attachments: '[SENSITIVE REDACTED]',
        content: { $type: 'artifact', id: 'invalid' },
      }),
    ).toEqual([]);
  });
});
