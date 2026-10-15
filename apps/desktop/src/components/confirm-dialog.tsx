import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  Spinner,
  buttonVariants,
  type VariantProps,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import { CircleAlertIcon, InfoIcon } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
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
  onConfirm?: () => void | Promise<void>;
};

type ConfirmContextType = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmContextType | null>(null);

type ConfirmRequest = {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
};

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const activeRequest = useRef<ConfirmRequest | null>(null);
  const queue = useRef<ConfirmRequest[]>([]);
  const running = useRef(false);
  const mounted = useRef(true);
  const { t } = useTranslation();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeRequest.current?.resolve(false);
      queue.current.forEach((queued) => queued.resolve(false));
      activeRequest.current = null;
      queue.current = [];
    };
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    if (!mounted.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const next = { options, resolve };
      // Keep concurrent callers separate so no confirmation promise is lost.
      if (activeRequest.current) {
        queue.current.push(next);
      } else {
        activeRequest.current = next;
        setRequest(next);
      }
    });
  }, []);

  const handleClose = (value: boolean) => {
    const current = activeRequest.current;
    if (!current) return;
    activeRequest.current = queue.current.shift() ?? null;
    running.current = false;
    setPending(false);
    setError(undefined);
    setRequest(activeRequest.current);
    current.resolve(value);
  };

  const handleConfirm = async () => {
    const current = activeRequest.current;
    if (!current || running.current) return;
    running.current = true;
    setPending(true);
    setError(undefined);
    try {
      await current.options.onConfirm?.();
      if (activeRequest.current === current) handleClose(true);
    } catch (failure) {
      // A failed action stays open for retry; it never resolves as confirmed.
      if (activeRequest.current === current) {
        setError(
          failure instanceof Error && failure.message
            ? failure.message
            : t('confirm.actionFailed'),
        );
        running.current = false;
        setPending(false);
      }
    }
  };

  const options = request?.options ?? {};
  const destructive = options.actionVariant === 'destructive';

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <AlertDialog
        open={request !== null}
        onOpenChange={(open) => {
          if (!open && !running.current) handleClose(false);
        }}
      >
        <AlertDialogContent className='max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg! gap-0 overflow-y-auto p-0'>
          <div className='via-background relative overflow-hidden border-b bg-linear-to-br from-violet-500/12 to-sky-500/10 px-5 pt-5 pb-4 sm:px-6 sm:pt-6'>
            <div className='absolute -top-12 -right-10 size-36 rounded-full bg-violet-500/10 blur-2xl' />
            <AlertDialogHeader className='relative grid-cols-[auto_minmax(0,1fr)] grid-rows-1 place-items-start gap-x-3 text-left has-data-[slot=alert-dialog-media]:grid-rows-1'>
              <AlertDialogMedia
                className={cn(
                  'mb-0 size-10 rounded-xl border shadow-sm [&_svg]:size-5',
                  destructive
                    ? 'border-destructive/20 bg-destructive/10 text-destructive'
                    : 'border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300',
                )}
              >
                {options.icon ??
                  (destructive ? <CircleAlertIcon /> : <InfoIcon />)}
              </AlertDialogMedia>
              <div className='flex min-w-0 flex-col gap-1.5'>
                <AlertDialogTitle className='text-lg font-semibold tracking-tight'>
                  {options.title ?? t('confirm.title')}
                </AlertDialogTitle>
                {options.description && (
                  <AlertDialogDescription className='text-sm leading-5'>
                    {options.description}
                  </AlertDialogDescription>
                )}
              </div>
            </AlertDialogHeader>
          </div>
          {(options.content || error) && (
            <div className='flex flex-col gap-4 px-5 py-5 sm:px-6'>
              {options.content}
              {error && (
                <Alert variant='destructive'>
                  <CircleAlertIcon />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
          <AlertDialogFooter className='mx-0 mb-0 px-5 py-4 sm:px-6'>
            <AlertDialogCancel disabled={pending}>
              {options.cancelText ?? t('confirm.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant={options.actionVariant}
              disabled={pending}
              onClick={() => void handleConfirm()}
            >
              {pending && <Spinner data-icon='inline-start' />}
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
