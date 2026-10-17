import { useSidebar } from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';

export function WorkflowEditorToolbar({
  readOnly,
  children,
}: {
  readOnly: boolean;
  children: ReactNode;
}) {
  const { state, isMobile } = useSidebar();
  // With the palette hidden, the toolbar reaches the window's left edge and
  // must leave room for macOS traffic lights instead of adding a full-width strip.
  const reserveWindowControls =
    OS_PLATFORM === 'darwin' && (readOnly || isMobile || state === 'collapsed');
  return (
    <header
      data-slot='workflow-editor-toolbar'
      data-tauri-drag-region={OS_PLATFORM !== 'win32'}
      className={cn(
        'flex h-14 shrink-0 items-center gap-2 py-2 pr-4',
        reserveWindowControls && 'pl-20',
      )}
    >
      {children}
    </header>
  );
}
