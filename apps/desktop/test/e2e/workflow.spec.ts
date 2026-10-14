import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { browser, expect } from '@wdio/globals';

import type { RunHistoryPage, RunRecord } from '../../src/services/run-history';
// Avoid importing the workflow service's DOM and frontend alias dependencies.
type StoredWorkflow = { id: string; document: { settings: { name: string } } };

const restored = process.env.WORKRUN_E2E_RESTORE === '1';
const receiptPath = join(
  process.env.WORKRUN_E2E_DATA_DIR!,
  'workflow-run.json',
);
const message = 'hello from Python';
const result = `E2E result: ${message}`;
const name = 'E2E Python workflow';

async function waitForDatabase() {
  await browser.waitUntil(
    async () => {
      try {
        return Array.isArray(
          await browser.tauri.execute(({ core }) =>
            core.invoke('run_history_list_active'),
          ),
        );
      } catch {
        return false;
      }
    },
    { timeoutMsg: 'The Rust database did not finish initializing' },
  );
}

async function inspect(id: string) {
  return browser.tauri.execute(
    ({ core }, runId) =>
      core.invoke('run_history_inspect', { id: runId }) as Promise<RunRecord>,
    id,
  );
}

async function viewHistory() {
  await browser.$('a[href="/runs"]').click();
  await expect(browser.$('body')).toHaveText(expect.stringContaining(name));
  await expect(browser.$('body')).toHaveText(
    expect.stringContaining('Completed'),
  );
  await browser.$('button=View output').click();
  await expect(browser.$('body')).toHaveText(expect.stringContaining(result));
}

describe('Native workflow execution', () => {
  it(
    restored
      ? 'restores the workflow and output after an application restart'
      : 'executes Python from the UI and persists the result and history',
    async () => {
      await waitForDatabase();
      if (restored) {
        const saved = JSON.parse(await readFile(receiptPath, 'utf8')) as {
          workflowId: string;
          runId: string;
        };
        const workflow = await browser.tauri.execute(
          ({ core }, id) =>
            core.invoke('get_workflow', { id }) as Promise<StoredWorkflow>,
          saved.workflowId,
        );
        expect(workflow.document.settings.name).toBe(name);
        const record = await inspect(saved.runId);
        expect(record.status).toBe('completed');
        expect(record.input).toEqual({ message });
        expect(JSON.stringify(record.events)).toContain(result);
        await viewHistory();
        return;
      }

      const document = {
        settings: {
          name,
          description: 'Deterministic native Python smoke test',
          mode: 'task',
          inputSchema: {
            fields: [
              {
                id: 'message',
                key: 'message',
                label: 'Message',
                type: 'string',
                required: true,
              },
            ],
          },
          outputSchema: {
            fields: [
              {
                id: 'message',
                key: 'message',
                label: 'Message',
                type: 'string',
                required: true,
              },
            ],
          },
        },
        nodes: [
          { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
          {
            id: 'echo',
            type: 'process',
            position: { x: 250, y: 0 },
            data: {
              name: 'E2E echo',
              processNodeId: '019b812d-4958-7d37-8a45-47e1e20a4744',
              globalKeys: ['message'],
            },
          },
          { id: 'end', type: 'end', position: { x: 500, y: 0 }, data: {} },
        ],
        edges: [
          { id: 'start-echo', source: 'start', target: 'echo' },
          { id: 'echo-end', source: 'echo', target: 'end' },
        ],
      };
      // Arrange through real IPC; execution and output navigation must use the UI.
      const workflow = await browser.tauri.execute(
        ({ core }, fixture) =>
          core.invoke('create_workflow', {
            document: fixture,
          }) as Promise<StoredWorkflow>,
        document,
      );
      await browser.refresh();
      await browser.$(`a[href="/workflows/${workflow.id}?run=true"]`).click();
      await browser.$('#run-input-message').setValue(message);
      await browser.$('form button[type="submit"]').click();

      let runId = '';
      await browser.waitUntil(
        async () => {
          const page = await browser.tauri.execute(
            ({ core }, targetId) =>
              core.invoke('run_history_list', {
                query: { targetId },
              }) as Promise<RunHistoryPage>,
            workflow.id,
          );
          const record = page.items[0];
          if (record?.status === 'failed')
            throw new Error(record.error ?? 'Workflow failed');
          runId = record?.id ?? '';
          return record?.status === 'completed';
        },
        {
          timeout: 180000,
          timeoutMsg: 'The native Python workflow did not complete',
        },
      );
      await expect(browser.$('body')).toHaveText(
        expect.stringContaining(result),
      );
      const record = await inspect(runId);
      expect(record.input).toEqual({ message });
      expect(JSON.stringify(record.events)).toContain(result);
      await viewHistory();
      // The runner reads this only after a successful test, then starts a new application.
      await writeFile(
        receiptPath,
        JSON.stringify({ workflowId: workflow.id, runId }),
      );
    },
  );
});
