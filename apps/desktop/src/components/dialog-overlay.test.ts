// @vitest-environment jsdom

import {
  Dialog,
  DialogContent,
  Drawer,
  DrawerContent,
} from '@workspace/ui/components';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

describe('DialogContent', () => {
  it('does not render its authored backdrop when nested by default', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          Drawer,
          { open: true, swipeDirection: 'right' },
          createElement(
            DrawerContent,
            undefined,
            createElement(
              Dialog,
              { open: true },
              createElement(DialogContent, undefined, 'Scheduled workflow'),
            ),
          ),
        ),
      );
    });

    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
  });

  it('renders a visible backdrop when nested inside a Drawer', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          Drawer,
          { open: true, swipeDirection: 'right' },
          createElement(
            DrawerContent,
            undefined,
            createElement(
              Dialog,
              { open: true },
              createElement(
                DialogContent,
                { forceOverlay: true },
                'Scheduled workflow',
              ),
            ),
          ),
        ),
      );
    });

    expect(
      document.querySelector('[data-slot="dialog-overlay"]'),
    ).not.toBeNull();
  });
});
