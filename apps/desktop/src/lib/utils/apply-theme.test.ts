import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyTheme } from './apply-theme';

vi.mock('@/services/api', () => ({ setWebviewWindowTheme: vi.fn() }));
vi.mock('@/services/cmd', () => ({ getSystemTheme: vi.fn() }));

let classes: Set<string>;
let root: {
  classList: {
    contains: (value: string) => boolean;
    remove: (...values: string[]) => void;
    add: (value: string) => void;
  };
  style: { colorScheme: string };
};

beforeEach(() => {
  classes = new Set(['light']);
  root = {
    classList: {
      contains: (value) => classes.has(value),
      remove: (...values) => values.forEach((value) => classes.delete(value)),
      add: (value) => {
        classes.add(value);
      },
    },
    style: { colorScheme: 'light' },
  };
  const document = { documentElement: root };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', { document });
});

afterEach(() => vi.unstubAllGlobals());

function transitions() {
  const callbacks: (() => void)[] = [];
  const start = vi.fn((callback: () => void) => {
    callbacks.push(callback);
    return { ready: Promise.resolve() };
  });
  Object.assign(document, { startViewTransition: start });
  return { callbacks, start };
}

describe('theme view transitions', () => {
  it('handles aborted animation readiness while still applying the theme', async () => {
    const aborted = new DOMException(
      'Old view transition aborted by new view transition.',
      'AbortError',
    );
    Object.assign(document, {
      startViewTransition: (callback: () => void) => {
        callback();
        return { ready: Promise.reject(aborted) };
      },
    });
    applyTheme('dark');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(classes).toEqual(new Set(['dark']));
    expect(root.style.colorScheme).toBe('dark');
  });

  it('deduplicates the same theme before its update callback runs', () => {
    const { callbacks, start } = transitions();
    applyTheme('dark');
    applyTheme('dark');
    expect(start).toHaveBeenCalledTimes(1);
    callbacks[0]();
    expect(root.style.colorScheme).toBe('dark');
  });

  it('keeps the latest selection when switching back before painting', () => {
    const { callbacks } = transitions();
    applyTheme('dark');
    applyTheme('light');
    callbacks[1]();
    callbacks[0]();
    expect(classes).toEqual(new Set(['light']));
    expect(root.style.colorScheme).toBe('light');
  });

  it('updates directly without the API or when animations are disabled', () => {
    applyTheme('dark');
    expect(root.style.colorScheme).toBe('dark');
    const { start } = transitions();
    applyTheme('light', false);
    expect(start).not.toHaveBeenCalled();
    expect(root.style.colorScheme).toBe('light');
  });
});
