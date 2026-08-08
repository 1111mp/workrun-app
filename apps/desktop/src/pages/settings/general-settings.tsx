import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
  Separator,
  Switch,
} from '@workspace/ui/components';
import { ChevronRightIcon } from 'lucide-react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import type { SettingsForm } from './settings-schema';

const LOCALES = {
  'zh-CN': '简体中文',
  en: 'English',
};

function GeneralSettings({ form }: { form: UseFormReturn<SettingsForm> }) {
  const { t } = useTranslation();

  return (
    <FieldSet>
      <FieldLegend className='text-muted-foreground pl-3'>
        {t('settings.general.title')}
      </FieldLegend>
      <div className='overflow-hidden rounded-xl'>
        <FieldGroup className='gap-0'>
          <Controller
            name='locale'
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <DropdownMenu>
                  <DropdownMenuTrigger>
                    <Item
                      variant='muted'
                      className='hover:bg-muted rounded-none py-3'
                    >
                      <ItemContent>
                        <ItemTitle>{t('settings.general.language')}</ItemTitle>
                        {fieldState.invalid && (
                          <FieldError errors={[fieldState.error]} />
                        )}
                      </ItemContent>
                      <ItemActions>
                        <span
                          className='text-muted-foreground'
                          aria-invalid={fieldState.invalid}
                        >
                          {LOCALES[field.value]}
                        </span>
                        <ChevronRightIcon className='size-4' />
                      </ItemActions>
                    </Item>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className='w-fit' align='end'>
                    <DropdownMenuGroup>
                      <DropdownMenuRadioGroup
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <DropdownMenuRadioItem value='zh-CN'>
                          简体中文
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value='en'>
                          English
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </Field>
            )}
          />
          <Separator />
          <Controller
            name='auto_check_update'
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel
                  htmlFor='synclan-auto-check-update'
                  className='has-data-checked:bg-transparent dark:has-data-checked:bg-transparent'
                >
                  <Item
                    variant='muted'
                    className='hover:bg-muted rounded-none py-3'
                  >
                    <ItemContent>
                      <ItemTitle>
                        {t('settings.general.autoCheckForUpdates')}
                      </ItemTitle>
                      {fieldState.invalid && (
                        <FieldError errors={[fieldState.error]} />
                      )}
                    </ItemContent>
                    <ItemActions>
                      <Switch
                        id='synclan-auto-check-update'
                        name={field.name}
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        aria-invalid={fieldState.invalid}
                      />
                    </ItemActions>
                  </Item>
                </FieldLabel>
              </Field>
            )}
          />
          <Separator />
          <Controller
            name='enable_auto_launch'
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel
                  htmlFor='synclan-launch-at-login'
                  className='has-data-checked:bg-transparent dark:has-data-checked:bg-transparent'
                >
                  <Item
                    variant='muted'
                    className='hover:bg-muted rounded-none py-3'
                  >
                    <ItemContent>
                      <ItemTitle>
                        {t('settings.general.launchAtLogin')}
                      </ItemTitle>
                      {fieldState.invalid && (
                        <FieldError errors={[fieldState.error]} />
                      )}
                    </ItemContent>
                    <ItemActions>
                      <Switch
                        id='synclan-launch-at-login'
                        name={field.name}
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        aria-invalid={fieldState.invalid}
                      />
                    </ItemActions>
                  </Item>
                </FieldLabel>
              </Field>
            )}
          />
          <Separator />
          <Controller
            name='enable_silent_start'
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel
                  htmlFor='synclan-start-minimized'
                  className='has-data-checked:bg-transparent dark:has-data-checked:bg-transparent'
                >
                  <Item
                    variant='muted'
                    className='hover:bg-muted rounded-none py-3'
                  >
                    <ItemContent>
                      <ItemTitle>
                        {t('settings.general.startMinimized')}
                      </ItemTitle>
                      {fieldState.invalid && (
                        <FieldError errors={[fieldState.error]} />
                      )}
                    </ItemContent>
                    <ItemActions>
                      <Switch
                        id='synclan-start-minimized'
                        name={field.name}
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        aria-invalid={fieldState.invalid}
                      />
                    </ItemActions>
                  </Item>
                </FieldLabel>
              </Field>
            )}
          />
        </FieldGroup>
      </div>
    </FieldSet>
  );
}

export { GeneralSettings };
