import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
} from '@workspace/ui/components/message-scroller';
import { expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';

function Scroller({ height = 500, viewportHeight = 200 }) {
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller style={{ width: 300, height: viewportHeight }}>
        <MessageScrollerViewport data-testid='viewport' tabIndex={0}>
          <MessageScrollerContent>
            <MessageScrollerItem messageId='agent'>
              <div style={{ height }}>Tool output</div>
            </MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

it('follows real content and viewport resizing while pinned to the bottom', async () => {
  const screen = await render(<Scroller />);
  const viewport = screen.getByTestId('viewport').element();
  const bottomDistance = () =>
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;

  expect(viewport.clientHeight).toBe(200);
  await expect.poll(() => viewport.scrollTop).toBeGreaterThan(0);
  await expect.poll(bottomDistance).toBeLessThanOrEqual(1);

  await screen.rerender(<Scroller height={580} />);
  await expect.poll(() => viewport.scrollHeight).toBe(580);
  await expect.poll(bottomDistance).toBeLessThanOrEqual(1);

  await screen.rerender(<Scroller height={580} viewportHeight={180} />);
  await expect.poll(() => viewport.clientHeight).toBe(180);
  await expect.poll(bottomDistance).toBeLessThanOrEqual(1);

  await screen.rerender(<Scroller height={540} viewportHeight={180} />);
  await expect.poll(() => viewport.scrollHeight).toBe(540);
  await expect.poll(bottomDistance).toBeLessThanOrEqual(1);
});

it('preserves the user scroll position when streamed content grows', async () => {
  const screen = await render(<Scroller height={1000} />);
  const locator = screen.getByTestId('viewport');
  const viewport = locator.element();
  await expect.poll(() => viewport.scrollTop).toBe(800);

  // Use browser input so the primitive sees user intent as well as native scroll events.
  await locator.click();
  await userEvent.keyboard('{PageUp}');
  await expect.poll(() => viewport.scrollTop).toBeLessThan(800);
  // Native keyboard scrolling animates; wait for a stable position before recording it.
  await new Promise<void>((resolve) => {
    let previous = viewport.scrollTop;
    let stableFrames = 0;
    const settle = () => {
      const current = viewport.scrollTop;
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 10) resolve();
      else requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  });
  const position = viewport.scrollTop;

  await screen.rerender(<Scroller height={1200} />);
  await expect.poll(() => viewport.scrollHeight).toBe(1200);
  // Allow real ResizeObserver and animation-frame corrections to finish before asserting.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  expect(viewport.scrollTop).toBeCloseTo(position, 0);
});
