import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { useStore } from 'zustand';

import zh from '@/locales/zh_CN.json';
import { createWorkflowStore } from '@/stores/workflow.store';

import { WorkflowNodeInspector } from './workflow-node-inspector';

it.each(['agent', 'codeact_agent'])(
  'shows the saved legacy %s label in the actual name input and allows editing',
  async (type) => {
    const original = {
      id: 'node',
      type,
      position: { x: 0, y: 0 },
      data: {
        name: '',
        label: '销售指标计算',
        instruction: 'Keep instruction',
        description: 'Keep description',
      },
    };
    const store = createWorkflowStore({
      nodes: [original],
      edges: [],
      settings: {
        name: 'Workflow',
        description: '',
        mode: 'task',
        inputSchema: { fields: [] },
      },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    });
    client.setQueryData(['tools'], []);
    client.setQueryData(['skills'], []);
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: 'zh_CN',
      resources: { zh_CN: { translation: zh } },
      interpolation: { escapeValue: false },
    });
    function Inspector() {
      const state = useStore(store);
      return (
        <WorkflowNodeInspector
          node={state.nodes[0]}
          executableNodes={state.nodes}
          onClose={vi.fn()}
          onDataChange={state.updateNodeData}
        />
      );
    }
    const screen = await render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <Inspector />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    const name = screen.getByRole('textbox', { name: '名称', exact: true });
    await expect.element(name).toHaveValue('销售指标计算');
    await name.fill('新的节点名称');
    expect(store.getState().nodes[0].data.name).toBe('新的节点名称');
    expect(store.getState().nodes[0].data.label).toBeUndefined();
    expect(store.getState().nodes[0].data.instruction).toBe('Keep instruction');
    expect(original.data.name).toBe('');
  },
);
