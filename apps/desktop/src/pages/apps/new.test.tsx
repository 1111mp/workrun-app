import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { toast } from 'sonner';
import { expect, it, vi } from 'vitest';

import {
  createProcessNode,
  createTeamProcessNodeDraft,
  type ProcessNode,
} from '@/services/process-node';

import { Component as CreateAppPage } from './new';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/constant', () => ({ isTeamMode: () => true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/services/process-node', () => ({
  getProcessNodeDefaultRoot: vi
    .fn()
    .mockResolvedValue('/account/process-nodes'),
  createProcessNode: vi.fn(),
  createTeamProcessNodeDraft: vi
    .fn()
    .mockRejectedValue(new Error('Team server unavailable')),
  updateProcessNode: vi.fn(),
}));

it('creates a local Team App and opens it without contacting the Team server', async () => {
  vi.mocked(createProcessNode).mockResolvedValue({
    definition: { id: 'local-app', publicationStatus: 'draft' },
  } as ProcessNode);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/apps/new']}>
        <Routes>
          <Route path='/apps/new' element={<CreateAppPage />} />
          <Route path='/apps/local-app' element={<p>Local app editor</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  try {
    fireEvent.change(screen.getByLabelText('apps.new.name'), {
      target: { value: '订单查询' },
    });
    fireEvent.submit(ui.container.querySelector('form')!);
    await screen.findByText('Local app editor');
    expect(createProcessNode).toHaveBeenCalledWith(
      expect.objectContaining({ name: '订单查询' }),
      expect.any(Function),
    );
    expect(createTeamProcessNodeDraft).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
    client.clear();
  }
});
