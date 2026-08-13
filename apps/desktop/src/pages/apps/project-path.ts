import { toast } from 'sonner';

import { openProcessNodeProject } from '@/services/process-node';

export async function openProjectDirectory(id: string) {
  try {
    await openProcessNodeProject(id);
  } catch (error) {
    toast.error('Could not open project directory', {
      toasterId: 'global',
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function copyProjectPath(projectPath: string) {
  try {
    await navigator.clipboard.writeText(projectPath);
    toast.success('Project path copied', { toasterId: 'global' });
  } catch (error) {
    toast.error('Could not copy project path', {
      toasterId: 'global',
      description: error instanceof Error ? error.message : String(error),
    });
  }
}
