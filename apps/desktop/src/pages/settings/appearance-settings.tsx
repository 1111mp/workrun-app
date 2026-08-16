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
  FieldLegend,
  FieldSet,
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from '@workspace/ui/components';
import { ChevronRightIcon, MoonStar, Sun, SunMoon } from 'lucide-react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import type { SettingsForm } from './settings-schema';

function AppearanceSettings({ form }: { form: UseFormReturn<SettingsForm> }) {
  const { t } = useTranslation();

  return (
    <FieldSet>
      <FieldLegend className='text-muted-foreground'>
        {t('settings.appearance.title')}
      </FieldLegend>
      <FieldGroup>
        <Controller
          name='theme'
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <DropdownMenu>
                <DropdownMenuTrigger>
                  <Item
                    variant='muted'
                    size='sm'
                    className='hover:bg-muted py-3'
                  >
                    <ItemContent>
                      <ItemTitle>{t('settings.appearance.theme')}</ItemTitle>
                      {fieldState.invalid && (
                        <FieldError errors={[fieldState.error]} />
                      )}
                    </ItemContent>
                    <ItemActions>
                      <span
                        className='text-muted-foreground'
                        aria-invalid={fieldState.invalid}
                      >
                        {t(`settings.appearance.${field.value}`)}
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
                      <DropdownMenuRadioItem value='system'>
                        <SunMoon className='size-5' />
                        {t('settings.appearance.system')}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value='dark'>
                        <MoonStar className='size-5' />
                        {t('settings.appearance.dark')}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value='light'>
                        <Sun className='size-5' />
                        {t('settings.appearance.light')}
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </Field>
          )}
        />
      </FieldGroup>
    </FieldSet>
  );
}

export { AppearanceSettings };
