import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const WorkspaceHeaderHost = createContext<HTMLDivElement | null>(null);

/** Keep page-owned controls and state inside the page while using the shell's single header row. */
export function WorkspaceHeaderContent({ children }: { children: ReactNode }) {
  const host = useContext(WorkspaceHeaderHost);
  return host ? createPortal(children, host) : children;
}
