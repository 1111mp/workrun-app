import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createWorkspace(root, workflow) {
  const dataDir = await mkdtemp(join(tmpdir(), 'workrun-e2e-'));
  // A preconfigured personal workspace needs its IPC socket parent at startup.
  await mkdir(join(dataDir, 'personal/runtime'), { recursive: true });
  const nodes = [];
  if (workflow) {
    const id = '019b812d-4958-7d37-8a45-47e1e20a4744';
    await cp(
      join(root, 'test/e2e/fixtures/echo'),
      join(dataDir, 'personal/process-nodes', id),
      { recursive: true },
    );
    nodes.push({
      id,
      name: 'E2E echo',
      version: '0.1.0',
      entry: 'main.py',
      kind: 'workflow',
      inputs: { message: { type: 'string' } },
      outputs: { message: { type: 'string' } },
    });
  }
  // Native IPC initializes its catalogs before the onboarding UI is completed.
  for (const [relativePath, catalog] of [
    ['personal/workflow.json', { workflows: [] }],
    ['personal/process-nodes/catalog.json', { nodes }],
    ['personal/mcp-servers/catalog.json', { servers: [] }],
  ]) {
    const path = join(dataDir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(catalog));
  }
  await writeFile(
    join(dataDir, 'workrun.yaml'),
    JSON.stringify({
      locale: 'en',
      theme: 'light',
      onboarding_completed: workflow,
      local_profile: workflow
        ? { display_name: 'E2E User', avatar_id: 'e2e' }
        : undefined,
      workspace_mode: 'personal',
      enable_auto_launch: false,
      auto_check_update: false,
    }),
  );
  return dataDir;
}
