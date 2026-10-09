import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@workspace/ui/components';
// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { ArtifactFiles } from './artifact-files';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo='),
}));

afterEach(() => vi.unstubAllGlobals());

it('opens and closes a standalone attachment preview', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(ArtifactFiles, {
          value: {
            $type: 'artifact',
            id: 'one',
            version: 1,
            name: 'image.png',
            mimeType: 'image/png',
            size: 42,
          },
        }),
      );
    });
    const preview = container.querySelector<HTMLButtonElement>(
      'button[aria-label="workflowEditor.artifacts.preview"]',
    );
    expect(preview).not.toBeNull();
    await act(async () => preview!.click());
    expect(document.querySelector('.yarl__root')).not.toBeNull();
    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label="workflowEditor.artifacts.closePreview"]',
    );
    expect(close).not.toBeNull();
    await act(async () => close!.click());
    await act(async () => root.unmount());
    expect(document.querySelector('.yarl__root')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('opens a nested media preview and closes it without dismissing the review', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const onReviewClose = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(
          AlertDialog,
          {
            open: true,
            onOpenChange: onReviewClose,
          },
          createElement(
            AlertDialogContent,
            null,
            createElement(AlertDialogTitle, null, 'Review'),
            createElement(
              AlertDialogDescription,
              null,
              'Inspect the attachment',
            ),
            createElement(ArtifactFiles, {
              modalPreview: true,
              value: {
                $type: 'artifact',
                id: 'one',
                version: 1,
                name: 'image.png',
                mimeType: 'image/png',
                size: 42,
              },
            }),
          ),
        ),
      );
    });
    const preview = document.querySelector<HTMLButtonElement>(
      'button[aria-label="workflowEditor.artifacts.preview"]',
    );
    expect(preview).not.toBeNull();
    await act(async () => {
      preview!.click();
    });
    const childDialog = document.querySelector('[data-slot="dialog-content"]');
    expect(childDialog?.querySelector('.yarl__root')).not.toBeNull();
    const close = childDialog?.querySelector<HTMLButtonElement>(
      'button[aria-label="workflowEditor.artifacts.closePreview"]',
    );
    expect(close).not.toBeNull();
    await act(async () => {
      close!.click();
    });
    expect(onReviewClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}, 15_000);
