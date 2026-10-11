import { describe, expect, it } from 'vitest';

import type { RunRecord } from '@/services/run-history';

import { restoreProcessNodeRun } from './app-run-output-panel';

const definition = {
  id: 'app-1',
  name: 'User Info',
  projectRoot: '/apps/info',
};

function record(outputView: unknown): RunRecord {
  return {
    id: 'run-1',
    targetType: 'app',
    targetId: definition.id,
    targetName: definition.name,
    status: 'running',
    startedAt: '2026-10-10T00:00:00Z',
    outputView,
    targetSnapshot: definition,
    runtime: {},
    spans: [],
    events: [
      {
        sequence: 1,
        createdAt: '2026-10-10T00:00:00Z',
        event: { type: 'output', stream: 'stdout', data: 'hello' },
      },
    ],
  };
}

describe('App deeplink output restoration', () => {
  it('normalizes bare definitions saved by older deeplink runs', () => {
    const run = restoreProcessNodeRun(record({ node: definition }));
    expect(run.node.definition.name).toBe('User Info');
    expect(run.node.projectPath).toBe('/apps/info');
    expect(run.output.stdout).toBe('hello');
    expect(run.isRunning).toBe(true);
  });

  it('preserves complete saved App objects', () => {
    const node = {
      definition,
      projectPath: '/installed/info',
      installStatus: 'installed',
    };
    const run = restoreProcessNodeRun(record({ node }));
    expect(run.node).toBe(node);
    expect(run.node.definition.name).toBe('User Info');
  });

  it('falls back to the target snapshot when the saved view has no node', () => {
    const run = restoreProcessNodeRun(record({}));
    expect(run.node.definition.name).toBe('User Info');
  });
});
