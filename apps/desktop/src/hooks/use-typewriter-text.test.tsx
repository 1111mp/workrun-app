import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useTypewriterText } from './use-typewriter-text';

let now = 0;
let nextId = 0;
let frames = new Map<number, FrameRequestCallback>();
let reduced = false;
const visibility = Object.getOwnPropertyDescriptor(document, 'hidden');

beforeEach(() => {
  now = 0;
  nextId = 0;
  frames = new Map();
  reduced = false;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: false,
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('matchMedia', () => ({
    matches: reduced,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (visibility) Object.defineProperty(document, 'hidden', visibility);
  else delete (document as { hidden?: boolean }).hidden;
});
function advance(count: number) {
  act(() => {
    for (let index = 0; index < count; index++) {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(now));
    }
  });
}

it('reveals a large chunk progressively and finishes the buffer after streaming ends', () => {
  const text = '这是一个分段到达、需要平滑逐字显示的回复。'.repeat(4);
  const { result, rerender } = renderHook(
    ({ value, live }) => useTypewriterText(value, live),
    { initialProps: { value: text, live: true } },
  );
  expect(result.current).toBe('');
  advance(3);
  expect(result.current.length).toBeGreaterThan(0);
  expect(result.current.length).toBeLessThan(text.length);
  const prefix = result.current;
  rerender({ value: `${text}完成。`, live: false });
  expect(result.current).toBe(prefix);
  advance(150);
  expect(result.current).toBe(`${text}完成。`);
  expect(frames.size).toBe(0);
});

it('does not replay saved history', () => {
  const { result } = renderHook(() => useTypewriterText('历史消息', false));
  expect(result.current).toBe('历史消息');
  expect(frames.size).toBe(0);
});

it('never reveals half of an emoji or a combining character', () => {
  const emoji = '👨‍👩‍👧‍👦';
  const accented = 'e\u0301';
  const { result } = renderHook(() =>
    useTypewriterText(`${emoji}${accented}`, true),
  );
  for (let index = 0; index < 10; index++) {
    advance(1);
    expect(['', emoji, `${emoji}${accented}`]).toContain(result.current);
  }
  expect(result.current).toBe(`${emoji}${accented}`);
});

it('shows the complete response when reduced motion is enabled and cancels frames on unmount', () => {
  reduced = true;
  const { result, unmount } = renderHook(() =>
    useTypewriterText('不要播放逐字动画', true),
  );
  advance(1);
  expect(result.current).toBe('不要播放逐字动画');
  unmount();
  expect(frames.size).toBe(0);
  reduced = false;
  const pending = renderHook(() =>
    useTypewriterText('未完成的回复'.repeat(100), true),
  );
  expect(frames.size).toBe(1);
  pending.unmount();
  expect(frames.size).toBe(0);
});
