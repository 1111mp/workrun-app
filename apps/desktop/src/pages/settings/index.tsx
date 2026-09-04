import { zodResolver } from '@hookform/resolvers/zod';
import { FieldGroup } from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { useEffect, useEffectEvent } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { applyPendingTheme } from '@/lib/utils';
import { useWorkrunStore } from '@/stores';

import { AboutSettings } from './about-settings';
import { AppearanceSettings } from './appearance-settings';
import { GeneralSettings } from './general-settings';
import { LoggerSettings } from './logger-settings';
import { ModelProfilesSettings } from './model-profiles-settings';
import { formSchema, type SettingsForm } from './settings-schema';
import { WorkspaceSettings } from './workspace-settings';

function SettingsPage() {
  const config = useWorkrunStore((s) => s.config);
  const updateConfig = useWorkrunStore((s) => s.updateConfig);

  const { i18n, t } = useTranslation();

  const form = useForm<SettingsForm>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      theme: config?.theme ?? 'system',
      locale: config?.locale ?? 'en',
      // general
      auto_check_update: config?.auto_check_update ?? true,
      enable_auto_launch: config?.enable_auto_launch ?? false,
      enable_silent_start: config?.enable_silent_start ?? false,
      // log
      app_log_level: config?.app_log_level ?? 'info',
      auto_log_clean: `${config?.auto_log_clean ?? 0}`,
      app_log_max_size: config?.app_log_max_size ?? 128,
      app_log_max_count: config?.app_log_max_count ?? 8,
      // model
      provider_credentials: config?.provider_credentials?.length
        ? config.provider_credentials
        : [
            { provider: 'gemini', apiKey: '', baseUrl: '' },
            { provider: 'open_ai', apiKey: '', baseUrl: '' },
            // { provider: 'open_ai_strict', apiKey: '', baseUrl: '' },
            { provider: 'anthropic', apiKey: '', baseUrl: '' },
            { provider: 'deep_seek', apiKey: '', baseUrl: '' },
            { provider: 'groq', apiKey: '', baseUrl: '' },
            { provider: 'ollama', apiKey: '', baseUrl: '' },
          ],
    },
  });

  const onSubmit = useEffectEvent(async (values: SettingsForm) => {
    const settings: IWorkrunConfig = {
      locale: values.locale,
      theme: values.theme,
      // general
      auto_check_update: values.auto_check_update,
      enable_auto_launch: values.enable_auto_launch,
      enable_silent_start: values.enable_silent_start,
      // log
      app_log_level: values.app_log_level,
      auto_log_clean: parseInt(
        values.auto_log_clean,
      ) as IWorkrunConfig['auto_log_clean'],
      app_log_max_size: values.app_log_max_size,
      app_log_max_count: values.app_log_max_count,
      // model
      provider_credentials: values.provider_credentials,
    };

    if (settings.locale && settings.locale !== config?.locale) {
      await i18n.changeLanguage(settings.locale);
    }

    if (settings.theme && settings.theme !== config?.theme) {
      await applyPendingTheme(settings.theme);
    }

    await updateConfig(settings);
  });

  useEffect(() => {
    return form.subscribe({
      formState: {
        values: true,
        isDirty: true,
      },
      callback: () => {
        void form.handleSubmit(onSubmit, (errors) => {
          console.error('Settings form validation failed:', errors);
        })();
      },
    });
  }, [form]);

  return (
    <div className='size-full overflow-y-auto'>
      <main
        className={cn(
          'mx-auto flex max-w-4xl flex-col gap-6 px-6 py-6',
          OS_PLATFORM === 'darwin' && 'min-h-full',
        )}
      >
        <section className='via-background relative overflow-hidden rounded-2xl border bg-linear-to-br from-sky-500/10 to-violet-500/8 p-5 shadow-sm sm:p-6'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.14)_1px,transparent_1px)] bg-size-[16px_16px]' />
          <div className='relative'>
            <div className='text-muted-foreground text-xs font-medium tracking-[0.14em] uppercase'>
              Workrun
            </div>
            <h1 className='mt-1 text-xl font-semibold tracking-tight'>
              {t('settings.title')}
            </h1>
            <p className='text-muted-foreground mt-1 text-sm'>
              {t('settings.description')}
            </p>
          </div>
        </section>
        <form id='form-synclan-settings'>
          <FieldGroup className='gap-5 pb-6 lg:grid lg:grid-cols-2'>
            <SettingsPanel className='lg:col-span-2'>
              <WorkspaceSettings />
            </SettingsPanel>
            <SettingsPanel>
              <GeneralSettings form={form} />
            </SettingsPanel>
            <SettingsPanel>
              <AppearanceSettings form={form} />
            </SettingsPanel>
            <SettingsPanel className='lg:col-span-2'>
              <LoggerSettings form={form} />
            </SettingsPanel>
            <SettingsPanel className='lg:col-span-2'>
              <ModelProfilesSettings form={form} />
            </SettingsPanel>
            <SettingsPanel className='lg:col-span-2'>
              <AboutSettings />
            </SettingsPanel>
          </FieldGroup>
        </form>
      </main>
    </div>
  );
}

function SettingsPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-2xl border bg-card p-4 shadow-sm sm:p-5',
        className,
      )}
    >
      {children}
    </section>
  );
}

export { SettingsPage as Component };
