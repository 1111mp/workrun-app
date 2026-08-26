import { type ReactNode } from 'react';

function AuthPageLayout({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className='flex h-dvh min-h-0 flex-col overflow-hidden'>
      <header
        data-tauri-drag-region={OS_PLATFORM !== 'win32'}
        className='h-12 shrink-0'
      />
      <main className='flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-12'>
        <section className='w-full max-w-xl'>
          <div className='mb-10 text-center'>
            <p className='text-primary mb-3 text-sm font-medium'>Workrun</p>
            <h1 className='text-3xl font-semibold tracking-tight'>{title}</h1>
            <p className='text-muted-foreground mt-3'>{description}</p>
          </div>
          {children}
        </section>
      </main>
    </div>
  );
}

export { AuthPageLayout };
