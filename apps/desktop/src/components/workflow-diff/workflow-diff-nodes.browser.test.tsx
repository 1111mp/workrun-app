import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow, type Node } from '@xyflow/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import '@/styles/global.css';
import { workflowNodeTypes } from '@/components/nodes/node-types';
import zh from '@/locales/zh_CN.json';

import contracts from '../../../src-tauri/src/module/workflow/node-contracts.json';
import {
  NodeDiffContext,
  workflowDiffNodeTypes,
  type NodeDiffDecoration,
} from './workflow-diff-nodes';

vi.mock('@/services/cmd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/cmd')>()),
  getModelCatalog: vi.fn(async () => []),
}));
it('preserves every editor node color and handle layout while adding read-only diff markers and selection', async () => {
  const nodes: Node[] = Object.entries(contracts).map(
    ([type, contract], index) => ({
      ...contract.example,
      id: type,
      type,
      position: { x: (index % 4) * 340, y: Math.floor(index / 4) * 300 },
      ...(type === 'group' ? { style: { width: 280, height: 180 } } : {}),
    }),
  );
  const decorations = new Map<string, NodeDiffDecoration>(
    nodes.map((node, index) => [
      node.id,
      {
        status:
          index % 3 === 0 ? 'added' : index % 3 === 1 ? 'removed' : 'modified',
        label: '变更',
        fields: '名称',
      },
    ]),
  );
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'zh_CN',
    resources: { zh_CN: { translation: zh } },
    interpolation: { escapeValue: false },
  });
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <I18nextProvider i18n={i18n}>
        <div
          className='workrun-shell workrun-editor grid grid-cols-2 gap-4 p-4'
          style={{ height: 900 }}
        >
          <div data-testid='editor-canvas'>
            <ReactFlow
              defaultNodes={nodes}
              nodeTypes={workflowNodeTypes}
              fitView
            />
          </div>
          <div data-testid='diff-canvas'>
            <NodeDiffContext.Provider value={decorations}>
              <ReactFlow
                defaultNodes={nodes.map((node) => ({
                  ...node,
                  selected: true,
                }))}
                nodeTypes={workflowDiffNodeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                deleteKeyCode={null}
                fitView
              />
            </NodeDiffContext.Provider>
          </div>
        </div>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  await page.viewport(1920, 1000);
  const editor = screen.getByTestId('editor-canvas').element();
  const diff = screen.getByTestId('diff-canvas').element();
  await expect
    .poll(() => diff.querySelectorAll('.react-flow__node-toolbar').length)
    .toBe(nodes.length);
  for (const theme of ['light', 'dark']) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    for (const node of nodes) {
      const original = editor.querySelector(`[data-id="${node.id}"] > div`)!;
      const wrapper = diff.querySelector(`[data-id="${node.id}"] > div`)!;
      const actual = wrapper.firstElementChild!;
      for (const property of [
        'backgroundColor',
        'borderColor',
        'color',
      ] as const)
        expect(
          getComputedStyle(actual)[property],
          `${theme} ${node.id} ${property}`,
        ).toBe(getComputedStyle(original)[property]);
      expect(
        actual.querySelectorAll('.react-flow__handle').length,
        node.id,
      ).toBe(original.querySelectorAll('.react-flow__handle').length);
      expect(getComputedStyle(wrapper).backgroundColor).toBe(
        'rgba(0, 0, 0, 0)',
      );
      expect(getComputedStyle(wrapper).outlineWidth).toBe('3px');
    }
    expect(diff.querySelectorAll('.react-flow__resize-control')).toHaveLength(
      0,
    );
    expect(
      diff.querySelectorAll('.react-flow__handle.connectable'),
    ).toHaveLength(0);
    await page.screenshot({
      path: `.vitest/attachments/workflow-node-parity-${theme}.png`,
    });
  }
  document.documentElement.classList.remove('dark');
});
