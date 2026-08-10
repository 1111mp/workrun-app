import { invoke } from '@tauri-apps/api/core';

export function getUvVersion() {
  return invoke<string>('uv_version');
}
