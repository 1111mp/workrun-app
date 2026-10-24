import type { buttonVariants, VariantProps } from '@workspace/ui/components';
import { createContext, useContext, type ReactNode } from 'react';

export type ConfirmOptions = {
  icon?: ReactNode;
  title?: string;
  description?: string;
  content?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  actionVariant?: VariantProps<typeof buttonVariants>['variant'];
  onConfirm?: () => void | Promise<void>;
};

type ConfirmContextType = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

// Keep context identity outside the hot-reloaded dialog component module.
export const ConfirmContext = createContext<ConfirmContextType | null>(null);

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error('useConfirm must be used inside ConfirmProvider');
  }
  return context.confirm;
}
