import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';

export function WorkflowEditorToolbar({
  children,
  notice,
}: {
  readOnly: boolean;
  children: ReactNode;
  notice?: ReactNode;
}) {
  return (
    <>
      <header
        data-slot='workflow-editor-toolbar'
        data-tauri-drag-region={OS_PLATFORM === 'darwin'}
        className={cn('flex h-14 shrink-0 items-center gap-2 py-2 pr-4')}
      >
        {children}
      </header>
      {notice}
    </>
  );
}
