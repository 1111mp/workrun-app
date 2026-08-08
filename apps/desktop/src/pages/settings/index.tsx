import { zodResolver } from '@hookform/resolvers/zod';
import { FieldGroup } from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
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
      provider_credentials: config?.provider_credentials ?? [],
    },
  });

  const { watch } = form;

  useEffect(() => {
    const subscription = watch(() => {
      void form.handleSubmit(onSubmit)();
    });

    return () => subscription.unsubscribe();
  }, [watch, form]);

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

  return (
    <div className='h-dvh w-full overflow-y-auto'>
      <header
        data-tauri-drag-region={OS_PLATFORM !== 'win32'}
        className='bg-background/80 sticky top-0 z-20 flex h-14 w-full shrink-0 items-center justify-center gap-2 px-4 backdrop-blur-xl transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12'
      >
        {t('settings.title')}
      </header>
      <div
        className={cn(
          'mx-auto max-w-2xl px-4',
          OS_PLATFORM === 'darwin' && 'min-h-full',
        )}
      >
        <form id='form-synclan-settings'>
          <FieldGroup className='pb-6'>
            <GeneralSettings form={form} />
            <AppearanceSettings form={form} />
            <LoggerSettings form={form} />
            <ModelProfilesSettings form={form} />
            <AboutSettings />
          </FieldGroup>
        </form>
      </div>
    </div>
  );
}

export { SettingsPage as Component };
