import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  buttonVariants,
  type VariantProps,
} from '@workspace/ui/components';
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

type ConfirmOptions = {
  icon?: ReactNode;
  title?: string;
  description?: string;
  content?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  actionVariant?: VariantProps<typeof buttonVariants>['variant'];
};

type ConfirmContextType = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmContextType | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({});
  const [resolver, setResolver] = useState<(value: boolean) => void>();

  const { t } = useTranslation();

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setOptions(options);
      setResolver(() => resolve);
      setOpen(true);
    });
  }, []);

  const handleClose = (value: boolean) => {
    setOpen(false);
    resolver?.(value);
    setResolver(undefined);
  };

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}

      <AlertDialog
        open={open}
        onOpenChange={(open) => {
          if (!open) {
            handleClose(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            {options.icon && (
              <AlertDialogMedia className='bg-destructive/10 text-destructive dark:bg-destructive/20 dark:text-destructive'>
                {options.icon}
              </AlertDialogMedia>
            )}
            <AlertDialogTitle>
              {options.title ?? t('confirm.title')}
            </AlertDialogTitle>

            <AlertDialogDescription>
              {options.description}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {options.content}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => handleClose(false)}>
              {options.cancelText ?? t('confirm.cancel')}
            </AlertDialogCancel>

            <AlertDialogAction
              variant={options.actionVariant}
              onClick={() => handleClose(true)}
            >
              {options.confirmText ?? t('confirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const context = useContext(ConfirmContext);

  if (!context) {
    throw new Error('useConfirm must be used inside ConfirmProvider');
  }

  return context.confirm;
}
