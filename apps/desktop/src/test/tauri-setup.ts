import { clearMocks, mockWindows } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach } from 'vitest';

import { mockTauriCommands } from './tauri';

beforeEach(() => {
  mockWindows('main');
  mockTauriCommands();
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, '__WORKRUN_INITIAL_SETTINGS__');
  Reflect.deleteProperty(window, '__WORKRUN_INITIAL_THEME__');
});
