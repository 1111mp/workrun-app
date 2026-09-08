import { useWorkrunStore } from '@/stores';

export function isPersonalMode() {
  return useWorkrunStore.getState().config?.workspace_mode === 'personal';
}

export function isTeamMode() {
  return useWorkrunStore.getState().config?.workspace_mode === 'team';
}
