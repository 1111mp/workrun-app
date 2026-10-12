// @vitest-environment jsdom
import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
} from '@workspace/ui/components/message-scroller';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it('compensates content growth before the resize paint and preserves manual scroll position', async () => {
  let contentHeight = 500;
  let viewportHeight = 200;
  const observers = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        observers.set(element, this.callback);
      }
      disconnect() {}
      unobserve() {}
    },
  );
  const frames = new Map<number, FrameRequestCallback>();
  let frame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frame, callback);
    return frame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const host = document.createElement('div');
  document.body.append(host);
  let viewport: HTMLElement | null = null;
  const clientHeight = vi
    .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
    .mockImplementation(() => viewportHeight);
  const scrollHeight = vi
    .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
    .mockImplementation(() => contentHeight);
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.messageId ? -(viewport?.scrollTop ?? 0) : 0;
      const height = this.dataset.messageId ? contentHeight : viewportHeight;
      return {
        x: 0,
        y: top,
        top,
        bottom: top + height,
        left: 0,
        right: 300,
        width: 300,
        height,
        toJSON() {},
      };
    });
  const scrollTo = vi.fn(function (
    this: HTMLElement,
    options: ScrollToOptions,
  ) {
    this.scrollTop = options.top ?? 0;
  });
  vi.stubGlobal('scrollTo', vi.fn());
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollTo',
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: scrollTo,
  });
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(
          MessageScrollerProvider,
          { autoScroll: true },
          createElement(
            MessageScroller,
            null,
            createElement(
              MessageScrollerViewport,
              {
                ref: (element: HTMLDivElement | null) => {
                  viewport = element;
                },
              },
              createElement(
                MessageScrollerContent,
                { id: 'timing-content' },
                createElement(
                  MessageScrollerItem,
                  { messageId: 'agent' },
                  'Tool output',
                ),
              ),
            ),
          ),
        ),
      ),
    );
    const content = host.querySelector('#timing-content')!;
    const resize = observers.get(content)!;
    expect(resize).toBeDefined();
    expect(viewport!.scrollTop).toBe(300);

    // ResizeObserver runs before paint. Deferring its scroll correction to
    // another animation frame exposes the displaced timeline for one frame.
    contentHeight += 80;
    await act(async () => resize([], {} as ResizeObserver));
    expect(viewport!.scrollTop).toBe(380);
    viewportHeight = 180;
    await act(async () => observers.get(viewport!)!([], {} as ResizeObserver));
    expect(viewport!.scrollTop).toBe(400);
    contentHeight -= 40;
    await act(async () => resize([], {} as ResizeObserver));
    expect(viewport!.scrollTop).toBe(360);

    // Tool output is inserted inside an existing row, not as a new timeline
    // item. It must follow before RAF/ResizeObserver rather than one frame later.
    const toolResult = document.createElement('span');
    toolResult.textContent = 'Tool result';
    contentHeight += 60;
    await act(async () => content.firstElementChild!.append(toolResult));
    expect(viewport!.scrollTop).toBe(420);
    contentHeight += 20;
    await act(async () => {
      toolResult.firstChild!.nodeValue += ' streamed text';
    });
    expect(viewport!.scrollTop).toBe(440);

    await act(async () => {
      viewport!.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, bubbles: true }),
      );
      viewport!.scrollTop = 100;
      viewport!.dispatchEvent(new Event('scroll'));
    });
    contentHeight += 80;
    await act(async () => resize([], {} as ResizeObserver));
    expect(viewport!.scrollTop).toBe(100);
    contentHeight += 60;
    await act(async () =>
      content.firstElementChild!.append(document.createElement('span')),
    );
    expect(viewport!.scrollTop).toBe(100);
  } finally {
    await act(async () => root.unmount());
    clientHeight.mockRestore();
    scrollHeight.mockRestore();
    rect.mockRestore();
    if (original)
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', original);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    vi.unstubAllGlobals();
    host.remove();
  }
});
