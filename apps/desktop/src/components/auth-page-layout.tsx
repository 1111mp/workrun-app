import { WorkflowIcon } from 'lucide-react';
import { type ReactNode } from 'react';

function AuthPageLayout({
  children,
  description,
  title,
  wide = false,
}: {
  children: ReactNode;
  description: string;
  title: string;
  wide?: boolean;
}) {
  return (
    <div className='workrun-shell workrun-auth flex h-dvh min-h-0 flex-col overflow-hidden'>
      <header
        data-tauri-drag-region={OS_PLATFORM !== 'win32'}
        className='h-12 shrink-0'
      />
      <main className='flex min-h-0 flex-1 overflow-auto px-5 py-8 sm:px-8'>
        <section
          className='workrun-auth-content m-auto w-full shrink-0'
          data-wide={wide || undefined}
        >
          <div className='mb-7 flex flex-col items-center text-center'>
            <div className='workrun-start-mark mb-4' aria-hidden='true'>
              <WorkflowIcon />
            </div>
            <p className='text-muted-foreground mb-2 text-xs font-medium tracking-[0.14em] uppercase'>
              Workrun
            </p>
            <h1 className='text-3xl font-semibold tracking-tight'>{title}</h1>
            <p className='text-muted-foreground mt-3 max-w-xl text-sm leading-relaxed wrap-anywhere'>
              {description}
            </p>
          </div>
          {wide ? (
            children
          ) : (
            <div className='workrun-auth-panel rounded-2xl border p-5 sm:p-7'>
              {children}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export { AuthPageLayout };
