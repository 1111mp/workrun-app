import type { InvokeArgs } from '@tauri-apps/api/core';
import { mockIPC } from '@tauri-apps/api/mocks';
import { vi } from 'vitest';

type CommandHandler = (args: InvokeArgs) => unknown;

export function mockTauriCommands(
  handlers: Record<string, CommandHandler> = {},
) {
  const calls = vi.fn((command: string, args?: InvokeArgs) => {
    // Missing fixtures must fail loudly instead of making an untested path pass.
    if (!Object.hasOwn(handlers, command)) {
      throw new Error(`Unhandled Tauri command: ${command}`);
    }
    return handlers[command](args ?? {});
  });
  mockIPC(calls, { shouldMockEvents: true });
  return calls;
}
