import { beforeEach, expect, it, vi } from 'vitest';

const imports = vi.hoisted(() => ({ detail: vi.fn(), create: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.doMock('@/pages/workflow', () => imports.detail());
  vi.doMock('@/pages/workflows/new', () => imports.create());
});

it('shares hovered detail and creation imports with route loading', async () => {
  imports.detail.mockResolvedValue({ Component: () => null });
  imports.create.mockResolvedValue({ Component: () => null });
  const loader = await import('./workflow-page-loader');
  expect(imports.detail).not.toHaveBeenCalled();
  expect(imports.create).not.toHaveBeenCalled();
  loader.preloadWorkflowPage();
  loader.preloadWorkflowPage(true);
  const detail = loader.loadWorkflowPage();
  expect(loader.loadWorkflowPage()).toBe(detail);
  const create = loader.loadNewWorkflowPage();
  expect(loader.loadNewWorkflowPage()).toBe(create);
  await Promise.all([detail, create]);
  expect(imports.detail).toHaveBeenCalledTimes(1);
  expect(imports.create).toHaveBeenCalledTimes(1);
});

it('handles speculative failures and permits a subsequent route load attempt', async () => {
  imports.detail.mockRejectedValueOnce(new Error('module unavailable'));
  const loader = await import('./workflow-page-loader');
  loader.preloadWorkflowPage();
  const first = loader.loadWorkflowPage();
  await expect(first).rejects.toThrow();
  // The next navigation receives a fresh import attempt, rather than the
  // rejected promise retained by the speculative loader.
  vi.doMock('@/pages/workflow', () => ({ Component: () => null }));
  const retry = loader.loadWorkflowPage();
  expect(retry).not.toBe(first);
  await expect(retry).resolves.toHaveProperty('default');
});
