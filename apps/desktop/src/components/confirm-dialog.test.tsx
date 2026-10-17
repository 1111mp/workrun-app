import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useEffect } from 'react';
import { expect, it, vi } from 'vitest';

import { useConfirm } from '@/lib/confirm-context';

import { ConfirmProvider } from './confirm-dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function setup() {
  let confirm!: ReturnType<typeof useConfirm>;
  function Consumer() {
    const requestConfirmation = useConfirm();
    useEffect(() => {
      confirm = requestConfirmation;
    }, [requestConfirmation]);
    return null;
  }
  const view = render(
    <ConfirmProvider>
      <Consumer />
    </ConfirmProvider>,
  );
  return { ...view, confirm };
}

it('preserves the boolean API for confirming and cancelling', async () => {
  const { confirm } = setup();
  let result!: Promise<boolean>;
  act(() => {
    result = confirm({ title: 'Delete item' });
  });
  expect(await screen.findByRole('alertdialog')).toHaveAccessibleName(
    'Delete item',
  );
  fireEvent.click(screen.getByText('confirm.confirm'));
  await expect(result).resolves.toBe(true);
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
  );
  act(() => {
    result = confirm({});
  });
  fireEvent.click(await screen.findByText('confirm.cancel'));
  await expect(result).resolves.toBe(false);
});

it('keeps asynchronous actions open, blocks cancellation and repeated confirmation', async () => {
  const { confirm } = setup();
  let finish!: () => void;
  const onConfirm = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  let result!: Promise<boolean>;
  act(() => {
    result = confirm({ onConfirm });
  });
  fireEvent.click(await screen.findByText('confirm.confirm'));
  expect(screen.getByText('confirm.confirm')).toBeDisabled();
  expect(screen.getByText('confirm.cancel')).toBeDisabled();
  fireEvent.click(screen.getByText('confirm.confirm'));
  fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  await act(async () => {
    finish();
  });
  await expect(result).resolves.toBe(true);
});

it('shows failures and lets the user retry without resolving early', async () => {
  const { confirm } = setup();
  const onConfirm = vi
    .fn()
    .mockRejectedValueOnce(new Error('Restart failed'))
    .mockResolvedValueOnce(undefined);
  const resolved = vi.fn();
  let result!: Promise<boolean>;
  act(() => {
    result = confirm({ onConfirm });
    void result.then(resolved);
  });
  fireEvent.click(await screen.findByText('confirm.confirm'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Restart failed');
  expect(resolved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('confirm.confirm'));
  await expect(result).resolves.toBe(true);
  expect(onConfirm).toHaveBeenCalledTimes(2);
});

it('shows concurrent requests in order and resolves each independently', async () => {
  const { confirm } = setup();
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  act(() => {
    first = confirm({ title: 'First request' });
    second = confirm({ title: 'Second request' });
  });
  expect(await screen.findByRole('alertdialog')).toHaveAccessibleName(
    'First request',
  );
  fireEvent.click(screen.getByText('confirm.confirm'));
  await expect(first).resolves.toBe(true);
  await waitFor(() =>
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName(
      'Second request',
    ),
  );
  fireEvent.click(screen.getByText('confirm.cancel'));
  await expect(second).resolves.toBe(false);
});

it('resolves active and queued requests when the provider unmounts', async () => {
  const { confirm, unmount } = setup();
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  act(() => {
    first = confirm({});
    second = confirm({});
  });
  unmount();
  await expect(first).resolves.toBe(false);
  await expect(second).resolves.toBe(false);
  await expect(confirm({})).resolves.toBe(false);
});

it('dismisses with Escape as cancellation', async () => {
  const { confirm } = setup();
  let result!: Promise<boolean>;
  act(() => {
    result = confirm({});
  });
  fireEvent.keyDown(await screen.findByRole('alertdialog'), { key: 'Escape' });
  await expect(result).resolves.toBe(false);
});
