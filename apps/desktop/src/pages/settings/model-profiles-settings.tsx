import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from '@workspace/ui/components';
import { ChevronRightIcon } from 'lucide-react';
import { type UseFormReturn, FieldArray } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import type { SettingsForm } from './settings-schema';

const PROVIDER_SETTING_KEY = {
  gemini: 'gemini',
  open_ai: 'openAi',
  open_ai_strict: 'openAi',
  anthropic: 'anthropic',
  deep_seek: 'deepSeek',
  groq: 'groq',
  ollama: 'ollama',
} as const satisfies Record<ModelProvider, string>;

function ModelProfilesSettings({
  form,
}: {
  form: UseFormReturn<SettingsForm>;
}) {
  const { t } = useTranslation();

  return (
    <FieldSet className='gap-1'>
      <FieldLegend className='text-muted-foreground'>
        {t('settings.models.title')}
      </FieldLegend>
      <FieldDescription>{t('settings.models.description')}</FieldDescription>
      <div className='overflow-hidden rounded-xl'>
        <FieldGroup className='gap-0'>
          <FieldArray
            control={form.control}
            name='provider_credentials'
            render={({ fields }) => (
              <>
                {fields.map((field, index) => (
                  <Field key={field.id}>
                    <FieldLabel
                      htmlFor={
                        field.provider === 'ollama'
                          ? `model-base-url-${field.provider}`
                          : `model-api-key-${field.provider}`
                      }
                    >
                      <Item
                        variant='muted'
                        size='sm'
                        className='hover:bg-muted rounded-none py-1.5'
                      >
                        <ItemContent>
                          <ItemTitle>
                            {t(
                              `settings.models.${PROVIDER_SETTING_KEY[field.provider]}`,
                            )}
                          </ItemTitle>
                          {/* <ItemDescription>{description}</ItemDescription> */}
                        </ItemContent>
                        <ItemActions>
                          <div className='flex w-80 flex-col gap-1 sm:flex-row'>
                            {field.provider !== 'ollama' && (
                              <Input
                                id={`model-api-key-${field.provider}`}
                                type='password'
                                autoComplete='off'
                                placeholder={t(
                                  'settings.models.apiKeyPlaceholder',
                                )}
                                className='text-muted-foreground border-none bg-transparent! pr-0 text-right outline-none focus-visible:border-none focus-visible:ring-0 disabled:opacity-100'
                                {...form.register(
                                  `provider_credentials.${index}.apiKey`,
                                )}
                              />
                            )}
                            {field.provider === 'ollama' && (
                              <Input
                                id={`model-base-url-${field.provider}`}
                                type='url'
                                inputMode='url'
                                autoComplete='url'
                                aria-label={t(
                                  'settings.models.baseUrlPlaceholder',
                                )}
                                placeholder={t(
                                  'settings.models.baseUrlPlaceholder',
                                )}
                                className='text-muted-foreground border-none bg-transparent! pr-0 text-right outline-none focus-visible:border-none focus-visible:ring-0 disabled:opacity-100'
                                {...form.register(
                                  `provider_credentials.${index}.baseUrl`,
                                )}
                              />
                            )}
                          </div>
                          <ChevronRightIcon className='size-4' />
                        </ItemActions>
                      </Item>
                    </FieldLabel>
                  </Field>
                ))}
              </>
            )}
          />
        </FieldGroup>
      </div>
    </FieldSet>
  );
}

export { ModelProfilesSettings };
