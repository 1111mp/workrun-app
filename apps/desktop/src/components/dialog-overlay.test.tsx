import { render } from '@testing-library/react';
import {
  Dialog,
  DialogContent,
  Drawer,
  DrawerContent,
} from '@workspace/ui/components';
import { describe, expect, it } from 'vitest';

describe('DialogContent', () => {
  it('does not render its authored backdrop when nested by default', () => {
    render(
      <Drawer open swipeDirection='right'>
        <DrawerContent>
          <Dialog open>
            <DialogContent>Scheduled workflow</DialogContent>
          </Dialog>
        </DrawerContent>
      </Drawer>,
    );
    // Backdrop ownership is structural, so inspect its slot rather than dialog text.
    expect(
      document.querySelector('[data-slot="dialog-overlay"]'),
    ).not.toBeInTheDocument();
  });
  it('renders a visible backdrop when nested inside a Drawer', () => {
    render(
      <Drawer open swipeDirection='right'>
        <DrawerContent>
          <Dialog open>
            <DialogContent forceOverlay>Scheduled workflow</DialogContent>
          </Dialog>
        </DrawerContent>
      </Drawer>,
    );
    expect(
      document.querySelector('[data-slot="dialog-overlay"]'),
    ).toBeInTheDocument();
  });
});
