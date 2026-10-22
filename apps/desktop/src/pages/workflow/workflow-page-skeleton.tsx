import { Skeleton } from '@workspace/ui/components';
import { useTranslation } from 'react-i18next';

export function WorkflowPageSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      role='status'
      aria-label={t('workflowEditor.loading')}
      aria-busy='true'
      className='workrun-shell flex size-full min-h-0 overflow-hidden'
    >
      <div
        aria-hidden='true'
        className='hidden w-64 shrink-0 flex-col gap-6 border-r p-4 md:flex'
      >
        <Skeleton className='h-6 w-28' />
        <Skeleton className='h-8 w-full' />
        <div className='flex flex-col gap-3'>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className='h-10 w-full' />
          ))}
        </div>
      </div>
      <div aria-hidden='true' className='flex min-w-0 flex-1 flex-col'>
        <div className='flex h-14 shrink-0 items-center gap-3 border-b px-4'>
          <Skeleton className='size-7' />
          <Skeleton className='h-7 w-40' />
          <Skeleton className='hidden h-7 w-24 sm:block' />
          <Skeleton className='ml-auto h-8 w-20' />
        </div>
        <div className='flex min-h-0 flex-1 flex-col items-center justify-center p-8'>
          <Skeleton className='h-20 w-48 rounded-xl' />
          <Skeleton className='my-3 h-12 w-px' />
          <Skeleton className='h-28 w-60 max-w-full rounded-xl' />
        </div>
      </div>
    </div>
  );
}
