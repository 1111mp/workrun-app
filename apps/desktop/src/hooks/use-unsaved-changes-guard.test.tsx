import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router';
import { expect, it, vi } from 'vitest';

import { ConfirmProvider } from '@/components/confirm-dialog';

import { useUnsavedChangesGuard } from './use-unsaved-changes-guard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function setup(
  dirty = true,
  options: Partial<Parameters<typeof useUnsavedChangesGuard>[0]> = {},
) {
  function Editor() {
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(dirty);
    const navigate = useNavigate();
    useUnsavedChangesGuard({ hasUnsavedChanges, ...options });
    return (
      <>
        <button onClick={() => setHasUnsavedChanges(false)}>Save</button>
        <button
          onClick={() => {
            setHasUnsavedChanges(false);
            void navigate('/workflows/saved', { replace: true });
          }}
        >
          Save new workflow
        </button>
      </>
    );
  }
  const router = createMemoryRouter(
    [
      { path: '/edit', element: <Editor /> },
      { path: '/other', element: <div>Other page</div> },
      { path: '/workflows/saved', element: <div>Saved workflow</div> },
    ],
    { initialEntries: ['/other', '/edit'], initialIndex: 1 },
  );
  render(
    <ConfirmProvider>
      <RouterProvider router={router} />
    </ConfirmProvider>,
  );
  return router;
}

it('keeps edits when navigation is cancelled, then permits the confirmed destination', async () => {
  const router = setup();
  await act(async () => {
    await router.navigate('/other');
  });
  expect(router.state.location.pathname).toBe('/edit');
  fireEvent.click(await screen.findByText('unsavedChanges.stay'));
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
  );
  expect(router.state.location.pathname).toBe('/edit');
  await act(async () => {
    await router.navigate('/other');
  });
  fireEvent.click(await screen.findByText('unsavedChanges.leave'));
  await screen.findByText('Other page');
  expect(router.state.location.pathname).toBe('/other');
});

it('blocks history back until confirmed', async () => {
  const router = setup();
  await act(async () => {
    await router.navigate(-1);
  });
  expect(router.state.location.pathname).toBe('/edit');
  fireEvent.click(await screen.findByText('unsavedChanges.leave'));
  await screen.findByText('Other page');
});

it('supports custom confirmation copy with defaults for omitted options', async () => {
  const router = setup(true, {
    title: 'Leave the form?',
    description: 'Your form changes will be lost.',
    confirmText: 'Leave form',
  });
  await act(async () => {
    await router.navigate('/other');
  });
  expect(await screen.findByRole('alertdialog')).toHaveAccessibleName(
    'Leave the form?',
  );
  expect(
    screen.getByText('Your form changes will be lost.'),
  ).toBeInTheDocument();
  expect(screen.getByText('unsavedChanges.stay')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Leave form'));
  await screen.findByText('Other page');
});

it('uses one confirmation for repeated navigation and follows the latest destination', async () => {
  const router = setup();
  await act(async () => {
    await router.navigate('/other');
  });
  await screen.findByRole('alertdialog');
  await act(async () => {
    await router.navigate('/workflows/saved');
  });
  expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  fireEvent.click(screen.getByText('unsavedChanges.leave'));
  await screen.findByText('Saved workflow');
  expect(router.state.location.pathname).toBe('/workflows/saved');
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
  );
});

it('allows a clean or read-only editor to leave without a prompt', async () => {
  const router = setup(false);
  await act(async () => {
    await router.navigate('/other');
  });
  await screen.findByText('Other page');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

it('stops prompting once edits are saved', async () => {
  const router = setup();
  fireEvent.click(screen.getByText('Save'));
  await act(async () => {
    await router.navigate('/other');
  });
  await screen.findByText('Other page');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

it('does not prompt for the navigation performed in the same update as saving', async () => {
  const router = setup();
  fireEvent.click(screen.getByText('Save new workflow'));
  await screen.findByText('Saved workflow');
  expect(router.state.location.pathname).toBe('/workflows/saved');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});
