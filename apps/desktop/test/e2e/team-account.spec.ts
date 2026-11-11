import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { browser, expect } from '@wdio/globals';

// Use existing scheduled-workflow preparation: fetch the published Workflow,
// download its Process App, prepare Python, then dispatch through the supervisor.
describe('Team account storage', () => {
  it('isolates account data and preserves the existing resource preparation and execution flow', async () => {
    const source = await mkdtemp(join(tmpdir(), 'workrun-account-source-'));
    await writeFile(
      join(source, 'pyproject.toml'),
      '[project]\nname="account-echo"\nversion="1.0.0"\nrequires-python=">=3.12"\ndependencies=["workrun-sdk==0.1.0"]\n[tool.uv]\nno-index=true\n',
    );
    await writeFile(
      join(source, 'main.py'),
      'import json,sys\nfrom workrun_sdk import process\nstate=json.load(sys.stdin)\nprocess.result({"message":"account-result:"+state["message"]})\n',
    );
    await writeFile(
      join(source, 'tool_main.py'),
      'from workrun_sdk.tool import tool\n@tool\ndef lookup(message: str) -> dict:\n    return {"message":"tool-result:"+message}\n',
    );
    const archivePath = join(source, 'app.tar.gz');
    execFileSync('tar', [
      '-czf',
      archivePath,
      '-C',
      source,
      'pyproject.toml',
      'main.py',
      'tool_main.py',
    ]);
    const archive = await readFile(archivePath);
    const sha = createHash('sha256').update(archive).digest('hex');
    const appId = randomUUID();
    const workflowId = randomUUID();
    const releaseId = randomUUID();
    const appReleaseId = randomUUID();
    const app = {
      id: appId,
      name: 'Account echo',
      version: '1.0.0',
      kind: 'workflow',
      entry: 'main.py',
      inputs: { message: { type: 'string' } },
      outputs: { message: { type: 'string' } },
    };
    const toolId = randomUUID();
    const toolReleaseId = randomUUID();
    const toolWorkflowId = randomUUID();
    const toolWorkflowReleaseId = randomUUID();
    let toolDownloads = 0;
    let modelId = '';
    const toolApp = {
      ...app,
      id: toolId,
      name: 'Order lookup',
      kind: 'tool',
      entry: 'tool_main.py',
      toolExecutionPolicy: 'auto',
      archiveSha256: sha,
      catalogVersionId: toolReleaseId,
    };
    const toolDocument = () => ({
      ...document,
      settings: { ...document.settings, name: 'Team Agent Tool' },
      nodes: [
        document.nodes[0],
        {
          id: 'lookup-agent',
          type: 'agent',
          position: { x: 200, y: 0 },
          data: {
            name: 'Order lookup',
            modelProfileId: modelId,
            instruction: 'Call the lookup tool once, then return its result.',
            toolIds: [toolId],
            maxToolCalls: 2,
          },
        },
        document.nodes[2],
      ],
      edges: [
        { id: 'one', source: 'start', target: 'lookup-agent' },
        { id: 'two', source: 'lookup-agent', target: 'end' },
      ],
    });
    const document = {
      settings: {
        name: 'Account workflow',
        description: '',
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
          position: { x: 200, y: 0 },
          data: {
            name: 'Echo',
            processNodeId: appId,
            appRef: {
              source: 'team',
              remoteAppId: appId,
              releaseId: appReleaseId,
              version: '1.0.0',
              archiveSha256: sha,
            },
            state: { globalKeys: ['message'] },
          },
        },
        { id: 'end', type: 'end', position: { x: 400, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'one', source: 'start', target: 'echo' },
        { id: 'two', source: 'echo', target: 'end' },
      ],
    };
    let downloads = 0;
    const server = createServer((request, response) => {
      const path = request.url ?? '';
      const json = (payload: unknown) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ errorCode: 0, payload }));
      };
      if (path === '/api/v1/llm/models') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'fixture',
                name: 'Fixture',
                apiProtocols: ['chat_completions'],
                capabilities: { tools: true },
              },
            ],
          }),
        );
        return;
      }
      if (path === '/api/v1/llm/chat/completions') {
        let body = '';
        request.on('data', (chunk) => {
          body += String(chunk);
        });
        request.on('end', () => {
          const payload = JSON.parse(body) as {
            stream?: boolean;
            messages: Array<{ role: string }>;
            tools: Array<{ function: { name: string } }>;
          };
          const hasResult = payload.messages.some(
            (message) => message.role === 'tool',
          );
          const message = hasResult
            ? { role: 'assistant', content: 'tool-completed' }
            : {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: 'lookup-call',
                    type: 'function',
                    function: {
                      name: payload.tools.find((item) =>
                        item.function.name.startsWith('process_'),
                      )!.function.name,
                      arguments: JSON.stringify({ message: 'bob' }),
                    },
                  },
                ],
              };
          const finish = hasResult ? 'stop' : 'tool_calls';
          if (payload.stream) {
            response.setHeader('Content-Type', 'text/event-stream');
            response.end(
              `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: message, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
            );
          } else {
            response.setHeader('Content-Type', 'application/json');
            response.end(
              JSON.stringify({
                id: 'fixture',
                object: 'chat.completion',
                model: 'fixture',
                choices: [{ index: 0, message, finish_reason: finish }],
              }),
            );
          }
        });
        return;
      }
      if (path === `/api/v1/workflow/team/${toolWorkflowId}`)
        return json({
          id: toolWorkflowId,
          releaseId: toolWorkflowReleaseId,
          version: '1.0.0',
          document: toolDocument(),
        });
      if (
        path === `/api/v1/app/catalog/${toolId}` ||
        path === `/api/v1/app/catalog/${toolId}/releases/${toolReleaseId}`
      )
        return json(toolApp);
      if (
        path ===
        `/api/v1/app/catalog/${toolId}/releases/${toolReleaseId}/source-archive`
      ) {
        toolDownloads += 1;
        response.setHeader('x-workrun-sha256', sha);
        response.end(archive);
        return;
      }
      if (path === '/api/v1/users/me')
        return json({
          user: {
            id: request.headers.authorization?.slice(7),
            name: 'Fixture user',
          },
        });
      if (path === `/api/v1/workflow/team/${workflowId}`)
        return json({ id: workflowId, releaseId, version: '1.0.0', document });
      if (path.endsWith('/source-archive')) {
        downloads += 1;
        response.setHeader('x-workrun-sha256', sha);
        response.end(archive);
        return;
      }
      if (path === `/api/v1/app/catalog/${appId}/releases/${appReleaseId}`)
        return json(app);
      response.statusCode = 404;
      response.end('Unexpected fixture request');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    modelId = `team/${createHash('sha256').update(base).digest('hex')}/chat_completions/fixture`;
    const invoke = <T>(command: string, args: Record<string, unknown> = {}) =>
      browser.tauri.execute(
        ({ core }, input) =>
          core.invoke(input.command, input.args) as Promise<T>,
        { command, args },
      );
    try {
      await expect(invoke('run_history_list_active')).rejects.toBeDefined();
      await invoke('patch_workrun_config', {
        payload: {
          workspace_mode: 'team',
          onboarding_completed: false,
          team: { server_url: base },
        },
      });
      const login = (token: string | null) =>
        invoke('schedule_set_team_session', { serverUrl: base, token });
      await login('alice');
      await browser.waitUntil(async () => {
        try {
          await invoke('run_history_list_active');
          return true;
        } catch {
          return false;
        }
      });
      const authored = await browser.tauri.execute(
        ({ core }) =>
          core.invoke('create_process_node', {
            request: { name: 'Local authoring', description: '', kind: 'tool' },
            progress: '__CHANNEL__:0',
          }) as Promise<{ definition: Record<string, unknown> }>,
      );
      const authoringRemoteId = randomUUID();
      await invoke('update_process_node', {
        definition: { ...authored.definition, remoteAppId: authoringRemoteId },
      });
      const savedFromOldEditor = await invoke<{
        definition: { remoteAppId: string };
      }>('update_process_node', {
        definition: {
          ...authored.definition,
          description: 'Saved after publication',
        },
      });
      expect(savedFromOldEditor.definition.remoteAppId).toBe(authoringRemoteId);
      const accountKey = createHash('sha256')
        .update(JSON.stringify([base, 'alice']))
        .digest('hex');
      const authoringRoot = join(
        process.env.WORKRUN_E2E_DATA_DIR!,
        'team',
        accountKey,
        'process-nodes',
      );
      const interruptedCreation = invoke('create_process_node', {
        request: {
          name: 'Switch during creation',
          description: '',
          kind: 'tool',
        },
        progress: '__CHANNEL__:0',
      }).then(
        () => null,
        (error: unknown) => String(error),
      );
      await browser.waitUntil(
        async () =>
          (await readdir(authoringRoot)).filter((name) =>
            /^[0-9a-f-]{36}$/.test(name),
          ).length > 1,
        { interval: 10 },
      );
      await login('bob');
      // A switch may interrupt environment setup before the catalog guard.
      expect(await interruptedCreation).not.toBeNull();
      expect(await invoke('get_process_nodes')).toEqual([]);
      expect(
        (await readdir(authoringRoot)).filter((name) =>
          /^[0-9a-f-]{36}$/.test(name),
        ),
      ).toEqual([authored.definition.id]);
      await login('alice');
      const chatId = randomUUID();
      await invoke('chat_session_create', {
        request: { id: chatId, workflowId, workflowSnapshot: { document } },
      });
      // Team has no local editing stashes; keep the existing restriction.
      await expect(
        invoke('save_workflow_edit_draft', { workflowId, document }),
      ).rejects.toBeDefined();
      const suiteId = randomUUID();
      await invoke('evaluation_suite_create', {
        request: { id: suiteId, workflowId, name: 'Alice evaluation' },
      });
      await invoke('model_usage_session', {
        kind: 'workflow_chat',
        id: chatId,
      });
      await invoke('patch_workrun_config', {
        payload: {
          provider_credentials: [
            { provider: 'open_ai', apiKey: 'alice-fixture-secret' },
          ],
        },
      });
      const credential = await invoke<{ id: string }>(
        'remote_credential_save',
        {
          payload: {
            name: 'Alice agent',
            kind: 'bearer',
            serviceUrl: base,
            secret: 'alice-agent-fixture',
          },
        },
      );
      const schedule = await invoke<{ id: string }>('workflow_schedule_save', {
        request: {
          name: 'Alice schedule',
          targetId: workflowId,
          targetName: 'Account workflow',
          targetSnapshot: document,
          cronExpression: '* * * * *',
          timezone: 'UTC',
          enabled: true,
          source: { kind: 'latest_published' },
          input: { message: 'alice' },
          initialState: { message: 'alice' },
        },
      });
      await browser.waitUntil(async () => downloads > 0, {
        timeout: 75000,
        timeoutMsg: 'Published workflow did not download its Process App',
      });
      await invoke('schedule_set_enabled', { id: schedule.id, enabled: false });
      let runId = '';
      await browser.waitUntil(
        async () => {
          const page = await invoke<{
            items: Array<{ id: string; status: string; error?: string }>;
          }>('run_history_list', { query: { targetId: workflowId } });
          const run = page.items[0];
          if (run?.status === 'failed') throw new Error(run.error);
          runId = run?.id ?? '';
          return run?.status === 'completed';
        },
        { timeout: 180000, timeoutMsg: 'Prepared Process App did not execute' },
      );
      const run = await invoke<{ lastSequence: number }>(
        'run_history_inspect',
        { id: runId },
      );
      const events = await invoke('run_history_events_page', {
        id: runId,
        after: -1,
        through: run.lastSequence,
      });
      expect(JSON.stringify(events)).toContain('account-result:alice');
      const coordinates = {
        remoteAppId: appId,
        releaseId: appReleaseId,
        installationScope: `release-${releaseId}`,
      };
      const aliceApp = await invoke<{
        definition: { id: string };
        projectPath: string;
      }>('process_node_find_team_release', coordinates);
      expect(aliceApp.projectPath).toContain('/team/');
      await login(null);
      await expect(invoke('run_history_list_active')).rejects.toBeDefined();
      await login('bob');
      expect(await invoke('chat_session_list_history', { workflowId })).toEqual(
        [],
      );
      await expect(
        invoke('chat_session_get', { id: chatId }),
      ).rejects.toBeDefined();
      await expect(
        invoke('run_history_inspect', { id: runId }),
      ).rejects.toBeDefined();
      await expect(
        invoke('get_workflow_edit_draft', { workflowId }),
      ).rejects.toBeDefined();
      expect(await invoke('evaluation_suite_list', { workflowId })).toEqual([]);
      await expect(
        invoke('evaluation_suite_delete', { id: suiteId }),
      ).rejects.toBeDefined();
      await expect(
        invoke('model_usage_session', { kind: 'workflow_chat', id: chatId }),
      ).rejects.toBeDefined();
      expect(
        (
          await invoke<{ items: unknown[] }>('run_history_list', {
            query: { targetId: workflowId },
          })
        ).items,
      ).toEqual([]);
      expect(await invoke('workflow_schedule_list', { workflowId })).toEqual(
        [],
      );
      await expect(
        invoke('schedule_delete', { id: schedule.id }),
      ).rejects.toBeDefined();
      expect(
        await invoke('process_node_find_team_release', coordinates),
      ).toBeNull();
      expect(
        (
          await invoke<{ provider_credentials: unknown[] }>(
            'get_workrun_config',
          )
        ).provider_credentials,
      ).toEqual([]);
      expect(await invoke('remote_credentials_list')).toEqual([]);
      await expect(
        invoke('remote_credential_save', {
          payload: {
            id: credential.id,
            name: 'overwrite',
            kind: 'bearer',
            serviceUrl: base,
            secret: 'bob',
          },
        }),
      ).rejects.toBeDefined();
      await expect(
        invoke('get_process_node', { id: toolId }),
      ).rejects.toBeDefined();
      const toolSchedule = await invoke<{ id: string }>(
        'workflow_schedule_save',
        {
          request: {
            name: 'Bob Tool workflow',
            targetId: toolWorkflowId,
            targetName: 'Team Agent Tool',
            targetSnapshot: toolDocument(),
            cronExpression: '* * * * *',
            timezone: 'UTC',
            enabled: true,
            source: { kind: 'latest_published' },
            input: { message: 'bob' },
            initialState: { message: 'bob' },
          },
        },
      );
      await browser.waitUntil(async () => toolDownloads > 0, {
        timeout: 75000,
        timeoutMsg:
          'First run in another account did not download the Agent Tool',
      });
      await invoke('schedule_set_enabled', {
        id: toolSchedule.id,
        enabled: false,
      });
      let toolRunId = '';
      await browser.waitUntil(
        async () => {
          const history = await invoke<{
            items: Array<{ id: string; status: string; error?: string }>;
          }>('run_history_list', { query: { targetId: toolWorkflowId } });
          const latest = history.items[0];
          if (latest?.status === 'failed') throw new Error(latest.error);
          toolRunId = latest?.id ?? '';
          return latest?.status === 'completed';
        },
        {
          timeout: 90000,
          timeoutMsg: 'Agent did not execute the downloaded Tool',
        },
      );
      const installedTool = await invoke<{
        definition: { id: string };
        projectPath: string;
      }>('get_process_node', { id: toolId });
      expect(installedTool.definition.id).toBe(toolId);
      const bobKey = createHash('sha256')
        .update(JSON.stringify([base, 'bob']))
        .digest('hex');
      expect(installedTool.projectPath).toContain(`/team/${bobKey}/`);
      const toolRun = await invoke<{ lastSequence: number }>(
        'run_history_inspect',
        { id: toolRunId },
      );
      const toolEvents = await invoke('run_history_events_page', {
        id: toolRunId,
        after: -1,
        through: toolRun.lastSequence,
      });
      expect(JSON.stringify(toolEvents)).toContain('tool-result:bob');
      expect(toolDownloads).toBe(1);
      await login('alice');
      await expect(
        invoke('get_process_node', { id: toolId }),
      ).rejects.toBeDefined();
      await expect(
        invoke('get_workflow_edit_draft', { workflowId }),
      ).rejects.toBeDefined();
      expect(
        (
          await invoke<Array<{ id: string }>>('evaluation_suite_list', {
            workflowId,
          })
        )[0]?.id,
      ).toBe(suiteId);
      await invoke('model_usage_session', {
        kind: 'workflow_chat',
        id: chatId,
      });
      expect(
        (await invoke<unknown[]>('chat_session_list_history', { workflowId }))
          .length,
      ).toBe(1);
      expect(
        (await invoke<{ status: string }>('run_history_inspect', { id: runId }))
          .status,
      ).toBe('completed');
      expect(
        (
          await invoke<{ definition: { id: string } }>(
            'process_node_find_team_release',
            coordinates,
          )
        ).definition.id,
      ).toBe(aliceApp.definition.id);
      expect(
        (
          await invoke<{ provider_credentials: unknown[] }>(
            'get_workrun_config',
          )
        ).provider_credentials.length,
      ).toBe(1);
      expect(
        (await invoke<Array<{ id: string }>>('remote_credentials_list'))[0]!.id,
      ).toBe(credential.id);
      expect(downloads).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
