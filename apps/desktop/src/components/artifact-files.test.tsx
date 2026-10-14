import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@workspace/ui/components';
import { expect, it, vi } from 'vitest';

import { ArtifactFiles } from './artifact-files';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo='),
}));
const attachment = {
  $type: 'artifact',
  id: 'one',
  version: 1,
  name: 'image.png',
  mimeType: 'image/png',
  size: 42,
};

it('opens and closes a standalone attachment preview', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<ArtifactFiles value={attachment} />);
  await user.click(
    screen.getByRole('button', { name: 'workflowEditor.artifacts.preview' }),
  );
  await waitFor(() =>
    expect(document.querySelector('.yarl__root')).toBeInTheDocument(),
  );
  await user.click(
    await screen.findByRole('button', {
      name: 'workflowEditor.artifacts.closePreview',
    }),
  );
  await waitFor(() =>
    expect(document.querySelector('.yarl__root')).not.toBeInTheDocument(),
  );
  unmount();
  expect(document.querySelector('.yarl__root')).not.toBeInTheDocument();
});

it('opens a nested media preview and closes it without dismissing the review', async () => {
  const user = userEvent.setup();
  const onReviewClose = vi.fn();
  render(
    <AlertDialog open onOpenChange={onReviewClose}>
      <AlertDialogContent>
        <AlertDialogTitle>Review</AlertDialogTitle>
        <AlertDialogDescription>Inspect the attachment</AlertDialogDescription>
        <ArtifactFiles modalPreview value={attachment} />
      </AlertDialogContent>
    </AlertDialog>,
  );
  await user.click(
    screen.getByRole('button', { name: 'workflowEditor.artifacts.preview' }),
  );
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="dialog-content"] .yarl__root'),
    ).toBeInTheDocument(),
  );
  await user.click(
    await screen.findByRole('button', {
      name: 'workflowEditor.artifacts.closePreview',
    }),
  );
  expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  expect(onReviewClose).not.toHaveBeenCalled();
}, 15000);
