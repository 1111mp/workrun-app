import { describe, expect, it } from 'vitest';

import { workflowDocumentFromSnapshot } from './workflow';

describe('workflowDocumentFromSnapshot', () => {
  it('uses the mode captured when a run started', () => {
    expect(
      workflowDocumentFromSnapshot({
        nodes: [],
        edges: [],
        settings: { mode: 'chat' },
      }),
    ).toMatchObject({ settings: { mode: 'chat' } });
  });

  it('rejects incomplete historical snapshots', () => {
    expect(workflowDocumentFromSnapshot({ settings: { mode: 'task' } })).toBe(
      undefined,
    );
  });
});
